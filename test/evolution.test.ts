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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvolution } from '../src/orchestrator/run.js';
import '../src/arena/asteroids.js';

let tmpArchive: string;

beforeEach(() => {
  tmpArchive = mkdtempSync(join(tmpdir(), 'genharness-evo-'));
});

afterEach(() => {
  rmSync(tmpArchive, { recursive: true, force: true });
});

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
      archiveDir: tmpArchive,
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
      archiveDir: tmpArchive,
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

  it('writes replay files + manifest when recordReplays is enabled', async () => {
    await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 1,
      migrationInterval: 100,
      maxGenerations: 1,
      stages: {
        syntax: true,
        quickRollout: { enabled: true, steps: 30 },
        quickGames: { enabled: true, games: 1 },
        fullTournament: { enabled: false, games: 0 },
      },
      maxIdleMs: 60_000,
      evalTimeoutMs: 60_000,
      archiveDir: tmpArchive,
      recordReplays: true,
      replayCount: 1,
      replayMaxFrames: 50,
      replaySampleEvery: 1,
    });

    const manifestPath = join(tmpArchive, 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.schema).toBe(1);
    expect(manifest.runId).toMatch(/^run-/);
    expect(manifest.arena).toBe('asteroids');
    // llmApiKey must not appear in the persisted (sanitized) config.
    expect('llmApiKey' in manifest.config).toBe(false);
    expect(manifest.generations.length).toBeGreaterThan(0);

    const gen0 = manifest.generations[0];
    expect(gen0.replays.length).toBeGreaterThan(0);
    const replayPath = join(tmpArchive, gen0.replays[0].path);
    expect(existsSync(replayPath)).toBe(true);

    const replay = JSON.parse(readFileSync(replayPath, 'utf8'));
    expect(replay.schema).toBe(1);
    expect(replay.arena).toBe('asteroids');
    expect(Array.isArray(replay.frames)).toBe(true);
    expect(replay.frames.length).toBeGreaterThan(0);
    expect(replay.frames.length).toBeLessThanOrEqual(50);
  }, 90_000);

  it('persists leaderboard.json to archiveDir after each generation', async () => {
    await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 1,
      migrationInterval: 100,
      maxGenerations: 1,
      stages: {
        syntax: true,
        quickRollout: { enabled: true, steps: 30 },
        quickGames: { enabled: false, games: 0 },
        fullTournament: { enabled: false, games: 0 },
      },
      maxIdleMs: 60_000,
      evalTimeoutMs: 60_000,
      archiveDir: tmpArchive,
    });

    const leaderboardPath = join(tmpArchive, 'leaderboard.json');
    expect(existsSync(leaderboardPath)).toBe(true);

    const raw = readFileSync(leaderboardPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.schema).toBe(1);
    expect(parsed.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(parsed.bots)).toBe(true);
    expect(parsed.bots.length).toBeGreaterThan(0);
    // Bigint cpuTimeTotal must be serialized as a string.
    expect(typeof parsed.bots[0].fitness.cpuTimeTotal).toBe('string');
  }, 90_000);
});
