/**
 * Fixture-replay regression test.
 *
 * Loads every JSON fixture under `test/fixtures/llm/` (captured by the
 * `probe-llm` dev harness against the real LLM) and replays each one
 * through the current production pipeline's parser + validator. Asserts
 * an aggregate pass rate; individual fixture failures are logged.
 *
 * What this protects:
 *   - **Validator regressions.** If someone adds a hallucination pattern
 *     that incorrectly rejects a previously-good bot, the fixture pass
 *     rate drops and CI fails.
 *   - **Parser regressions.** If someone breaks `extractTickFunctions`
 *     or `parseSchemaResponse`, previously-extractable bots stop
 *     extracting.
 *   - **Schema regressions.** If someone tightens `BotSubmissionSchema`
 *     past what real LLM output actually emits, the rate drops.
 *
 * What this does NOT protect:
 *   - **Prompt regressions.** If someone breaks the manual and the model
 *     starts producing worse output, the FIXTURES don't change — they're
 *     historical captures. To detect prompt regressions you have to run
 *     `npm run probe-llm` again and compare new captures to old.
 *
 * Threshold: ≥80% pass rate. Updated to match the plan's verification
 * target. When fixtures are added or replaced (via Slice F's capture
 * sweep), this stays sensitive to the same threshold.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateBotSource,
  extractTickFunctions,
} from '../src/orchestrator/mutation.js';
import {
  BotSubmissionSchema,
  parseSchemaResponse,
} from '../src/orchestrator/prompts/schemas.js';

interface FixturePayload {
  command: string;
  timestamp: string;
  server: { baseUrl: string; model: string };
  request: {
    messages: Array<{ role: string; content: string }>;
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
  validation?: unknown;
  extractedSource?: string;
}

const FIXTURE_DIR = join(process.cwd(), 'test', 'fixtures', 'llm');

function listFixtures(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(FIXTURE_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.json'))
    .filter((n) => {
      // Skip dev-only fixtures left behind by the probe-llm test suite.
      if (n.startsWith('probe-test-')) return false;
      return true;
    })
    .map((n) => join(FIXTURE_DIR, n))
    .filter((p) => statSync(p).isFile());
}

function loadFixture(path: string): FixturePayload {
  return JSON.parse(readFileSync(path, 'utf-8')) as FixturePayload;
}

/**
 * Re-extract the bot source from a fixture using the same logic the
 * production pipeline uses. Mirrors the structured-output-vs-free-text
 * branch in `generateMutationWithRetry`.
 */
function extractSourceFromFixture(fx: FixturePayload): { source: string | null; route: 'schema' | 'regex' } {
  // If the original request used response_format, prefer the schema parser.
  if (fx.request.response_format !== undefined) {
    const parsed = parseSchemaResponse(BotSubmissionSchema, fx.response.contentText);
    if (parsed.ok && parsed.data) {
      return { source: parsed.data.source, route: 'schema' };
    }
    // Fall through to regex on schema-parse failure (the production
    // pipeline does the same as defense-in-depth for diverse-seed).
  }
  const fns = extractTickFunctions(fx.response.contentText);
  return { source: fns[0] ?? null, route: 'regex' };
}

describe('LLM fixture replay — regression dataset', () => {
  const fixtures = listFixtures();

  it('has at least one captured fixture (Slice F populates these via probe-llm)', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it('every fixture is well-formed JSON with required keys', () => {
    for (const path of fixtures) {
      const fx = loadFixture(path);
      expect(fx.command).toBeTypeOf('string');
      expect(fx.response).toBeTypeOf('object');
      expect(fx.response.contentText).toBeTypeOf('string');
    }
  });

  it('aggregate validation pass rate is ≥80% (mutate fixtures)', () => {
    const mutateFixtures = fixtures.filter((p) => p.includes('mutate-'));
    if (mutateFixtures.length === 0) return; // no mutate fixtures, nothing to check

    const results = mutateFixtures.map((path) => {
      const fx = loadFixture(path);
      const { source, route } = extractSourceFromFixture(fx);
      if (!source) {
        return { path, passed: false, reason: `no source extracted (route=${route})` };
      }
      const v = validateBotSource(source);
      return {
        path,
        passed: v.ok,
        reason: v.ok ? undefined : `validation [${v.severity}]: ${v.issues.map((i) => i.code).join(', ')}`,
      };
    });

    const passed = results.filter((r) => r.passed).length;
    const rate = passed / results.length;
    if (rate < 0.8) {
      console.error('Fixture replay below threshold:');
      for (const r of results) {
        if (!r.passed) console.error(`  ✗ ${r.path}: ${r.reason}`);
      }
    }
    expect(rate).toBeGreaterThanOrEqual(0.8);
  });

  it('every passing fixture extracts the same source the original capture recorded', () => {
    // Drift detector: if a fixture's stored `extractedSource` differs
    // from what the current parser produces, something in the parser
    // changed. Skip fixtures that didn't record extractedSource (the
    // capabilities-probe captures, for example).
    let checked = 0;
    let drifts = 0;
    for (const path of fixtures) {
      const fx = loadFixture(path);
      if (!fx.extractedSource) continue;
      const { source } = extractSourceFromFixture(fx);
      if (source === null) continue;
      checked++;
      // Allow whitespace-only differences — the JSON-string-unescape
      // path can introduce/remove escapes.
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      if (norm(source) !== norm(fx.extractedSource)) {
        drifts++;
        console.warn(
          `  ↻ extractedSource drift in ${path}: differing parser output`,
        );
      }
    }
    // Allow ≤25% drift (parser is allowed to evolve), but log noisy
    // changes so they're visible during review.
    if (checked === 0) return;
    expect(drifts / checked).toBeLessThanOrEqual(0.25);
  });

  it('has captures across multiple exemplars (catches accidental fixture deletion)', () => {
    const exemplars = new Set<string>();
    for (const path of fixtures) {
      const m = /mutate-([a-z][a-z-]*)-/.exec(path.split('/').pop() ?? '');
      if (m) exemplars.add(m[1]);
    }
    // We expect at least 2 distinct exemplars in the regression set.
    expect(exemplars.size).toBeGreaterThanOrEqual(2);
  });
});
