/**
 * Tests for the Zod-defined LLM response schemas.
 *
 * Two things to guard:
 *   1. The Zod-level validation matches our expectations (accepts good
 *      bots, rejects bots missing required fields or with bad source).
 *   2. The JSON-Schema derivation produces a shape OpenAI-compatible
 *      structured-output implementations will actually accept.
 */

import { describe, it, expect } from 'vitest';
import {
  BotSubmissionSchema,
  DiverseSeedBatchSchema,
  BotSubmissionResponseFormat,
  DiverseSeedBatchResponseFormat,
  toResponseFormatSchema,
  parseSchemaResponse,
} from '../src/orchestrator/prompts/schemas.js';
import { z } from 'zod';

const GOOD_SOURCE = `function tick(s) {
  if (s.opponents.length > 0) {
    return { type: 'fire' };
  }
  return { type: 'wait' };
}`;

describe('BotSubmissionSchema', () => {
  it('accepts a valid bot submission', () => {
    const result = BotSubmissionSchema.safeParse({ source: GOOD_SOURCE });
    expect(result.success).toBe(true);
  });

  it('accepts an optional strategy string', () => {
    const r = BotSubmissionSchema.safeParse({
      source: GOOD_SOURCE,
      strategy: 'fires only on tight aim-lock',
    });
    expect(r.success).toBe(true);
  });

  it('rejects bot submission missing source', () => {
    const r = BotSubmissionSchema.safeParse({ strategy: 'no source' });
    expect(r.success).toBe(false);
  });

  it('rejects source without function tick(s) signature', () => {
    const r = BotSubmissionSchema.safeParse({
      source: 'const tick = (s) => ({ type: "wait" });',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toMatch(/function.*tick/i);
    }
  });

  it('rejects source under 30 chars (likely truncated)', () => {
    const r = BotSubmissionSchema.safeParse({ source: 'function tick(s){}' });
    expect(r.success).toBe(false);
  });

  it('rejects extra top-level keys (strict mode)', () => {
    const r = BotSubmissionSchema.safeParse({
      source: GOOD_SOURCE,
      extraField: 'should be rejected',
    });
    expect(r.success).toBe(false);
  });
});

describe('DiverseSeedBatchSchema', () => {
  it('accepts a valid batch', () => {
    const r = DiverseSeedBatchSchema.safeParse({
      bots: [
        { id: 'seed-001-aggressive', source: GOOD_SOURCE },
        { id: 'seed-002-sniper-mid', source: GOOD_SOURCE, strategy: 'sniper' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty bot array', () => {
    const r = DiverseSeedBatchSchema.safeParse({ bots: [] });
    expect(r.success).toBe(false);
  });

  it('rejects malformed seed IDs', () => {
    const r = DiverseSeedBatchSchema.safeParse({
      bots: [{ id: 'NotASeed', source: GOOD_SOURCE }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects bots with a hallucinated tick signature in source', () => {
    const r = DiverseSeedBatchSchema.safeParse({
      bots: [{ id: 'seed-001-bad', source: 'function notATick() { return null; }' }],
    });
    expect(r.success).toBe(false);
  });
});

describe('toResponseFormatSchema', () => {
  it('produces the OpenAI response_format envelope shape', () => {
    expect(BotSubmissionResponseFormat.type).toBe('json_schema');
    expect(BotSubmissionResponseFormat.json_schema.name).toBe('BotSubmission');
    expect(BotSubmissionResponseFormat.json_schema.strict).toBe(true);
    expect(BotSubmissionResponseFormat.json_schema.schema).toBeTypeOf('object');
  });

  it('emits an object-rooted schema for object-rooted Zod schemas', () => {
    const schema = BotSubmissionResponseFormat.json_schema.schema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.properties).toBeDefined();
    expect(schema.properties).toHaveProperty('source');
    expect(schema.required).toContain('source');
  });

  it('strips $schema root key (OpenAI strict mode rejects it)', () => {
    const schema = BotSubmissionResponseFormat.json_schema.schema as Record<string, unknown>;
    expect(schema).not.toHaveProperty('$schema');
  });

  it('emits DiverseSeedBatch with nested bots array', () => {
    const schema = DiverseSeedBatchResponseFormat.json_schema.schema as {
      type?: string;
      properties?: { bots?: { type?: string; items?: unknown } };
    };
    expect(schema.type).toBe('object');
    expect(schema.properties?.bots?.type).toBe('array');
    expect(schema.properties?.bots?.items).toBeDefined();
  });

  it('handles arbitrary Zod schemas via the helper', () => {
    const custom = z.object({ name: z.string(), count: z.number().int() }).strict();
    const rf = toResponseFormatSchema(custom, 'Custom');
    expect(rf.json_schema.name).toBe('Custom');
    const s = rf.json_schema.schema as { type?: string; properties?: Record<string, unknown> };
    expect(s.type).toBe('object');
    expect(s.properties).toHaveProperty('name');
    expect(s.properties).toHaveProperty('count');
  });
});

describe('parseSchemaResponse', () => {
  it('parses a valid JSON string and returns the data', () => {
    const r = parseSchemaResponse(
      BotSubmissionSchema,
      JSON.stringify({ source: GOOD_SOURCE }),
    );
    expect(r.ok).toBe(true);
    expect(r.data?.source).toBe(GOOD_SOURCE);
    expect(r.issues).toEqual([]);
  });

  it('accepts an already-parsed object', () => {
    const r = parseSchemaResponse(BotSubmissionSchema, { source: GOOD_SOURCE });
    expect(r.ok).toBe(true);
  });

  it('reports JSON parse failures as a single issue', () => {
    const r = parseSchemaResponse(BotSubmissionSchema, '{ not json');
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/not parseable JSON/);
  });

  it('reports schema violations with path + message', () => {
    const r = parseSchemaResponse(BotSubmissionSchema, { source: 'short' });
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    // Issue format: "<path>: <message>"
    expect(r.issues.some((i) => i.includes('source:'))).toBe(true);
  });

  it('collects multiple issues in one pass (not just the first)', () => {
    const r = parseSchemaResponse(DiverseSeedBatchSchema, {
      bots: [
        { id: 'bad-id', source: 'too short' },
        { id: 'also-bad', source: 'also too short' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThanOrEqual(2);
  });
});
