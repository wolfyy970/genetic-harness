/**
 * Tests for the LLM server capability probe.
 *
 * The probe drives a runtime branch in the mutation pipeline — getting
 * it wrong means we'd either send schema-mode requests to a server that
 * rejects them (silent failures), or we'd fall back to free-text against
 * a server that perfectly supports schema mode (waste of the strong path).
 *
 * Mocked fetch in every test — these are unit tests, the real-server
 * probe runs by hand via `npx tsx scripts/probe-llm.ts capabilities`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  probeLLMCapabilities,
  getOrProbeCapabilities,
  _resetCapabilityCache,
} from '../src/orchestrator/llm-capabilities.js';
import { loadConfig } from '../src/shared/config.js';

function makeConfig(over = {}) {
  return loadConfig({
    llmBaseUrl: 'http://test-llm:8000/v1',
    llmModel: 'test-model',
    llmApiKey: 'test-key',
    ...over,
  });
}

function mockJson(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function mockHttpError(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

describe('probeLLMCapabilities', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetCapabilityCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reports 'schema' when both json_object and json_schema produce JSON-shaped output", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.response_format?.type === 'json_schema') {
        return mockJson('{"answer": 4}');
      }
      if (body.response_format?.type === 'json_object') {
        return mockJson('{"answer": 4}');
      }
      return mockJson('Two plus two is four.');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const caps = await probeLLMCapabilities(makeConfig());
    expect(caps.structuredOutput).toBe('schema');
    expect(caps.jsonSchemaHonored).toBe(true);
    expect(caps.jsonObjectHonored).toBe(true);
    expect(caps.freeTextWorks).toBe(true);
    // Three probes fan out in parallel.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports 'object' when only json_object is honored", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.response_format?.type === 'json_schema') {
        return mockHttpError(400, 'response_format.json_schema not supported');
      }
      if (body.response_format?.type === 'json_object') {
        return mockJson('{"answer": 4}');
      }
      return mockJson('Plain prose response.');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const caps = await probeLLMCapabilities(makeConfig());
    expect(caps.structuredOutput).toBe('object');
    expect(caps.jsonSchemaHonored).toBe(false);
    expect(caps.jsonObjectHonored).toBe(true);
    expect(caps.errors?.jsonSchema).toContain('not supported');
  });

  it("reports 'schema' when server ACCEPTS the flag even if the model doesn't auto-coerce", async () => {
    // This is the real-world case for mlx-omni-server + Qwen3.6-distill:
    // the server returns HTTP 200 for response_format but the model
    // produces prose unless the prompt also asks for JSON. Acceptance
    // is enough — the pipeline's schema-retry loop handles compliance.
    const fetchMock = vi.fn().mockImplementation(async () =>
      mockJson('Two plus two equals four.'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const caps = await probeLLMCapabilities(makeConfig());
    expect(caps.structuredOutput).toBe('schema');
    // Honoring is recorded separately so diagnostics can show that the
    // pipeline will need to lean on its retry loop more than usual.
    expect(caps.jsonSchemaHonored).toBe(false);
    expect(caps.jsonObjectHonored).toBe(false);
    expect(caps.freeTextWorks).toBe(true);
  });

  it("reports 'none' when the server rejects BOTH structured-output modes with HTTP errors", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.response_format) {
        return mockHttpError(400, 'response_format not supported on this build');
      }
      return mockJson('OK');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const caps = await probeLLMCapabilities(makeConfig());
    expect(caps.structuredOutput).toBe('none');
    expect(caps.freeTextWorks).toBe(true);
  });

  it("reports 'none' and records errors when the server is unreachable", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const caps = await probeLLMCapabilities(makeConfig());
    expect(caps.structuredOutput).toBe('none');
    expect(caps.freeTextWorks).toBe(false);
    expect(caps.errors?.freeText).toBe('fetch failed');
  });

  it('accepts fenced JSON output as JSON-shaped', async () => {
    // Some servers honor `response_format: json_object` but still wrap
    // the result in ```json fences. The probe should unwrap.
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.response_format?.type === 'json_schema') {
        return mockJson('```json\n{"answer": 4}\n```');
      }
      if (body.response_format?.type === 'json_object') {
        return mockJson('```json\n{"answer": 4}\n```');
      }
      return mockJson('hello');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const caps = await probeLLMCapabilities(makeConfig());
    expect(caps.structuredOutput).toBe('schema');
    expect(caps.jsonSchemaHonored).toBe(true);
  });

  it('records baseUrl and model in the report', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => mockJson('{}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cfg = makeConfig({ llmBaseUrl: 'http://abc:1/v1', llmModel: 'my-model' });
    const caps = await probeLLMCapabilities(cfg);
    expect(caps.baseUrl).toBe('http://abc:1/v1');
    expect(caps.model).toBe('my-model');
  });
});

describe('getOrProbeCapabilities cache', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetCapabilityCache();
    vi.restoreAllMocks();
  });

  it('caches the result across calls with the same baseUrl+model', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => mockJson('{"answer":4}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const cfg = makeConfig();
    const a = await getOrProbeCapabilities(cfg);
    const b = await getOrProbeCapabilities(cfg);
    expect(a).toBe(b); // same reference, not just equal
    // 3 calls during the first probe; 0 calls on the cached return.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('re-probes when baseUrl changes', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => mockJson('{"answer":4}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getOrProbeCapabilities(makeConfig({ llmBaseUrl: 'http://a:1/v1' }));
    await getOrProbeCapabilities(makeConfig({ llmBaseUrl: 'http://b:1/v1' }));
    // 6 calls — 3 per probe.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('re-probes when model changes', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => mockJson('{"answer":4}'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await getOrProbeCapabilities(makeConfig({ llmModel: 'model-a' }));
    await getOrProbeCapabilities(makeConfig({ llmModel: 'model-b' }));
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});
