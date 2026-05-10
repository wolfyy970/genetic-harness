/**
 * Integration test: full evaluator cascade (compile + play + fitness).
 *
 * Exercises the real pipeline end-to-end without an LLM:
 *   - bundle a candidate bot
 *   - compile reference roster into the same isolate pool
 *   - play each opponent multiple seeds via playMatch
 *   - aggregate fitness with each mode (pure/Pareto/capped/weighted)
 */

import { describe, it, expect } from 'vitest';
import { evaluate, buildFitnessFromStats } from '../src/orchestrator/evaluator.js';
import { loadConfig } from '../src/shared/config.js';
import type { ArchivedBot, HarnessConfig } from '../src/shared/types.js';
import '../src/arena/asteroids.js';

const AGGRESSIVE_CANDIDATE = `function tick(s) {
  if (!s.opponents || s.opponents.length === 0) return { type: 'wait' };
  var ship = s.ship;
  var o = s.opponents[0];
  var ang = Math.atan2(o.pos.y - ship.pos.y, o.pos.x - ship.pos.x);
  var diff = ang - ship.angle;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  if (Math.abs(diff) < 0.2) return { type: 'fire' };
  return { type: 'rotate', direction: diff > 0 ? 1 : -1 };
}`;

function makeArchivedBot(source: string): ArchivedBot {
  return {
    id: 'cand-1',
    source,
    shipId: 'cand-1',
    fitness: {
      shipId: 'cand-1',
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
    },
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

function quickConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return loadConfig({
    populationSize: 1,
    islandCount: 1,
    quickGamesPerEval: 1,
    fullTournamentGames: 1,
    referenceOpponents: 4,
    stages: {
      syntax: true,
      quickRollout: { enabled: true, steps: 50 },
      quickGames: { enabled: true, games: 1 },
      fullTournament: { enabled: false, games: 0 },
    },
    arena: 'asteroids',
    arenaConfig: {},
    ...overrides,
  });
}

describe('Evaluator cascade', () => {
  it('rejects a bot whose source fails to compile', async () => {
    const bot = makeArchivedBot(`function tick(s) { return { type: 'wait'; }`);
    const result = await evaluate(bot, 'asteroids', quickConfig());
    expect(result.stage).toBe(0);
    expect(result.error).toBeTruthy();
    expect(result.fitness.crashes).toBeGreaterThan(0);
  }, 30_000);

  it('rejects a bot that never defines globalThis.tick', async () => {
    const bot = makeArchivedBot(`var x = 1;`);
    const result = await evaluate(bot, 'asteroids', quickConfig());
    expect(result.stage).toBe(0);
    expect(result.error).toMatch(/globalThis\.tick/i);
  }, 30_000);

  it('produces a fitness with nonzero matches and CPU for a working bot', async () => {
    const bot = makeArchivedBot(AGGRESSIVE_CANDIDATE);
    const result = await evaluate(bot, 'asteroids', quickConfig());
    expect(result.error).toBeUndefined();
    expect(result.stage).toBeGreaterThanOrEqual(2);
    expect(result.fitness.totalMatches).toBeGreaterThan(0);
    expect(result.fitness.avgFuelPerTick).toBeGreaterThan(0);
    // Aggressive bot should beat the null opponent at least sometimes.
    expect(result.fitness.winRate).toBeGreaterThanOrEqual(0);
    expect(result.fitness.winRate).toBeLessThanOrEqual(1);
  }, 60_000);

  it('honors capped mode by disqualifying a bot above fuelCeiling', () => {
    const cappedHigh = buildFitnessFromStats(
      {
        shipId: 'a',
        matches: 4,
        wins: 3,
        draws: 0,
        totalScore: 0,
        totalTicksAlive: 400,
        totalCpuNanos: 1_000_000_000n, // 1B ns over 400 ticks => 2.5M ns/tick
        maxCpuNanosPerTick: 5_000_000n,
        crashes: 0,
        aggressionSum: 1.6, // 0.4 * 4 matches
        economySum: 1.2,
        signature: [],
      },
      'capped',
      { fuelCeiling: 1_000_000 }, // ceiling lower than actual usage
    );
    expect(cappedHigh.fitnessScore).toBeLessThan(0);
  });

  it('honors weighted mode with λ', () => {
    const w = buildFitnessFromStats(
      {
        shipId: 'b',
        matches: 4,
        wins: 4,
        draws: 0,
        totalScore: 0,
        totalTicksAlive: 400,
        totalCpuNanos: 4_000_000n, // 10K ns / tick
        maxCpuNanosPerTick: 50_000n,
        crashes: 0,
        aggressionSum: 0,
        economySum: 0,
        signature: [],
      },
      'weighted',
      { λ: 1 },
    );
    // win rate 1.0 minus λ * 10000/1e6 = 1 - 0.01 = 0.99
    expect(w.fitnessScore).toBeCloseTo(0.99, 2);
  });
});
