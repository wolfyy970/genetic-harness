/**
 * LLM server capability probe.
 *
 * Runs once at startup to detect what `response_format` modes the configured
 * LLM endpoint actually supports. The result drives a runtime branch in the
 * mutation pipeline (Slice E):
 *
 *   - `'schema'` — server accepts AND honors `response_format: json_schema`.
 *     This is the strong path: the server guarantees the JSON shape at the
 *     token level. Use it.
 *   - `'object'` — server accepts `response_format: json_object` (returns
 *     parseable JSON) but does NOT accept or honor `json_schema`. Fall back
 *     to in-prompt schema embedding.
 *   - `'none'` — server doesn't honor either. Fall back to the existing
 *     free-text path with extractTickFunctions + threaded retry.
 *
 * Probe design — three small POSTs, each carrying a prompt that does NOT
 * itself request JSON output. This is the key to a real probe: if the
 * server is just IGNORING our `response_format` flag and the model happens
 * to comply because the user prompt said "reply with JSON," we'd
 * incorrectly conclude support. Instead, we ask the model for an answer
 * in plain English and ALSO set `response_format`. If the response comes
 * back as parseable JSON, the flag was honored. If it comes back as prose,
 * the flag was ignored.
 *
 * Observed against mlx-omni-server + Qwen3.6-35B-A3B-8bit at the user's
 * 192.168.252.213:8000 endpoint (2026-05-11):
 *   - jsonObject:  honored
 *   - jsonSchema:  honored
 *   - freeText:    honored
 * So `structuredOutput === 'schema'` for our reference deployment. Other
 * servers (older mlx-omni-server, vanilla llama.cpp) may degrade.
 */

import { logger } from '../shared/logger.js';
import type { HarnessConfig } from '../shared/types.js';

export type StructuredOutputMode = 'schema' | 'object' | 'none';

export interface LLMCapabilities {
  /** Strongest structured-output mode the server actually honors. */
  structuredOutput: StructuredOutputMode;
  /** Did `response_format: json_object` produce parseable JSON? */
  jsonObjectHonored: boolean;
  /** Did `response_format: json_schema` produce parseable JSON? */
  jsonSchemaHonored: boolean;
  /** Did plain `chat/completions` work at all? */
  freeTextWorks: boolean;
  /** When the probe ran. */
  observedAt: string;
  /** Endpoint that was probed. */
  baseUrl: string;
  /** Model that was probed. */
  model: string;
  /** Optional first-error details, useful for diagnostics. */
  errors?: {
    freeText?: string;
    jsonObject?: string;
    jsonSchema?: string;
  };
}

const PROBE_TIMEOUT_MS = 15_000;

// Question the model in plain English — DO NOT ask it for JSON in the
// prompt. The point of the probe is to discover whether `response_format`
// alone coerces the output, not whether the prompt does.
const PROBE_PROMPT_MESSAGES = [
  {
    role: 'system' as const,
    content: 'You are a helpful assistant. Answer concisely.',
  },
  {
    role: 'user' as const,
    content: 'What is two plus two? Reply in one sentence.',
  },
];

const TINY_SCHEMA = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'answer',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: {
        answer: { type: 'integer' },
      },
    },
  },
};

interface SinglyProbeResult {
  ok: boolean;
  content: string;
  isJson: boolean;
  error?: string;
}

async function probeOnce(
  config: HarnessConfig,
  responseFormat?: unknown,
): Promise<SinglyProbeResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      model: config.llmModel,
      messages: PROBE_PROMPT_MESSAGES,
      temperature: 0.1,
      max_tokens: 64,
    };
    if (responseFormat !== undefined) body.response_format = responseFormat;
    const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => '<unreadable>');
      return {
        ok: false,
        content: '',
        isJson: false,
        error: `HTTP ${response.status}: ${errText.slice(0, 200)}`,
      };
    }
    const parsed = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = parsed.choices?.[0]?.message?.content ?? '';
    return { ok: true, content, isJson: looksLikeJson(content) };
  } catch (err) {
    return {
      ok: false,
      content: '',
      isJson: false,
      error: (err as Error).message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // The probe asks an English question. JSON-ish output means the
  // response_format flag actually coerced the model — exactly what we
  // want to detect. Fenced JSON (```json ... ```) counts too because
  // some servers honor the flag but wrap the result in fences.
  const candidate = trimmed.replace(/^```(?:json)?\s*|\s*```$/g, '');
  if (!(candidate.startsWith('{') || candidate.startsWith('['))) return false;
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the structured-output capabilities of the configured LLM server.
 *
 * Sends three small requests in parallel — free-text, json_object,
 * json_schema. Capability classification is two-stage:
 *
 *   1. ACCEPTANCE — does the server accept the `response_format` field
 *      without a 4xx error? If yes, we can use that mode.
 *   2. HONORING — does the model also coerce the output to JSON without
 *      explicit prompt-level instructions? We separate this from
 *      acceptance because some servers (mlx-omni-server with Qwen3.6
 *      distill) accept the flag but the underlying model only complies
 *      when the prompt also asks for JSON. That's fine — the mutation
 *      pipeline already includes schema-correction retry, so weak
 *      coercion just means a few extra retry rounds at startup.
 *
 * `structuredOutput` reflects ACCEPTANCE, not honoring. Honoring is
 * recorded in the separate fields so diagnostics can show both.
 */
export async function probeLLMCapabilities(
  config: HarnessConfig,
): Promise<LLMCapabilities> {
  const observedAt = new Date().toISOString();

  // Run all three probes concurrently — total wall time bounded by the
  // slowest, not the sum. Saves ~30 seconds at startup on slow servers.
  const [freeText, jsonObject, jsonSchema] = await Promise.all([
    probeOnce(config),
    probeOnce(config, { type: 'json_object' }),
    probeOnce(config, TINY_SCHEMA),
  ]);

  const freeTextWorks = freeText.ok;
  // `accepted` = server returned 200 OK. `Honored` = model also coerced
  // to JSON without prompt-level instructions to do so.
  const jsonObjectAccepted = jsonObject.ok;
  const jsonSchemaAccepted = jsonSchema.ok;
  const jsonObjectHonored = jsonObject.ok && jsonObject.isJson;
  const jsonSchemaHonored = jsonSchema.ok && jsonSchema.isJson;

  let structuredOutput: StructuredOutputMode = 'none';
  if (jsonSchemaAccepted) structuredOutput = 'schema';
  else if (jsonObjectAccepted) structuredOutput = 'object';
  else structuredOutput = 'none';

  const errors: LLMCapabilities['errors'] = {};
  if (freeText.error) errors.freeText = freeText.error;
  if (jsonObject.error) errors.jsonObject = jsonObject.error;
  if (jsonSchema.error) errors.jsonSchema = jsonSchema.error;

  const result: LLMCapabilities = {
    structuredOutput,
    jsonObjectHonored,
    jsonSchemaHonored,
    freeTextWorks,
    observedAt,
    baseUrl: config.llmBaseUrl,
    model: config.llmModel,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  };

  logger.info(
    {
      structuredOutput,
      jsonObjectHonored,
      jsonSchemaHonored,
      freeTextWorks,
      baseUrl: config.llmBaseUrl,
      model: config.llmModel,
    },
    'LLM capability probe complete',
  );

  return result;
}

/** Cached singleton capability report for the current run, if any. */
let cachedCapabilities: LLMCapabilities | null = null;

/**
 * Cache-front for `probeLLMCapabilities`. Use this in the run orchestrator
 * so that subprocesses or repeat calls reuse the original probe instead
 * of re-running it every time. Cache is keyed by baseUrl+model — switching
 * either invalidates.
 */
export async function getOrProbeCapabilities(
  config: HarnessConfig,
): Promise<LLMCapabilities> {
  if (
    cachedCapabilities &&
    cachedCapabilities.baseUrl === config.llmBaseUrl &&
    cachedCapabilities.model === config.llmModel
  ) {
    return cachedCapabilities;
  }
  cachedCapabilities = await probeLLMCapabilities(config);
  return cachedCapabilities;
}

/** Test-only: reset the cached capabilities. */
export function _resetCapabilityCache(): void {
  cachedCapabilities = null;
}

/**
 * Test-only: pre-seed the capability cache so `getOrProbeCapabilities`
 * returns these caps without making any network calls. Use this in tests
 * that want to focus on the post-probe pipeline (mutation retry, etc.)
 * without mocking three additional cap-probe fetches.
 */
export function _setCapabilityCache(caps: LLMCapabilities): void {
  cachedCapabilities = caps;
}
