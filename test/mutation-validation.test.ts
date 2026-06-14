/**
 * Tests for the bot-source validator and the threaded self-debug retry loop.
 *
 * The validator (`validateBotSource`) is a cheap static gate that rejects
 * LLM output with hallucinated state-field names, hallucinated action
 * shapes, missing signatures, or compile errors — BEFORE evaluation
 * wastes its time on a guaranteed-broken bot.
 *
 * The threaded loop (`generateMutationWithRetry` in live mode) feeds
 * validation failures back into the SAME chat conversation so the model
 * can repair its own output instead of restarting from scratch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateBotSource,
  generateMutationWithRetry,
} from '../src/orchestrator/mutation.js';
import { _setCapabilityCache, _resetCapabilityCache } from '../src/orchestrator/llm-capabilities.js';
import { loadConfig } from '../src/shared/config.js';
import type { MutationContext } from '../src/shared/types.js';

/**
 * Pre-seed the capability cache so tests can focus on the post-probe
 * pipeline. Pass `'none'` to exercise the legacy free-text path, or
 * `'schema'` to exercise the structured-output path.
 */
function stubCaps(mode: 'schema' | 'object' | 'none' = 'none'): void {
  _setCapabilityCache({
    structuredOutput: mode,
    jsonObjectHonored: mode !== 'none',
    jsonSchemaHonored: mode === 'schema',
    freeTextWorks: true,
    observedAt: new Date().toISOString(),
    baseUrl: 'http://test-llm:0/v1',
    model: 'test-model',
  });
}

function emptyContext(): MutationContext {
  return {
    bestK: [],
    evaluationHistory: '',
    rewardReflection: {
      winRate: 0,
      avgScore: 0,
      avgFuelPerTick: 0,
      avgTicksAlive: 0,
      fuelBreakdownBySource: [],
      topBehavioralAxes: { aggression: 0, economic: 0, defensive: 0 },
    },
    mode: 'pure',
    λ: 0,
  };
}

describe('validateBotSource', () => {
  it('passes a correct bot', () => {
    const src = `function tick(s) {
      var dx = s.opponents[0]?.pos.x - s.ship.pos.x;
      return { type: 'fire' };
    }`;
    const v = validateBotSource(src);
    expect(v.ok).toBe(true);
  });

  it('rejects missing function signature', () => {
    const v = validateBotSource(`const tick = (s) => ({ type: 'wait' });`);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.severity).toBe('parse');
      expect(v.issues[0].code).toBe('no-signature');
    }
  });

  it('catches flat ship-coordinate hallucinations', () => {
    const src = `function tick(s) {
      var x = s.ship.x, y = s.ship.y;
      return { type: 'wait' };
    }`;
    const v = validateBotSource(src);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.severity).toBe('shape');
      const codes = v.issues.map((i) => i.code);
      expect(codes).toContain('flat-ship-x');
      expect(codes).toContain('flat-ship-y');
    }
  });

  it('catches alternate-name field hallucinations', () => {
    const src = `function tick(s) {
      if (s.ship.hp < 30) return { type: 'wait' };
      for (var e of s.enemies) {}
      for (var r of s.rocks) {}
      return { type: 'fire' };
    }`;
    const v = validateBotSource(src);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      const codes = v.issues.map((i) => i.code);
      expect(codes).toEqual(expect.arrayContaining(['wrong-hp', 'fake-enemies', 'fake-rocks']));
    }
  });

  it('catches invalid action shapes', () => {
    const src = `function tick(s) {
      if (s.opponents.length) return { type: 'shoot' };
      return { type: 'thrust', angle: 1.2 };
    }`;
    const v = validateBotSource(src);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      const codes = v.issues.map((i) => i.code);
      expect(codes).toContain('fake-shoot');
      expect(codes).toContain('thrust-angle');
    }
  });

  it('catches compile errors', () => {
    const src = `function tick(s) { return { type: 'wait' }`; // missing closing brace
    const v = validateBotSource(src);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.severity).toBe('compile');
      expect(v.issues[0].code).toBe('compile-error');
    }
  });

  it('collects multiple issues in one pass (not whack-a-mole)', () => {
    const src = `function tick(s) {
      var x = s.ship.x;
      if (s.ship.hp < 10) return { type: 'shoot' };
      return { type: 'wait' };
    }`;
    const v = validateBotSource(src);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---------------------------------------------------------------------------
// Threaded retry loop — intercept fetch with vi.fn() and verify the
// conversation actually threads on validation failure.
// ---------------------------------------------------------------------------

function mockChatResponse(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ) as Response;
}

describe('generateMutationWithRetry threaded conversation (live mode)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Force the legacy free-text path for these tests. The schema path
    // is exercised by its own describe() block below; isolating the two
    // keeps the conversation-threading assertion independent of how the
    // bot was extracted from the response.
    stubCaps('none');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetCapabilityCache();
    vi.restoreAllMocks();
  });

  it('repairs a hallucinated bot via a second turn in the SAME conversation', async () => {
    const broken = `\`\`\`js
function tick(s) {
  var x = s.ship.x;
  return { type: 'shoot' };
}
\`\`\``;
    const fixed = `\`\`\`js
function tick(s) {
  var x = s.ship.pos.x;
  return { type: 'fire' };
}
\`\`\``;

    const fetchMock = vi.fn();
    let capturedMessagesOnSecondCall: Array<{ role: string; content: string }> = [];
    fetchMock.mockImplementationOnce(async () => mockChatResponse(broken));
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: typeof capturedMessagesOnSecondCall };
      capturedMessagesOnSecondCall = body.messages;
      return mockChatResponse(fixed);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = loadConfig({
      llmBaseUrl: 'http://test-llm:0/v1',
      llmModel: 'test-model',
    });

    const result = await generateMutationWithRetry(
      `function tick(s) { return { type: 'wait' }; }`,
      emptyContext(),
      config,
      3,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.isImprovement).toBe(true);
    expect(result.source).toContain('s.ship.pos.x');
    expect(result.source).toContain("type: 'fire'");

    // The hallmark of threading: the second call's `messages` includes
    // the assistant's broken turn AND a follow-up user correction. A
    // fresh stateless call would only have [system, user].
    expect(capturedMessagesOnSecondCall.length).toBeGreaterThanOrEqual(4);
    const roles = capturedMessagesOnSecondCall.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    // The correction message should mention the actual validation issues.
    const correction = capturedMessagesOnSecondCall[3].content;
    expect(correction).toMatch(/s\.ship\.pos\.x|shoot/);
  });

  it('returns original source after max retries on persistent failure', async () => {
    const persistentlyBroken = `\`\`\`js
function tick(s) {
  return { type: 'shoot' };
}
\`\`\``;

    // Use mockImplementation, not mockResolvedValue: Response bodies can
    // only be read once, so each fetch needs a fresh Response instance.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => mockChatResponse(persistentlyBroken));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = loadConfig({
      llmBaseUrl: 'http://test-llm:0/v1',
      llmModel: 'test-model',
    });
    const original = `function tick(s) { return { type: 'wait' }; }`;

    const result = await generateMutationWithRetry(original, emptyContext(), config, 2);

    // 3 attempts total (initial + 2 retries). No network errors → no
    // inner-retry inflation, exactly one call per outer attempt.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.isImprovement).toBe(false);
    expect(result.source).toBe(original);
    expect(result.reason).toMatch(/max retries exhausted|validation/);
  });

  it('accepts identical-source returns as a no-op without retrying', async () => {
    const original = `function tick(s) { return { type: 'wait' }; }`;
    const echo = `\`\`\`js\n${original}\n\`\`\``;

    const fetchMock = vi.fn().mockResolvedValue(mockChatResponse(echo));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = loadConfig({
      llmBaseUrl: 'http://test-llm:0/v1',
      llmModel: 'test-model',
    });

    const result = await generateMutationWithRetry(original, emptyContext(), config, 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isImprovement).toBe(false);
    expect(result.reason).toMatch(/identical/);
  });
});

// ---------------------------------------------------------------------------
// Schema-mode tests: exercise the json_schema response_format path.
// The mocked fetch returns JSON bodies, not fenced code blocks.
// ---------------------------------------------------------------------------

describe('generateMutationWithRetry (structured-output / schema mode)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    stubCaps('schema');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetCapabilityCache();
    vi.restoreAllMocks();
  });

  it('parses a schema-shaped JSON response and returns the bot', async () => {
    const fixed = JSON.stringify({
      source: `function tick(s) { if (s.opponents.length) return { type: 'fire' }; return { type: 'wait' }; }`,
      strategy: 'switched to event-driven fire',
    });
    const fetchMock = vi.fn().mockImplementation(async () => mockChatResponse(fixed));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = loadConfig({ llmBaseUrl: 'http://test-llm:0/v1', llmModel: 'test-model' });
    const original = `function tick(s) { return { type: 'wait' }; }`;
    const result = await generateMutationWithRetry(original, emptyContext(), config, 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isImprovement).toBe(true);
    expect(result.source).toContain("type: 'fire'");
    // Strategy note flows into the reason field.
    expect(result.reason).toMatch(/switched to event-driven fire/);
  });

  it('sends response_format: json_schema in the request body when caps allow', async () => {
    const fixed = JSON.stringify({
      source: `function tick(s) { return { type: 'wait' }; }`,
      strategy: 'noop',
    });
    const fetchMock = vi.fn().mockImplementation(async () => mockChatResponse(fixed));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = loadConfig({ llmBaseUrl: 'http://test-llm:0/v1', llmModel: 'test-model' });
    await generateMutationWithRetry(
      `function tick(s) { return { type: 'fire' }; }`, // different from response so it's not an identical-source short-circuit
      emptyContext(),
      config,
      3,
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format).toBeDefined();
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('BotSubmission');
  });

  it('requests a schema-correct re-emit when the response violates the schema', async () => {
    // First response: missing the `source` field. Second: valid.
    const badJson = JSON.stringify({ strategy: 'forgot the source' });
    const goodJson = JSON.stringify({
      source: `function tick(s) { if (s.opponents.length) return { type: 'fire' }; return { type: 'wait' }; }`,
    });
    const fetchMock = vi.fn();
    let secondCallMessages: Array<{ role: string; content: string }> = [];
    fetchMock.mockImplementationOnce(async () => mockChatResponse(badJson));
    fetchMock.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: typeof secondCallMessages };
      secondCallMessages = body.messages;
      return mockChatResponse(goodJson);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = loadConfig({ llmBaseUrl: 'http://test-llm:0/v1', llmModel: 'test-model' });
    const result = await generateMutationWithRetry(
      `function tick(s) { return { type: 'wait' }; }`,
      emptyContext(),
      config,
      3,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.isImprovement).toBe(true);
    // Threaded retry: the second call's messages must include the bad
    // assistant turn AND a correction request.
    const roles = secondCallMessages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
    expect(secondCallMessages[3].content).toMatch(/schema|source/i);
  });

  it('uses BOT_AUTHOR_MANUAL byte-identically across calls (KV-cache invariant)', async () => {
    const okJson = JSON.stringify({
      source: `function tick(s) { return { type: 'wait' }; }`,
    });
    const fetchMock = vi.fn().mockImplementation(async () => mockChatResponse(okJson));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = loadConfig({ llmBaseUrl: 'http://test-llm:0/v1', llmModel: 'test-model' });
    // Two unrelated mutations in sequence — different exemplars in the
    // mutation context (which IS what the user prompt embeds), same model.
    const ctxA = emptyContext();
    const ctxB = emptyContext();
    const exemplarA = {
      id: 'a',
      shipId: 'a',
      source: `function tick(s) { return { type: 'fire' }; }`,
      fitness: {
        shipId: 'a', winRate: 0.5, avgScore: 100, avgFuelPerTick: 100, avgTicksAlive: 800,
        totalMatches: 4, totalTicksAlive: 3200, cpuTimeTotal: 1000n, memoryUsed: 0, crashes: 0,
        fitnessScore: 0.5, aggression: 0.5, economy: 0.5,
      },
      stage: 2, timestamp: Date.now(),
      metadata: { generation: 0, island: 0, behavioralSignature: [], complexity: 1, noveltyScore: 1 },
    };
    const exemplarB = { ...exemplarA, id: 'b', shipId: 'b', source: `function tick(s) { return { type: 'rotate', direction: 1 }; }` };
    ctxA.bestK = [exemplarA];
    ctxB.bestK = [exemplarB];

    await generateMutationWithRetry(exemplarA.source, ctxA, config, 0);
    await generateMutationWithRetry(exemplarB.source, ctxB, config, 0);

    const sys1 = JSON.parse(fetchMock.mock.calls[0][1].body as string).messages[0].content;
    const sys2 = JSON.parse(fetchMock.mock.calls[1][1].body as string).messages[0].content;
    expect(sys1).toBe(sys2);
    // The user portions, conversely, MUST differ — they carry exemplar-specific info.
    const user1 = JSON.parse(fetchMock.mock.calls[0][1].body as string).messages[1].content;
    const user2 = JSON.parse(fetchMock.mock.calls[1][1].body as string).messages[1].content;
    expect(user1).not.toBe(user2);
  });
});

// ---------------------------------------------------------------------------
// Object-mode path: response_format: json_object, schema in prompt.
// ---------------------------------------------------------------------------

describe('generateMutationWithRetry (json_object capability mode)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    stubCaps('object');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetCapabilityCache();
    vi.restoreAllMocks();
  });

  it('sends response_format: json_object when the server only supports object mode', async () => {
    const ok = JSON.stringify({
      source: `function tick(s) { return { type: 'fire' }; }`,
    });
    const fetchMock = vi.fn().mockImplementation(async () => mockChatResponse(ok));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const config = loadConfig({ llmBaseUrl: 'http://test-llm:0/v1', llmModel: 'test-model' });
    await generateMutationWithRetry(
      `function tick(s) { return { type: 'wait' }; }`,
      emptyContext(),
      config,
      0,
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});
