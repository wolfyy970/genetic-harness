/**
 * Tests for the canonical bot-author manual.
 *
 * Three jobs:
 *
 *   1. Stability — the manual is supposed to be byte-stable across all
 *      LLM calls so the server's KV cache works for us. A snapshot test
 *      makes any change explicit and reviewed.
 *
 *   2. Completeness — every section the wiring code expects must exist
 *      (BotState contract, BotAction union, example bots, etc.).
 *
 *   3. **Honesty — the example bots must actually be valid bots.** The
 *      manual teaches by example; if our examples have hallucinations,
 *      we're priming the LLM to hallucinate. Each \`function tick(s) { ... }\`
 *      block in the manual is extracted and run through
 *      \`validateBotSource()\`. Bundle errors, fake fields, fake action
 *      shapes — anything that would reject an LLM output rejects ours
 *      too.
 */

import { describe, it, expect } from 'vitest';
import { BOT_AUTHOR_MANUAL, manualVersionHash } from '../src/orchestrator/prompts/bot-author-manual.js';
import { validateBotSource, extractTickFunctions } from '../src/orchestrator/mutation.js';

describe('BOT_AUTHOR_MANUAL — shape', () => {
  it('is a non-empty string', () => {
    expect(typeof BOT_AUTHOR_MANUAL).toBe('string');
    expect(BOT_AUTHOR_MANUAL.length).toBeGreaterThan(2000);
  });

  it('declares the BotState contract', () => {
    expect(BOT_AUTHOR_MANUAL).toMatch(/type BotState\s*=/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/s\.ship\.pos/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/s\.ship\.vel/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/s\.opponents/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/s\.asteroids/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/s\.bullets/);
  });

  it('declares the BotAction union', () => {
    expect(BOT_AUTHOR_MANUAL).toMatch(/type BotAction\s*=/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/['"]thrust['"]/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/['"]rotate['"]/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/['"]fire['"]/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/['"]wait['"]/);
  });

  it('includes the toroidal local-frame derivation', () => {
    expect(BOT_AUTHOR_MANUAL).toMatch(/toroidal/i);
    expect(BOT_AUTHOR_MANUAL).toMatch(/aim-error/i);
    // The canonical wraparound formula
    expect(BOT_AUTHOR_MANUAL).toMatch(/\(\(desired - a \+ Math\.PI \* 3\) % \(Math\.PI \* 2\)\) - Math\.PI/);
  });

  it('includes all three worked example bots by name', () => {
    expect(BOT_AUTHOR_MANUAL).toMatch(/SniperBot/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/BrawlerBot/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/AsteroidHunter/);
  });

  it('includes the Common Pitfalls section', () => {
    expect(BOT_AUTHOR_MANUAL).toMatch(/Common pitfalls/i);
    // Specific pitfalls we know the model has hit:
    expect(BOT_AUTHOR_MANUAL).toMatch(/s\.ship\.x/);
    expect(BOT_AUTHOR_MANUAL).toMatch(/['"]shoot['"]/);
  });

  it('includes the mutation contract section', () => {
    expect(BOT_AUTHOR_MANUAL).toMatch(/mutation contract/i);
    expect(BOT_AUTHOR_MANUAL).toMatch(/strategy/);
  });
});

describe('BOT_AUTHOR_MANUAL — byte stability', () => {
  it('matches the snapshotted hash (intentional changes should require updating this)', () => {
    // If you intentionally changed the manual, run the test once with
    // `vitest --update` (or update this hash by hand) — the snapshot
    // exists to force a conscious acknowledgment that the manual moved.
    // Run `npx tsx -e "import('./src/orchestrator/prompts/bot-author-manual.js').then(m => console.log(m.manualVersionHash()))"`
    // to print the current hash.
    expect(manualVersionHash()).toMatchSnapshot();
  });

  it('hash is deterministic across calls', () => {
    const a = manualVersionHash();
    const b = manualVersionHash();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('BOT_AUTHOR_MANUAL — example bots are valid', () => {
  // Extract every \`function tick(s) { ... }\` from the manual. This uses
  // the same parser the production pipeline uses, so if the parser can
  // pull these out, it can pull anything else out.
  const examples = extractTickFunctions(BOT_AUTHOR_MANUAL);

  it('contains exactly 3 worked example bots', () => {
    expect(examples).toHaveLength(3);
  });

  // Each example MUST validate. The whole point of the manual is to
  // teach by example; if the examples are dishonest, the model learns
  // the wrong thing.
  it.each(examples.map((src, i) => ({ idx: i, src })))(
    'example $idx passes validateBotSource()',
    ({ src }) => {
      const result = validateBotSource(src);
      if (!result.ok) {
        // Loud failure — print the offending source so the dev can
        // quickly see what's wrong with the manual.
        console.error('Example bot failed validation:');
        console.error('--- source ---');
        console.error(src);
        console.error('--- issues ---');
        console.error(JSON.stringify(result.issues, null, 2));
      }
      expect(result.ok).toBe(true);
    },
  );

  it('SniperBot example uses the canonical aim-error idiom', () => {
    // First example bot in the manual is SniperBot.
    const sniper = examples[0];
    expect(sniper).toMatch(/Math\.atan2/);
    expect(sniper).toMatch(/Math\.PI \* 3/);
  });

  it('BrawlerBot example uses reverse thrust', () => {
    const brawler = examples[1];
    expect(brawler).toMatch(/direction:\s*-1/);
  });

  it('AsteroidHunter example uses tier-aware targeting', () => {
    const hunter = examples[2];
    expect(hunter).toMatch(/tier/);
    expect(hunter).toMatch(/LARGE/);
    expect(hunter).toMatch(/SMALL/);
  });
});
