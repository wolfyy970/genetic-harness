#!/usr/bin/env tsx
/**
 * probe-llm — dev harness for iterating on prompts against the real LLM.
 *
 * Slice A of the schema-driven-LLM plan. NOT run in CI. Run by hand from
 * the terminal during prompt-engineering work. Captures responses as
 * fixtures the vitest suite can replay (see test/fixtures/llm/).
 *
 * Usage:
 *   npx tsx scripts/probe-llm.ts <command> [args...] [flags]
 *
 * Commands:
 *   capabilities         Detect what `response_format` modes the server
 *                        accepts. Prints a JSON capability report.
 *   mutate <file.js>     Run one mutation against the contents of file.js
 *                        as the parent exemplar. Prints request, response,
 *                        validator result, and extracted source.
 *   diverse [count=8]    Run a diverse-seed batch. Defaults to 8 (cheap).
 *   replay <fixture>     Re-run a captured fixture's request and diff.
 *
 * Common flags (all commands):
 *   --base-url <url>     Override HARNESS_LLM_BASE_URL.
 *   --model <name>       Override HARNESS_LLM_MODEL.
 *   --api-key <key>      Override HARNESS_LLM_API_KEY.
 *   --temperature <n>    Sampling temperature (default 0.7 mutate, 0.9 diverse).
 *   --max-tokens <n>     Output token cap (default per-command).
 *   --save-fixture <name> Write the {request,response,metadata} to
 *                        test/fixtures/llm/<name>.json for replay.
 *   --quiet              Suppress request/response echo; print summary only.
 *
 * The probe is intentionally a thin shell over fetch — it duplicates a
 * little code with src/orchestrator/mutation.ts on purpose, so changes to
 * the protocol can be experimented with here without touching the
 * production pipeline.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/shared/config.js';
import {
  validateBotSource,
  buildMutationPrompt,
  extractTickFunctions,
} from '../src/orchestrator/mutation.js';
import { getOrProbeCapabilities } from '../src/orchestrator/llm-capabilities.js';
import {
  BotSubmissionSchema,
  BotSubmissionResponseFormat,
  parseSchemaResponse,
} from '../src/orchestrator/prompts/schemas.js';
import { BOT_AUTHOR_MANUAL } from '../src/orchestrator/prompts/bot-author-manual.js';
import type { HarnessConfig, MutationContext } from '../src/shared/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProbeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  saveFixture?: string;
  quiet?: boolean;
  timeoutMs?: number;
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export interface LLMCallResult {
  status: number;
  ok: boolean;
  contentText: string;
  rawBody: string;
  elapsedMs: number;
  errorText?: string;
}

export interface FixturePayload {
  command: string;
  timestamp: string;
  server: { baseUrl: string; model: string };
  request: {
    messages: ChatMessage[];
    temperature: number;
    max_tokens: number;
    response_format?: unknown;
  };
  response: {
    status: number;
    ok: boolean;
    contentText: string;
    rawBody: string;
    elapsedMs: number;
  };
  validation?: ReturnType<typeof validateBotSource>;
  extractedSource?: string;
}

// ---------------------------------------------------------------------------
// Core LLM call — thin fetch wrapper, exposes ALL knobs probe-llm cares about
// ---------------------------------------------------------------------------

export async function callLLM(
  messages: ChatMessage[],
  opts: ProbeOptions,
  responseFormat?: unknown,
): Promise<LLMCallResult> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2000,
  };
  if (responseFormat !== undefined) body.response_format = responseFormat;

  try {
    const response = await fetch(`${opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsedMs = Date.now() - started;
    const rawBody = await response.text();

    if (!response.ok) {
      return {
        status: response.status,
        ok: false,
        contentText: '',
        rawBody,
        elapsedMs,
        errorText: rawBody.slice(0, 500),
      };
    }

    let contentText = '';
    try {
      const parsed = JSON.parse(rawBody) as {
        choices: Array<{ message: { content: string } }>;
      };
      contentText = parsed.choices?.[0]?.message?.content ?? '';
    } catch (err) {
      return {
        status: response.status,
        ok: false,
        contentText: '',
        rawBody,
        elapsedMs,
        errorText: `Response body was not parseable JSON: ${(err as Error).message}`,
      };
    }

    return {
      status: response.status,
      ok: true,
      contentText,
      rawBody,
      elapsedMs,
    };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      contentText: '',
      rawBody: '',
      elapsedMs: Date.now() - started,
      errorText: (err as Error).message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Fixture I/O
// ---------------------------------------------------------------------------

function fixturesDir(): string {
  // scripts/probe-llm.ts lives at <root>/scripts/. fixtures at <root>/test/fixtures/llm.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'test', 'fixtures', 'llm');
}

export function saveFixture(name: string, payload: FixturePayload): string {
  const dir = fixturesDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const safe = name.endsWith('.json') ? name : `${name}.json`;
  const path = join(dir, safe);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

export function loadFixture(nameOrPath: string): FixturePayload {
  const candidates = [
    nameOrPath,
    join(fixturesDir(), nameOrPath),
    join(fixturesDir(), nameOrPath.endsWith('.json') ? nameOrPath : `${nameOrPath}.json`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      return JSON.parse(readFileSync(c, 'utf-8')) as FixturePayload;
    }
  }
  throw new Error(`fixture not found: tried ${candidates.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Command: capabilities
// ---------------------------------------------------------------------------

export interface CapabilityReport {
  baseUrl: string;
  model: string;
  jsonObject: { supported: boolean; latencyMs: number; error?: string };
  jsonSchema: { supported: boolean; latencyMs: number; error?: string };
  freeText: { supported: boolean; latencyMs: number; error?: string };
  observedAt: string;
}

const TINY_SCHEMA_PROBE = {
  type: 'json_schema',
  json_schema: {
    name: 'ping',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['pong'],
      properties: {
        pong: { type: 'boolean' },
      },
    },
  },
};

const TINY_PROBE_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a JSON echo service.' },
  { role: 'user', content: 'Reply with exactly {"pong": true}. No prose.' },
];

export async function cmdCapabilities(opts: ProbeOptions): Promise<CapabilityReport> {
  // We poke the same trivial schema three ways. Server is well-behaved if:
  //  - free-text: returns text (status 200)
  //  - json_object: returns parseable JSON (status 200; content is JSON-y)
  //  - json_schema: returns content matching the schema (status 200)
  // If a mode isn't supported, servers typically return 400 with an error
  // describing the unrecognised `response_format` field.

  const free = await callLLM(TINY_PROBE_MESSAGES, opts);
  const obj = await callLLM(TINY_PROBE_MESSAGES, opts, { type: 'json_object' });
  const schema = await callLLM(TINY_PROBE_MESSAGES, opts, TINY_SCHEMA_PROBE);

  const report: CapabilityReport = {
    baseUrl: opts.baseUrl,
    model: opts.model,
    jsonObject: {
      supported: obj.ok && containsJSON(obj.contentText),
      latencyMs: obj.elapsedMs,
      error: obj.ok ? undefined : obj.errorText,
    },
    jsonSchema: {
      supported: schema.ok && containsJSON(schema.contentText),
      latencyMs: schema.elapsedMs,
      error: schema.ok ? undefined : schema.errorText,
    },
    freeText: {
      supported: free.ok,
      latencyMs: free.elapsedMs,
      error: free.ok ? undefined : free.errorText,
    },
    observedAt: new Date().toISOString(),
  };

  if (!opts.quiet) {
    console.log(JSON.stringify(report, null, 2));
  }
  if (opts.saveFixture) {
    saveFixture(opts.saveFixture, {
      command: 'capabilities',
      timestamp: report.observedAt,
      server: { baseUrl: opts.baseUrl, model: opts.model },
      request: { messages: TINY_PROBE_MESSAGES, temperature: opts.temperature ?? 0.7, max_tokens: opts.maxTokens ?? 2000 },
      response: {
        status: schema.status,
        ok: schema.ok,
        contentText: schema.contentText,
        rawBody: schema.rawBody,
        elapsedMs: schema.elapsedMs,
      },
    });
  }
  return report;
}

function containsJSON(text: string): boolean {
  // Cheap heuristic — server-side json_object/json_schema modes return
  // strict JSON. Fenced or prose-y output fails this check.
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Command: mutate
// ---------------------------------------------------------------------------

export interface MutateProbeResult {
  validation: ReturnType<typeof validateBotSource>;
  extractedSource: string | null;
  llm: LLMCallResult;
}

/**
 * Run one mutation against the contents of an exemplar file. Uses the
 * CURRENT production prompt (`buildMutationPrompt`) so that probe-llm
 * automatically reflects whatever the pipeline does today. Later slices
 * (manual + schema) will replace what `buildMutationPrompt` returns; the
 * probe doesn't need to change.
 */
export async function cmdMutate(
  opts: ProbeOptions,
  exemplarPath: string,
): Promise<MutateProbeResult> {
  const source = readFileSync(exemplarPath, 'utf-8');

  const context: MutationContext = {
    bestK: [
      {
        id: 'probe-parent',
        shipId: 'probe-parent',
        source,
        fitness: {
          shipId: 'probe-parent',
          winRate: 0.5,
          avgScore: 1000,
          avgFuelPerTick: 50000,
          avgTicksAlive: 800,
          totalMatches: 4,
          totalTicksAlive: 3200,
          cpuTimeTotal: 1000000n,
          memoryUsed: 0,
          crashes: 0,
          fitnessScore: 0.6,
          aggression: 0.4,
          economy: 0.5,
        },
        stage: 2,
        timestamp: Date.now(),
        metadata: { generation: 0, island: 0, behavioralSignature: [], complexity: 1, noveltyScore: 1 },
      },
    ],
    evaluationHistory: '',
    rewardReflection: {
      winRate: 0.5,
      avgScore: 1000,
      avgFuelPerTick: 50000,
      avgTicksAlive: 800,
      fuelBreakdownBySource: [],
      topBehavioralAxes: { aggression: 0.4, economic: 0.5, defensive: 0.5 },
    },
    mode: 'pure',
    λ: 0,
  };

  const prompts = buildMutationPrompt(context);
  const messages: ChatMessage[] = [
    { role: 'system', content: prompts.system },
    { role: 'user', content: prompts.user },
  ];

  // Detect capabilities so the probe exercises the same `response_format`
  // path the production pipeline does. Skips network on cache hit.
  const baseConfig: HarnessConfig = {
    ...loadConfig({}),
    llmBaseUrl: opts.baseUrl,
    llmApiKey: opts.apiKey,
    llmModel: opts.model,
  };
  const caps = await getOrProbeCapabilities(baseConfig);
  const responseFormat = caps.structuredOutput === 'schema'
    ? BotSubmissionResponseFormat
    : caps.structuredOutput === 'object'
      ? { type: 'json_object' as const }
      : undefined;

  const llm = await callLLM(messages, {
    ...opts,
    temperature: opts.temperature ?? 0.7,
    maxTokens: opts.maxTokens ?? 2000,
  }, responseFormat);

  // Extract source: prefer schema-mode JSON parse, fall back to regex.
  let extractedSource: string | null = null;
  let strategyNote: string | undefined = undefined;
  if (caps.structuredOutput !== 'none') {
    const parsed = parseSchemaResponse(BotSubmissionSchema, llm.contentText);
    if (parsed.ok && parsed.data) {
      extractedSource = parsed.data.source;
      strategyNote = parsed.data.strategy;
    }
  }
  if (extractedSource === null) {
    const fns = extractTickFunctions(llm.contentText);
    extractedSource = fns[0] ?? null;
  }

  const validation = extractedSource
    ? validateBotSource(extractedSource)
    : { ok: false as const, severity: 'parse' as const, issues: [{ code: 'no-extract', message: 'No function block extracted from LLM response.' }] };

  if (!opts.quiet) {
    console.log('=== Request ===');
    console.log(`messages: ${messages.length}, system bytes: ${messages[0].content.length}, user bytes: ${messages[1].content.length}`);
    console.log(`temperature: ${opts.temperature ?? 0.7}, max_tokens: ${opts.maxTokens ?? 2000}`);
    console.log('\n=== Response ===');
    console.log(`status=${llm.status} ok=${llm.ok} elapsedMs=${llm.elapsedMs} contentBytes=${llm.contentText.length}`);
    if (llm.errorText) console.log(`ERROR: ${llm.errorText}`);
    console.log('\n--- content (truncated to 1500 chars) ---');
    console.log(llm.contentText.slice(0, 1500));
    if (llm.contentText.length > 1500) console.log(`... [${llm.contentText.length - 1500} more bytes]`);
    console.log(`\n=== Mode used: ${caps.structuredOutput} ===`);
    if (strategyNote) console.log(`Strategy note: ${strategyNote}`);
    console.log('\n=== Extracted source ===');
    console.log(extractedSource ?? '(none)');
    console.log('\n=== Validation ===');
    console.log(JSON.stringify(validation, null, 2));
  }

  if (opts.saveFixture) {
    const path = saveFixture(opts.saveFixture, {
      command: 'mutate',
      timestamp: new Date().toISOString(),
      server: { baseUrl: opts.baseUrl, model: opts.model },
      request: {
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens ?? 2000,
        ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
      },
      response: {
        status: llm.status,
        ok: llm.ok,
        contentText: llm.contentText,
        rawBody: llm.rawBody,
        elapsedMs: llm.elapsedMs,
      },
      validation,
      extractedSource: extractedSource ?? undefined,
    });
    if (!opts.quiet) console.log(`\nFixture saved: ${path}`);
  }

  return { validation, extractedSource, llm };
}

// ---------------------------------------------------------------------------
// Command: diverse
// ---------------------------------------------------------------------------

export interface DiverseProbeResult {
  llm: LLMCallResult;
  parsedJson: unknown;
  validBotCount: number;
}

/**
 * Run a diverse-seed batch with a minimal stub prompt (the production
 * `generateDiverseSeeds` is currently coupled to its own internal
 * messages and retry loop, so the probe sends a stripped-down version
 * just to verify the LLM cooperates).
 *
 * Replaced in Slice D/E with the canonical manual + schema path.
 */
export async function cmdDiverse(
  opts: ProbeOptions,
  count: number = 8,
): Promise<DiverseProbeResult> {
  const system = 'You are an expert JavaScript programmer. Produce competitive game-AI bots for an 8-player FFA Asteroids arena. Each bot is a complete `function tick(s) { ... }` body. Bot state `s` has fields `s.ship.pos.{x,y}`, `s.ship.vel.{x,y}`, `s.ship.angle`, `s.ship.health`, `s.opponents[]`, `s.asteroids[]`, `s.bullets[]`. Actions: `{type:"thrust", direction: 1|-1}`, `{type:"rotate", direction: 1|-1}`, `{type:"fire"}`, `{type:"wait"}`.';
  const user = `Produce ${count} diverse bot strategies as a JSON array. Each entry is { "id": "seed-NNN-name", "source": "function tick(s) { ... }" }. Strategies should be visibly different from each other.`;
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  const llm = await callLLM(messages, {
    ...opts,
    temperature: opts.temperature ?? 0.9,
    maxTokens: opts.maxTokens ?? 8000,
  });

  let parsedJson: unknown = null;
  let validBotCount = 0;
  if (llm.ok && llm.contentText) {
    const candidate = tryExtractJsonArray(llm.contentText);
    parsedJson = candidate;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (typeof item !== 'object' || item === null) continue;
        const obj = item as { source?: unknown };
        if (typeof obj.source !== 'string') continue;
        const v = validateBotSource(obj.source);
        if (v.ok) validBotCount++;
      }
    }
  }

  if (!opts.quiet) {
    console.log(`=== Diverse seed probe (count=${count}) ===`);
    console.log(`status=${llm.status} ok=${llm.ok} elapsedMs=${llm.elapsedMs} contentBytes=${llm.contentText.length}`);
    if (llm.errorText) console.log(`ERROR: ${llm.errorText}`);
    console.log(`parsedJsonArray: ${Array.isArray(parsedJson) ? `${(parsedJson as unknown[]).length} entries` : 'no'}`);
    console.log(`validBotCount: ${validBotCount} / ${count}`);
    if (Array.isArray(parsedJson) && parsedJson.length > 0) {
      console.log('\n--- first entry preview ---');
      const first = parsedJson[0] as { id?: unknown; source?: unknown };
      console.log(`id: ${String(first.id ?? '(no id)')}`);
      const src = typeof first.source === 'string' ? first.source : '';
      console.log(`source: ${src.slice(0, 400)}${src.length > 400 ? '...' : ''}`);
    }
  }

  if (opts.saveFixture) {
    saveFixture(opts.saveFixture, {
      command: 'diverse',
      timestamp: new Date().toISOString(),
      server: { baseUrl: opts.baseUrl, model: opts.model },
      request: {
        messages,
        temperature: opts.temperature ?? 0.9,
        max_tokens: opts.maxTokens ?? 8000,
      },
      response: {
        status: llm.status,
        ok: llm.ok,
        contentText: llm.contentText,
        rawBody: llm.rawBody,
        elapsedMs: llm.elapsedMs,
      },
    });
  }

  return { llm, parsedJson, validBotCount };
}

function tryExtractJsonArray(text: string): unknown[] | null {
  // Try fenced ```json ... ``` blocks first; else bare [...].
  const fence = /```(?:json)?\s*([\s\S]*?)```/m.exec(text);
  const candidates = fence ? [fence[1], text] : [text];
  for (const c of candidates) {
    const start = c.indexOf('[');
    const end = c.lastIndexOf(']');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(c.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Command: replay
// ---------------------------------------------------------------------------

export async function cmdReplay(
  opts: ProbeOptions,
  fixturePathOrName: string,
): Promise<{ validation: ReturnType<typeof validateBotSource> | null; llm: LLMCallResult }> {
  const fixture = loadFixture(fixturePathOrName);

  if (!opts.quiet) {
    console.log(`=== Replaying fixture: ${fixturePathOrName} ===`);
    console.log(`command: ${fixture.command}`);
    console.log(`captured at: ${fixture.timestamp}`);
    console.log(`server: ${fixture.server.baseUrl} model=${fixture.server.model}`);
    console.log(`request: ${fixture.request.messages.length} messages, temp=${fixture.request.temperature}`);
    console.log('\nRe-sending against the current server...');
  }

  const llm = await callLLM(
    fixture.request.messages as ChatMessage[],
    {
      ...opts,
      temperature: fixture.request.temperature,
      maxTokens: fixture.request.max_tokens,
    },
    fixture.request.response_format,
  );

  // Quick diff: same content?
  const sameContent = llm.contentText === fixture.response.contentText;

  let validation: ReturnType<typeof validateBotSource> | null = null;
  if (fixture.command === 'mutate' && llm.ok) {
    const m = /function\s+tick\s*\(\s*s\s*\)\s*\{[\s\S]*\}/.exec(llm.contentText);
    if (m) validation = validateBotSource(m[0]);
  }

  if (!opts.quiet) {
    console.log(`\nstatus=${llm.status} ok=${llm.ok} elapsedMs=${llm.elapsedMs}`);
    console.log(`content same as fixture: ${sameContent}`);
    if (!sameContent) {
      console.log(`fixture content: ${fixture.response.contentText.length} bytes`);
      console.log(`current content: ${llm.contentText.length} bytes`);
    }
    if (validation) console.log(`\nValidation: ${validation.ok ? 'OK' : `FAIL [${validation.severity}]`}`);
  }

  return { validation, llm };
}

// ---------------------------------------------------------------------------
// CLI plumbing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: string;
  positional: string[];
  options: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const out: ParsedArgs = { command: '', positional: [], options: {} };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      // Boolean flag if next arg is missing or also a flag
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.options[key] = true;
        i += 1;
      } else {
        out.options[key] = next;
        i += 2;
      }
    } else if (!out.command) {
      out.command = a;
      i += 1;
    } else {
      out.positional.push(a);
      i += 1;
    }
  }
  return out;
}

export function optionsFromArgs(parsed: ParsedArgs, base: HarnessConfig): ProbeOptions {
  const opt = parsed.options;
  return {
    baseUrl: (opt['base-url'] as string) ?? base.llmBaseUrl,
    apiKey: (opt['api-key'] as string) ?? base.llmApiKey,
    model: (opt['model'] as string) ?? base.llmModel,
    temperature: opt['temperature'] !== undefined ? Number(opt['temperature']) : undefined,
    maxTokens: opt['max-tokens'] !== undefined ? Number(opt['max-tokens']) : undefined,
    saveFixture: typeof opt['save-fixture'] === 'string' ? (opt['save-fixture'] as string) : undefined,
    quiet: opt['quiet'] === true,
  };
}

function printUsage(): void {
  console.log(`Usage: npx tsx scripts/probe-llm.ts <command> [args...] [flags]

Commands:
  capabilities         Detect what response_format modes the server accepts.
  mutate <file.js>     Run one mutation; print prompt, response, validator result.
  diverse [count=8]    Run a diverse-seed batch.
  replay <fixture>     Re-run a captured fixture and diff against original.

Flags:
  --base-url <url>     Override HARNESS_LLM_BASE_URL.
  --model <name>       Override HARNESS_LLM_MODEL.
  --api-key <key>      Override HARNESS_LLM_API_KEY.
  --temperature <n>    Sampling temperature.
  --max-tokens <n>     Output token cap.
  --save-fixture <n>   Save the capture as test/fixtures/llm/<n>.json.
  --quiet              Suppress request/response echo.

Env: HARNESS_LLM_BASE_URL, HARNESS_LLM_MODEL, HARNESS_LLM_API_KEY are honored.`);
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === 'help' || parsed.command === '--help') {
    printUsage();
    return parsed.command ? 0 : 1;
  }

  const config = loadConfig({});
  const opts = optionsFromArgs(parsed, config);

  try {
    switch (parsed.command) {
      case 'capabilities':
        await cmdCapabilities(opts);
        return 0;
      case 'mutate': {
        const file = parsed.positional[0];
        if (!file) {
          console.error('mutate: missing <file.js> argument');
          return 1;
        }
        const r = await cmdMutate(opts, file);
        return r.validation.ok ? 0 : 2;
      }
      case 'diverse': {
        const count = parsed.positional[0] ? Number(parsed.positional[0]) : 8;
        await cmdDiverse(opts, count);
        return 0;
      }
      case 'replay': {
        const fixture = parsed.positional[0];
        if (!fixture) {
          console.error('replay: missing <fixture> argument');
          return 1;
        }
        await cmdReplay(opts, fixture);
        return 0;
      }
      default:
        console.error(`Unknown command: ${parsed.command}`);
        printUsage();
        return 1;
    }
  } catch (err) {
    console.error(`probe-llm error: ${(err as Error).message}`);
    if ((err as Error).stack) console.error((err as Error).stack);
    return 1;
  }
}

// Only run main when this file is invoked directly (not when imported by tests).
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();
if (isMain) {
  void main().then((code) => {
    process.exit(code);
  });
}
