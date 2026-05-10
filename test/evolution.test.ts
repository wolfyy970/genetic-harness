/**
 * End-to-end smoke test for the evolutionary loop with the mock LLM.
 *
 * Runs runEvolution() with maxGenerations=2 and verifies:
 *   - the seed gets a real fitness signal (matches > 0)
 *   - mutations are produced and evaluated
 *   - leaderboard is sorted and non-empty
 *
 * Mock-LLM mode skips network. Total wall time should be under ~3s on
 * a normal machine — if it goes much higher, the cascade is too heavy
 * for an inner-loop test and we need to dial down match length.
 */

import { describe, it, expect } from 'vitest';
import { runEvolution } from '../src/orchestrator/run.js';
import '../src/arena/asteroids.js';

describe('Evolution loop (mock LLM)', () => {
  it('runs 2 generations end-to-end and returns a populated leaderboard', async () => {
    const summary = await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 2,
      migrationInterval: 100,
      maxGenerations: 2,
      stages: {
        syntax: true,
        quickRollout: { enabled: true, steps: 50 },
        quickGames: { enabled: true, games: 1 },
        fullTournament: { enabled: false, games: 0 },
      },
      maxIdleMs: 60_000,
      evalTimeoutMs: 60_000,
      leaderboardSize: 10,
    });

    expect(summary.generations).toBe(2);
    expect(summary.leaderboard.length).toBeGreaterThan(0);
    expect(summary.totalMutations).toBeGreaterThan(0);

    // Top-of-leaderboard bot should have actually played matches.
    const top = summary.leaderboard[0];
    expect(top.fitness.totalMatches).toBeGreaterThan(0);
    expect(top.fitness.avgFuelPerTick).toBeGreaterThan(0);

    // Leaderboard must be sorted by fitnessScore desc.
    for (let i = 1; i < summary.leaderboard.length; i++) {
      expect(summary.leaderboard[i - 1].fitness.fitnessScore).toBeGreaterThanOrEqual(
        summary.leaderboard[i].fitness.fitnessScore,
      );
    }
  }, 90_000);

  it('honors capped fitness mode', async () => {
    const summary = await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 1,
      migrationInterval: 100,
      maxGenerations: 1,
      mode: 'capped',
      fuelCeiling: 1, // absurdly low ceiling — disqualifies almost everything
      stages: {
        syntax: true,
        quickRollout: { enabled: true, steps: 30 },
        quickGames: { enabled: false, games: 0 },
        fullTournament: { enabled: false, games: 0 },
      },
      maxIdleMs: 60_000,
      evalTimeoutMs: 60_000,
    });

    // With ceiling=1ns, every evaluated bot should get fitnessScore<0
    // (the disqualification sentinel from buildFitnessFromStats).
    if (summary.leaderboard.length > 0) {
      for (const bot of summary.leaderboard) {
        if (bot.fitness.totalMatches > 0) {
          expect(bot.fitness.fitnessScore).toBeLessThan(0);
        }
      }
    }
  }, 90_000);
});
