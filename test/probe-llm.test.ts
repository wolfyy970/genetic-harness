/**
 * Tests for the probe-llm dev harness.
 *
 * We don't hit the real LLM here — that's the point of the harness itself.
 * These tests mock fetch and assert the probe sends the right request
 * shapes for each subcommand and reports the right capability signals.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  callLLM,
  cmdCapabilities,
  cmdMutate,
  cmdDiverse,
  parseArgs,
  optionsFromArgs,
  type ProbeOptions,
  type FixturePayload,
} from '../scripts/probe-llm.js';
import { loadConfig } from '../src/shared/config.js';
import { _setCapabilityCache, _resetCapabilityCache } from '../src/orchestrator/llm-capabilities.js';
import { writeFileSync, mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function baseOpts(over: Partial<ProbeOptions> = {}): ProbeOptions {
  return {
    baseUrl: 'http://test-llm:8000/v1',
    apiKey: 'test-key',
    model: 'test-model',
    quiet: true,
    ...over,
  };
}

function mockResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockChatResponse(content: string): Response {
  return mockResponse(200, { choices: [{ message: { content } }] });
}

describe('parseArgs', () => {
  it('parses command + positional args', () => {
    const r = parseArgs(['node', 'probe-llm', 'mutate', 'foo.js']);
    expect(r.command).toBe('mutate');
    expect(r.positional).toEqual(['foo.js']);
  });

  it('parses --flag value pairs', () => {
    const r = parseArgs(['node', 'probe-llm', 'mutate', 'foo.js', '--temperature', '0.5']);
    expect(r.options.temperature).toBe('0.5');
  });

  it('parses --boolean-flag without a value', () => {
    const r = parseArgs(['node', 'probe-llm', 'capabilities', '--quiet']);
    expect(r.options.quiet).toBe(true);
  });

  it('treats next-flag as terminating a boolean flag', () => {
    const r = parseArgs(['node', 'probe-llm', 'capabilities', '--quiet', '--model', 'x']);
    expect(r.options.quiet).toBe(true);
    expect(r.options.model).toBe('x');
  });
});

describe('optionsFromArgs', () => {
  it('uses config defaults when no overrides', () => {
    const cfg = loadConfig({});
    const opts = optionsFromArgs({ command: 'capabilities', positional: [], options: {} }, cfg);
    expect(opts.baseUrl).toBe(cfg.llmBaseUrl);
    expect(opts.model).toBe(cfg.llmModel);
    expect(opts.apiKey).toBe(cfg.llmApiKey);
  });

  it('honors --base-url, --model, --api-key overrides', () => {
    const cfg = loadConfig({});
    const opts = optionsFromArgs(
      {
        command: 'capabilities',
        positional: [],
        options: { 'base-url': 'http://override:1/v1', model: 'x', 'api-key': 'k' },
      },
      cfg,
    );
    expect(opts.baseUrl).toBe('http://override:1/v1');
    expect(opts.model).toBe('x');
    expect(opts.apiKey).toBe('k');
  });

  it('parses --temperature and --max-tokens as numbers', () => {
    const cfg = loadConfig({});
    const opts = optionsFromArgs(
      { command: 'mutate', positional: [], options: { temperature: '0.3', 'max-tokens': '500' } },
      cfg,
    );
    expect(opts.temperature).toBe(0.3);
    expect(opts.maxTokens).toBe(500);
  });
});

describe('callLLM', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends POST to <baseUrl>/chat/completions with auth header and body', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      mockChatResponse('hello'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callLLM([{ role: 'user', content: 'hi' }], baseOpts());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://test-llm:8000/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('test-model');
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    // No response_format unless explicitly requested.
    expect(body.response_format).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.contentText).toBe('hello');
  });

  it('includes response_format when provided', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => mockChatResponse('{}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callLLM([{ role: 'user', content: 'x' }], baseOpts(), { type: 'json_object' });

    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('reports non-2xx responses with errorText', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      mockResponse(400, 'response_format.json_schema not supported'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await callLLM([{ role: 'user', content: 'x' }], baseOpts());
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.errorText).toContain('json_schema not supported');
  });

  it('reports network errors with status 0', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const r = await callLLM([{ role: 'user', content: 'x' }], baseOpts());
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.errorText).toBe('fetch failed');
  });
});

describe('cmdCapabilities', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('reports support for all three modes when server cooperates', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      // Honor json_object/json_schema as if the server fully supported them.
      if (body.response_format) {
        return mockChatResponse('{"pong":true}');
      }
      return mockChatResponse('Sure, pong is true.');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const report = await cmdCapabilities(baseOpts());
    expect(report.freeText.supported).toBe(true);
    expect(report.jsonObject.supported).toBe(true);
    expect(report.jsonSchema.supported).toBe(true);
    // Three separate calls — capability probe is a fan-out, not a single shot.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports jsonSchema=false when server returns 400 for json_schema', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const fmt = body.response_format;
      if (fmt?.type === 'json_schema') {
        return mockResponse(400, 'response_format.json_schema not supported by this server build');
      }
      if (fmt?.type === 'json_object') {
        return mockChatResponse('{"pong": true}');
      }
      return mockChatResponse('hi');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const report = await cmdCapabilities(baseOpts());
    expect(report.jsonSchema.supported).toBe(false);
    expect(report.jsonSchema.error).toContain('not supported');
    expect(report.jsonObject.supported).toBe(true);
    expect(report.freeText.supported).toBe(true);
  });

  it('reports jsonObject.supported=false when server returns non-JSON content despite the flag', async () => {
    // Some servers accept the flag but ignore it. The probe's heuristic
    // is "content parses as JSON" — gracefully degrades the report.
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const fmt = body.response_format;
      if (fmt?.type === 'json_schema') {
        return mockChatResponse('{"pong": true}');
      }
      if (fmt?.type === 'json_object') {
        return mockChatResponse('Sure thing pal, pong is true.'); // not JSON
      }
      return mockChatResponse('whatever');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const report = await cmdCapabilities(baseOpts());
    expect(report.jsonObject.supported).toBe(false);
    expect(report.jsonSchema.supported).toBe(true);
  });
});

describe('cmdMutate', () => {
  const originalFetch = globalThis.fetch;
  let tmpFile: string;

  beforeEach(() => {
    // Force the legacy free-text path so the probe's own one-fetch
    // semantics hold; the structured-output path is exercised elsewhere.
    _setCapabilityCache({
      structuredOutput: 'none',
      jsonObjectHonored: false,
      jsonSchemaHonored: false,
      freeTextWorks: true,
      observedAt: new Date().toISOString(),
      baseUrl: 'http://test-llm:8000/v1',
      model: 'test-model',
    });
    const dir = mkdtempSync(join(tmpdir(), 'probe-test-'));
    tmpFile = join(dir, 'exemplar.js');
    writeFileSync(tmpFile, `function tick(s) { return { type: 'wait' }; }`);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetCapabilityCache();
    vi.restoreAllMocks();
  });

  it('sends the mutation prompt (system + user) to the LLM', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      mockChatResponse('```js\nfunction tick(s) { return { type: "fire" }; }\n```'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await cmdMutate(baseOpts(), tmpFile);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    // User prompt should contain the exemplar.
    expect(body.messages[1].content).toContain(`function tick(s) { return { type: 'wait' }; }`);
    expect(result.extractedSource).toContain("type: \"fire\"");
    expect(result.validation.ok).toBe(true);
  });

  it('marks validation as failing when the LLM returns a hallucinated bot', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      mockChatResponse('```js\nfunction tick(s) { return { type: "shoot" }; }\n```'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await cmdMutate(baseOpts(), tmpFile);
    expect(result.validation.ok).toBe(false);
  });
});

describe('cmdDiverse', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('counts valid bots in a JSON-array response', async () => {
    const arr = JSON.stringify([
      { id: 'seed-001-a', source: `function tick(s) { return { type: 'wait' }; }` },
      { id: 'seed-002-b', source: `function tick(s) { return { type: 'fire' }; }` },
      // intentionally broken — hallucinated action
      { id: 'seed-003-c', source: `function tick(s) { return { type: 'shoot' }; }` },
    ]);
    const fetchMock = vi.fn().mockImplementation(async () =>
      mockChatResponse(`\`\`\`json\n${arr}\n\`\`\``),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await cmdDiverse(baseOpts(), 3);
    expect(Array.isArray(result.parsedJson)).toBe(true);
    expect((result.parsedJson as unknown[]).length).toBe(3);
    expect(result.validBotCount).toBe(2);
  });

  it('handles unparseable responses without throwing', async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      mockChatResponse('Sorry, I cannot help with that.'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await cmdDiverse(baseOpts(), 8);
    expect(result.parsedJson).toBeNull();
    expect(result.validBotCount).toBe(0);
  });
});

describe('saveFixture round-trip', () => {
  it('writes a JSON file under test/fixtures/llm/', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => mockChatResponse('Done.'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Use a `probe-test-` prefix; the fixture-replay regression test
    // skips these so they don't pollute the regression set.
    const name = `probe-test-${Date.now()}`;
    const opts = baseOpts({ saveFixture: name });
    await cmdCapabilities(opts);

    const expected = join(process.cwd(), 'test', 'fixtures', 'llm', `${name}.json`);
    expect(existsSync(expected)).toBe(true);
    const payload = JSON.parse(readFileSync(expected, 'utf-8')) as FixturePayload;
    expect(payload.command).toBe('capabilities');
    expect(payload.request.messages.length).toBeGreaterThan(0);

    // Cleanup so we don't accumulate probe-test-*.json under test/fixtures.
    rmSync(expected, { force: true });
  });
});
