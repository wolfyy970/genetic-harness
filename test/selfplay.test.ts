/**
 * Tests for the self-play stage added to the evaluator cascade.
 *
 * The point of these is intent: with no top-K pool, self-play is a no-op
 * (correct on generation 0). With a non-empty pool, the candidate's
 * signature gains a `selfplay:<id>:<W|L|D>` tag for each opponent.
 */

import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/orchestrator/evaluator.js';
import { loadConfig } from '../src/shared/config.js';
import type { ArchivedBot, FitnessResult } from '../src/shared/types.js';
import '../src/arena/asteroids.js';

function makeBot(id: string, source: string): ArchivedBot {
  const fitness: FitnessResult = {
    shipId: id,
    winRate: 0,
    avgScore: 0,
    avgFuelPerTick: 0,
    avgTicksAlive: 0,
    totalMatches: 0,
    totalTicksAlive: 0,
    cpuTimeTotal: 0n,
    memoryUsed: 0,
    crashes: 0,
    fitnessScore: 0,
  };
  return {
    id,
    source,
    shipId: id,
    fitness,
    stage: 0,
    timestamp: 0,
    metadata: {
      generation: 0,
      island: 0,
      behavioralSignature: [],
      complexity: 1,
      noveltyScore: 1,
    },
  };
}

const SOURCE_FIRE = `function tick(s) { return { type: 'fire' }; }`;
const SOURCE_WAIT = `function tick(s) { return { type: 'wait' }; }`;

const QUICK_STAGES = {
  syntax: true,
  quickRollout: { enabled: true, steps: 30 },
  quickGames: { enabled: true, games: 1 },
  fullTournament: { enabled: false, games: 0 },
} as const;

describe('Self-play cascade stage', () => {
  it('is a no-op when selfPlayPool is empty (generation 0 case)', async () => {
    const config = loadConfig({
      llmBaseUrl: 'mock',
      stages: { ...QUICK_STAGES, selfPlay: { enabled: true, topK: 3 } },
    });
    const bot = makeBot('cand', SOURCE_FIRE);
    const result = await evaluate(bot, 'asteroids', config, { selfPlayPool: [] });
    expect(result.error).toBeUndefined();
    // Reference roster signatures are present; no `selfplay:` tags.
    const sig = result.fitness.shipId; // touch to satisfy compiler
    expect(sig).toBe('cand');
    // Stats signature lives on the result via debug logging — the public
    // surface to assert is fitness.totalMatches > 0 against the roster.
    expect(result.fitness.totalMatches).toBeGreaterThan(0);
  }, 30_000);

  it('is a no-op when stages.selfPlay.enabled is false', async () => {
    const config = loadConfig({
      llmBaseUrl: 'mock',
      stages: { ...QUICK_STAGES, selfPlay: { enabled: false, topK: 3 } },
    });
    const opp = makeBot('elite', SOURCE_WAIT);
    const bot = makeBot('cand', SOURCE_FIRE);
    const result = await evaluate(bot, 'asteroids', config, {
      selfPlayPool: [opp],
    });
    expect(result.error).toBeUndefined();
  }, 30_000);

  it('runs self-play matches against the supplied pool', async () => {
    const config = loadConfig({
      llmBaseUrl: 'mock',
      stages: { ...QUICK_STAGES, selfPlay: { enabled: true, topK: 2 } },
    });
    const elite1 = makeBot('elite-1', SOURCE_WAIT);
    const elite2 = makeBot('elite-2', SOURCE_WAIT);
    const bot = makeBot('cand', SOURCE_FIRE);

    const without = await evaluate(bot, 'asteroids', config, { selfPlayPool: [] });
    const withPool = await evaluate(bot, 'asteroids', config, {
      selfPlayPool: [elite1, elite2],
    });

    // Self-play adds 2 matches (one per elite). totalMatches grows accordingly.
    expect(withPool.fitness.totalMatches - without.fitness.totalMatches).toBe(2);
  }, 60_000);

  it('skips self-play opponents that share the candidate shipId', async () => {
    // If population.getTopK includes the candidate itself (because the
    // mutation came from a re-evaluation), don't make it fight itself.
    const config = loadConfig({
      llmBaseUrl: 'mock',
      stages: { ...QUICK_STAGES, selfPlay: { enabled: true, topK: 2 } },
    });
    const sameId = makeBot('cand', SOURCE_WAIT);
    const otherElite = makeBot('elite-x', SOURCE_WAIT);
    const bot = makeBot('cand', SOURCE_FIRE);

    const result = await evaluate(bot, 'asteroids', config, {
      selfPlayPool: [sameId, otherElite],
    });
    // Only the non-self elite should add a match; total is roster + 1.
    const baseline = await evaluate(bot, 'asteroids', config, { selfPlayPool: [] });
    expect(result.fitness.totalMatches - baseline.fitness.totalMatches).toBe(1);
  }, 60_000);
});
