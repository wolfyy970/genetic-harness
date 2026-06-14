/**
 * Tests for `seedFromArchive` + `clearArchiveBeforeRun`.
 *
 * The contract:
 *   - `clearArchiveDir` wipes the archive dir and recreates it empty.
 *   - With `clearArchiveBeforeRun: true`, runEvolution starts with a clean
 *     archive on disk.
 *   - With `seedFromArchive.enabled: true, count: N`, runEvolution loads
 *     the top N bots from the *previous* leaderboard.json and adds them
 *     to the new population as additional seeds (alongside the boilerplate).
 *   - Both can be combined: load → clear → write fresh.
 *   - Carry-overs that fail to compile are silently dropped.
 *   - Carry-overs that compile + evaluate are re-evaluated through the
 *     cascade (fitness from the archive is NOT trusted verbatim).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvolution } from '../src/orchestrator/run.js';
import {
  clearArchiveDir,
  writeLeaderboard,
  loadLeaderboard,
} from '../src/replay/store.js';
import type { ArchivedBot } from '../src/shared/types.js';
import '../src/arena/asteroids.js';

let tmpArchive: string;

beforeEach(() => {
  tmpArchive = mkdtempSync(join(tmpdir(), 'genharness-seed-'));
});

afterEach(() => {
  rmSync(tmpArchive, { recursive: true, force: true });
});

function makeFakeArchivedBot(id: string, source: string, score: number): ArchivedBot {
  return {
    id,
    source,
    shipId: id,
    fitness: {
      shipId: id,
      winRate: score,
      avgScore: 100 * score,
      avgFuelPerTick: 1000,
      avgTicksAlive: 500,
      totalMatches: 10,
      totalTicksAlive: 5000,
      cpuTimeTotal: 0n,
      memoryUsed: 0,
      crashes: 0,
      fitnessScore: score,
    },
    stage: 2,
    timestamp: 0,
    metadata: {
      generation: 7,
      island: 0,
      behavioralSignature: [],
      complexity: 1,
      noveltyScore: 1,
    },
  };
}

// Spam-fire bot: aggression≈1 ⇒ lands in MAP-Elites bucket 3, distinct from
// the boilerplate avoidance seed (which sits in bucket 0-1). This is what
// keeps the carry-over from getting silently displaced by cell-elite ties.
const VALID_BOT_SOURCE = `function tick(s) { return { type: 'fire' }; }`;
const UNCOMPILABLE_SOURCE = `function tick(s) { this is not valid javascript`;

describe('clearArchiveDir', () => {
  it('removes leaderboard.json and recreates the directory empty', () => {
    writeLeaderboard(tmpArchive, [makeFakeArchivedBot('a1', VALID_BOT_SOURCE, 0.5)]);
    expect(existsSync(join(tmpArchive, 'leaderboard.json'))).toBe(true);

    clearArchiveDir(tmpArchive);

    expect(existsSync(tmpArchive)).toBe(true);
    expect(existsSync(join(tmpArchive, 'leaderboard.json'))).toBe(false);
  });

  it('is idempotent (clearing twice is fine)', () => {
    clearArchiveDir(tmpArchive);
    clearArchiveDir(tmpArchive);
    expect(existsSync(tmpArchive)).toBe(true);
  });

  it('removes manifest.json and replay subdirs', () => {
    writeFileSync(join(tmpArchive, 'manifest.json'), '{}');
    mkdirSync(join(tmpArchive, 'generations', 'gen-0001'), { recursive: true });
    writeFileSync(join(tmpArchive, 'generations', 'gen-0001', 'replay-1.json'), '{}');

    clearArchiveDir(tmpArchive);

    expect(existsSync(join(tmpArchive, 'manifest.json'))).toBe(false);
    expect(existsSync(join(tmpArchive, 'generations'))).toBe(false);
  });

  it('refuses to clear suspiciously-shallow paths', () => {
    expect(() => clearArchiveDir('/')).toThrow(/suspiciously-shallow/);
  });
});

describe('runEvolution: clearArchiveBeforeRun', () => {
  it('wipes existing leaderboard.json when enabled', async () => {
    writeLeaderboard(tmpArchive, [makeFakeArchivedBot('stale', VALID_BOT_SOURCE, 0.9)]);
    expect(existsSync(join(tmpArchive, 'leaderboard.json'))).toBe(true);

    await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 1,
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
      clearArchiveBeforeRun: true,
    });

    // After the run the leaderboard contains the new generation's bots,
    // not the stale 'stale' bot we wrote at the start.
    const board = loadLeaderboard(tmpArchive);
    expect(board).not.toBeNull();
    expect(board!.find((b) => b.id === 'stale')).toBeUndefined();
  }, 60_000);

  it('leaves prior leaderboard alone when disabled (default)', async () => {
    writeLeaderboard(tmpArchive, [makeFakeArchivedBot('stale', VALID_BOT_SOURCE, 0.9)]);

    await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 1,
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
      // clearArchiveBeforeRun defaults to false
    });

    // leaderboard.json is fully rewritten with the new run's snapshot —
    // but no clear happened (manifest etc. would survive). We just check
    // the file still exists and has *some* content.
    expect(existsSync(join(tmpArchive, 'leaderboard.json'))).toBe(true);
  }, 60_000);
});

describe('runEvolution: seedFromArchive', () => {
  it('carries top-K elites from a prior leaderboard into the new run', async () => {
    // Plant a previous-run leaderboard with two valid bots.
    writeLeaderboard(tmpArchive, [
      makeFakeArchivedBot('prior-best', VALID_BOT_SOURCE, 0.9),
      makeFakeArchivedBot('prior-2nd', VALID_BOT_SOURCE, 0.7),
    ]);

    const summary = await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 1,
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
      seedFromArchive: { enabled: true, count: 2 },
      seedMode: 'blank',
    });

    // At least one carry-over should be on the leaderboard. The id is
    // prefixed `carryover-` by run.ts so we can distinguish from fresh seeds.
    const carryovers = summary.leaderboard.filter((b) => b.id.startsWith('carryover-'));
    expect(carryovers.length).toBeGreaterThan(0);
  }, 60_000);

  it('drops carry-overs that fail to compile', async () => {
    writeLeaderboard(tmpArchive, [
      makeFakeArchivedBot('bad', UNCOMPILABLE_SOURCE, 0.9),
      makeFakeArchivedBot('good', VALID_BOT_SOURCE, 0.8),
    ]);

    const summary = await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 1,
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
      seedFromArchive: { enabled: true, count: 2 },
      seedMode: 'blank',
    });

    // The 'bad' carry-over should not appear; the 'good' one should.
    expect(summary.leaderboard.find((b) => b.id === 'carryover-bad')).toBeUndefined();
    expect(summary.leaderboard.find((b) => b.id === 'carryover-good')).toBeDefined();
  }, 60_000);

  it('falls back gracefully when leaderboard.json is missing', async () => {
    // No prior leaderboard. seedFromArchive enabled — should not throw.
    const summary = await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 1,
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
      seedFromArchive: { enabled: true, count: 3 },
      seedMode: 'blank',
    });

    // Run completes; only boilerplate seed is on the leaderboard.
    expect(summary.leaderboard.length).toBeGreaterThan(0);
    expect(summary.leaderboard.every((b) => !b.id.startsWith('carryover-'))).toBe(true);
  }, 60_000);

  it('combines clear + seed: loads first, then clears, then writes fresh', async () => {
    writeLeaderboard(tmpArchive, [
      makeFakeArchivedBot('keep-me', VALID_BOT_SOURCE, 0.9),
    ]);

    const summary = await runEvolution({
      llmBaseUrl: 'mock',
      islandCount: 1,
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
      clearArchiveBeforeRun: true,
      seedFromArchive: { enabled: true, count: 1 },
      seedMode: 'blank',
    });

    // Carry-over should have survived the clear (load happens BEFORE clear).
    const carryovers = summary.leaderboard.filter((b) => b.id === 'carryover-keep-me');
    expect(carryovers.length).toBe(1);
  }, 60_000);
});
