/**
 * Single source of truth for the JSON shapes the LLM must return.
 *
 * Defined in Zod so we get:
 *   - runtime validation (`BotSubmissionSchema.safeParse(...)`)
 *   - inferred TS types (`z.infer<typeof BotSubmissionSchema>`)
 *   - server-side JSON Schema for `response_format: json_schema` mode
 *     (via `zod-to-json-schema`)
 *
 * One declaration per shape; everything else derives from it. When we
 * need to add a new optional field or tighten a constraint, this is the
 * only file that changes — the schema flows out to the LLM (via Slice E),
 * to the validator (via `parseBotSubmission`), and to the TypeScript
 * consumer code automatically.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * The required structural property of every bot source string: it must
 * contain a complete `function tick(s) { ... }` definition. This regex
 * is enforced both client-side (via Zod) and server-side (via the
 * JSON-schema `pattern` keyword when the server's structured-output
 * implementation supports pattern enforcement on strings).
 *
 * NOTE: this regex is checked against the *entire source string*. It
 * doesn't enforce that the function is the ONLY thing in the source —
 * which is fine; the bot runtime ignores anything outside the function
 * body. It DOES enforce that the function exists and has the right
 * signature.
 */
const TICK_FUNCTION_REGEX = '^[\\s\\S]*function\\s+tick\\s*\\(\\s*s\\s*\\)\\s*\\{[\\s\\S]+\\}\\s*$';

const BotSourceSchema = z
  .string()
  .min(30, 'Bot source is suspiciously short (<30 chars) — likely truncated or a stub.')
  .max(8_000, 'Bot source exceeds 8 KB — keep tick() bodies focused.')
  .regex(
    new RegExp(TICK_FUNCTION_REGEX),
    'Bot source must contain a complete `function tick(s) { ... }` definition.',
  );

const StrategyNoteSchema = z
  .string()
  .min(1)
  .max(300, 'Strategy notes should be a sentence, not an essay.');

// ---------------------------------------------------------------------------
// Single-bot mutation response
// ---------------------------------------------------------------------------

/**
 * The expected shape of a single mutation call's response.
 *
 *   {
 *     "source": "function tick(s) { ... }",     // required
 *     "strategy": "fires only on tight aim..."   // optional, free-text
 *   }
 *
 * The `strategy` field is purely metadata — it's logged but not executed.
 * It's there because LLMs produce better code when allowed to articulate
 * intent. We also persist it on the archived bot for human-readable
 * provenance ("why did the LLM make this change?").
 */
export const BotSubmissionSchema = z
  .object({
    source: BotSourceSchema,
    strategy: StrategyNoteSchema.optional(),
  })
  .strict();

export type BotSubmission = z.infer<typeof BotSubmissionSchema>;

// ---------------------------------------------------------------------------
// Diverse-seed batch response
// ---------------------------------------------------------------------------

/**
 * The expected shape of a diverse-seed batch call's response.
 *
 *   {
 *     "bots": [
 *       { "id": "seed-001-...", "source": "function tick(s) {...}", "strategy": "..." },
 *       ...
 *     ]
 *   }
 *
 * Wrapping the array in an outer `{ bots: [...] }` instead of returning a
 * bare array is deliberate: some structured-output implementations are
 * strict about top-level arrays. An object root sidesteps that and leaves
 * room to add metadata fields later (e.g., `notes`, `version`).
 */
const SeedIdSchema = z
  .string()
  .min(8)
  .max(120)
  .regex(
    /^seed-\d{3}-[a-z][a-z0-9-]*$/,
    'Seed IDs must be of the form `seed-NNN-<lowercase-tag>` (e.g., `seed-007-aggressive-brawler`).',
  );

const DiverseSeedEntrySchema = z
  .object({
    id: SeedIdSchema,
    source: BotSourceSchema,
    strategy: StrategyNoteSchema.optional(),
  })
  .strict();

export type DiverseSeedEntry = z.infer<typeof DiverseSeedEntrySchema>;

export const DiverseSeedBatchSchema = z
  .object({
    bots: z
      .array(DiverseSeedEntrySchema)
      .min(1, 'Batch must contain at least one bot.')
      .max(50, 'Batch should not exceed 50 bots — beyond that the response gets truncated.'),
  })
  .strict();

export type DiverseSeedBatch = z.infer<typeof DiverseSeedBatchSchema>;

// ---------------------------------------------------------------------------
// JSON Schema derivation — for response_format: json_schema mode
// ---------------------------------------------------------------------------

/**
 * Convert a Zod schema to the JSON Schema shape OpenAI-compatible servers
 * expect inside `response_format: { type: 'json_schema', json_schema: ... }`.
 *
 * The OpenAI structured-output contract requires:
 *   - top-level `type: 'object'` (we already guarantee this)
 *   - `additionalProperties: false` everywhere (`zod-to-json-schema` emits
 *     this from `.strict()`)
 *   - all properties listed under `required` (OpenAI strict mode requires
 *     this even for optional fields — they get `null` as a valid type
 *     instead). We don't bend to that quirk here; servers that need it
 *     will degrade to `'object'` mode via the capability probe, where
 *     the schema is informational rather than constraining.
 *
 * Wraps the result in the `{ name, strict, schema }` envelope.
 */
export function toResponseFormatSchema(
  zodSchema: z.ZodType,
  name: string,
): {
  type: 'json_schema';
  json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
} {
  // Zod 4 ships native JSON Schema emission. We use `target: 'draft-7'`
  // for broadest compatibility with structured-output implementations
  // (OpenAI / vLLM / xgrammar / outlines all accept Draft-7).
  const schema = z.toJSONSchema(zodSchema, {
    target: 'draft-7',
  }) as Record<string, unknown>;

  // Strip any `$schema` root key — OpenAI's strict mode rejects unknown
  // top-level keys on the schema object itself.
  delete schema['$schema'];

  return {
    type: 'json_schema',
    json_schema: {
      name,
      strict: true,
      schema,
    },
  };
}

/** Convenience pre-built schema envelope for the mutation call. */
export const BotSubmissionResponseFormat = toResponseFormatSchema(
  BotSubmissionSchema,
  'BotSubmission',
);

/** Convenience pre-built schema envelope for the diverse-seed batch call. */
export const DiverseSeedBatchResponseFormat = toResponseFormatSchema(
  DiverseSeedBatchSchema,
  'DiverseSeedBatch',
);

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

export interface SchemaValidationResult<T> {
  ok: boolean;
  data?: T;
  /** Structured issues from Zod, formatted for inclusion in a re-prompt. */
  issues: string[];
}

/**
 * Parse-and-validate a JSON response against a Zod schema. Returns a
 * uniform `{ok, data, issues}` result so callers can branch without
 * dealing with Zod's exception model directly.
 *
 * Accepts either a JSON string or an already-parsed value. JSON parse
 * failures surface as a single issue.
 */
export function parseSchemaResponse<T extends z.ZodType>(
  schema: T,
  raw: string | unknown,
): SchemaValidationResult<z.infer<T>> {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        issues: [`Response was not parseable JSON: ${(err as Error).message}`],
      };
    }
  }

  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, data: result.data, issues: [] };
  }
  return {
    ok: false,
    issues: result.error.issues.map((iss) => {
      const path = iss.path.length > 0 ? iss.path.join('.') : '<root>';
      return `${path}: ${iss.message}`;
    }),
  };
}
