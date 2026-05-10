/**
 * Tests for src/replay/store.ts — leaderboard write/load round-trip and
 * path-traversal protection in safeArchivePath.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeLeaderboard,
  loadLeaderboard,
  safeArchivePath,
  ensureArchiveDir,
  writeReplay,
  readReplay,
  appendGenerationToManifest,
  loadManifest,
  pruneOldGenerations,
} from '../src/replay/store.js';
import { REPLAY_SCHEMA } from '../src/replay/types.js';
import type { ReplayFile } from '../src/replay/types.js';
import type { ArchivedBot } from '../src/shared/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'genharness-store-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeBot(id: string, fitnessScore: number, cpuNs: bigint): ArchivedBot {
  return {
    id,
    source: `function tick(s) { return { type: 'wait' }; }`,
    shipId: id,
    fitness: {
      shipId: id,
      winRate: fitnessScore,
      avgScore: 0,
      avgFuelPerTick: 1234,
      avgTicksAlive: 100,
      totalMatches: 5,
      totalTicksAlive: 500,
      cpuTimeTotal: cpuNs,
      memoryUsed: 0,
      crashes: 0,
      fitnessScore,
    },
    stage: 2,
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

describe('replay/store leaderboard round-trip', () => {
  it('writes and reads back a leaderboard with bigints intact', () => {
    const bots = [
      makeBot('a', 0.7, 12_345_678n),
      makeBot('b', 0.5, 9_999n),
    ];
    writeLeaderboard(tmp, bots);
    expect(existsSync(join(tmp, 'leaderboard.json'))).toBe(true);

    const loaded = loadLeaderboard(tmp);
    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(2);
    expect(loaded![0].id).toBe('a');
    expect(loaded![0].fitness.cpuTimeTotal).toBe(12_345_678n);
    expect(loaded![1].fitness.cpuTimeTotal).toBe(9_999n);
  });

  it('returns null when no leaderboard file exists', () => {
    expect(loadLeaderboard(tmp)).toBeNull();
  });

  it('overwrites a previous leaderboard atomically', () => {
    writeLeaderboard(tmp, [makeBot('a', 0.1, 1n)]);
    writeLeaderboard(tmp, [makeBot('b', 0.9, 2n)]);
    const loaded = loadLeaderboard(tmp);
    expect(loaded!.length).toBe(1);
    expect(loaded![0].id).toBe('b');
  });

  it('ensureArchiveDir creates missing directories', () => {
    const nested = join(tmp, 'foo', 'bar', 'baz');
    ensureArchiveDir(nested);
    expect(existsSync(nested)).toBe(true);
  });
});

function makeReplay(generation: number, matchId: string): ReplayFile {
  return {
    schema: REPLAY_SCHEMA,
    arena: 'asteroids',
    generation,
    matchId,
    participants: [
      { shipId: 'ship-0', role: 'candidate', refId: 'cand-1' },
      { shipId: 'ship-1', role: 'reference', refId: 'ref-aggressive' },
    ],
    config: {
      worldWidth: 400,
      worldHeight: 300,
      seed: 7,
      asteroidCount: 2,
      tickMs: 50,
      maxBulletsPerShip: 2,
      bulletSpeed: 4,
      shipThrust: 0.1,
      shipRotationSpeed: 0.1,
      shipMaxFuel: 5000,
      asteroidBaseRadius: 20,
      asteroidSpeed: 1,
      shipCount: 2,
    },
    durationTicks: 42,
    endedByElimination: false,
    shipReports: [
      {
        shipId: 'ship-0',
        score: 5,
        ticksAlive: 42,
        cpuNanosTotal: '12345',
        cpuNanosMax: '999',
        histogram: { thrust: 1, rotate: 2, fire: 3, wait: 4, invalid: 0 },
        survived: true,
      },
    ],
    frames: [
      { type: 'asteroids', tick: 1, entities: [] },
      { type: 'asteroids', tick: 2, entities: [] },
    ],
    sampleEvery: 1,
    createdAt: '2026-05-10T15:00:00.000Z',
  };
}

describe('replay write/read round-trip', () => {
  it('writes a replay file and reads it back', () => {
    const file = makeReplay(3, 'gen0003-cand-vs-ref-aggressive');
    const rel = writeReplay(tmp, file);
    expect(rel).toMatch(/^generations\/gen-0003\//);

    const loaded = readReplay(tmp, 3, 'gen0003-cand-vs-ref-aggressive');
    expect(loaded.matchId).toBe('gen0003-cand-vs-ref-aggressive');
    expect(loaded.frames.length).toBe(2);
    expect(loaded.shipReports[0].cpuNanosTotal).toBe('12345');
  });

  it('rejects path-traversal in matchId', () => {
    expect(() => readReplay(tmp, 1, '../../etc/passwd')).toThrow();
    expect(() => readReplay(tmp, 1, 'foo/bar')).toThrow();
  });
});

describe('manifest round-trip', () => {
  it('creates, appends, and reorders generations', () => {
    expect(loadManifest(tmp)).toBeNull();

    appendGenerationToManifest(tmp, {
      runId: 'run-A',
      arena: 'asteroids',
      sanitizedConfig: { foo: 1 } as never,
      entry: { generation: 1, bestFitness: 0.5, bestShipId: 's1', replays: [] },
      leaderboard: [],
      mapElitesGrid: [],
      generationStats: {
        generation: 1,
        bestFitness: 0.5,
        bestWinRate: 0.4,
        meanFitness: 0.3,
        meanFuel: 1000,
        archiveSize: 1,
      },
    });

    appendGenerationToManifest(tmp, {
      runId: 'run-A',
      arena: 'asteroids',
      sanitizedConfig: { foo: 1 } as never,
      entry: { generation: 0, bestFitness: 0.1, bestShipId: 's0', replays: [] },
      leaderboard: [],
      mapElitesGrid: [],
      generationStats: {
        generation: 0,
        bestFitness: 0.1,
        bestWinRate: 0.05,
        meanFitness: 0.1,
        meanFuel: 500,
        archiveSize: 1,
      },
    });

    const m = loadManifest(tmp)!;
    expect(m.schema).toBe(1);
    expect(m.runId).toBe('run-A');
    expect(m.generations.map((g) => g.generation)).toEqual([0, 1]);
    expect(m.generationStats.map((s) => s.generation)).toEqual([0, 1]);
  });

  it('replaces an existing generation entry rather than duplicating', () => {
    appendGenerationToManifest(tmp, {
      runId: 'run-B',
      arena: 'asteroids',
      sanitizedConfig: {} as never,
      entry: { generation: 5, bestFitness: 0.2, bestShipId: 'a', replays: [] },
      leaderboard: [],
      mapElitesGrid: [],
      generationStats: {
        generation: 5,
        bestFitness: 0.2,
        bestWinRate: 0.1,
        meanFitness: 0.15,
        meanFuel: 700,
        archiveSize: 1,
      },
    });
    appendGenerationToManifest(tmp, {
      runId: 'run-B',
      arena: 'asteroids',
      sanitizedConfig: {} as never,
      entry: {
        generation: 5,
        bestFitness: 0.9,
        bestShipId: 'b',
        replays: [
          { path: 'p', shipId: 'b', opponent: 'ref-x', fitness: 0.9, durationTicks: 10 },
        ],
      },
      leaderboard: [],
      mapElitesGrid: [
        { aggressionBucket: 1, fuelBucket: 2, fitness: 0.9, shipId: 'b', generation: 5 },
      ],
      generationStats: {
        generation: 5,
        bestFitness: 0.9,
        bestWinRate: 0.5,
        meanFitness: 0.6,
        meanFuel: 800,
        archiveSize: 1,
      },
    });

    const m = loadManifest(tmp)!;
    expect(m.generations.length).toBe(1);
    expect(m.generations[0].bestShipId).toBe('b');
    expect(m.generations[0].replays.length).toBe(1);
    expect(m.mapElitesGrid.length).toBe(1);
    expect(m.mapElitesGrid[0].shipId).toBe('b');
    expect(m.generationStats[0].bestFitness).toBeCloseTo(0.9);
  });
});

describe('pruneOldGenerations', () => {
  function withGen(generation: number, matchId: string) {
    writeReplay(tmp, makeReplay(generation, matchId));
  }

  it('is a no-op when fewer generations exist than the cap', () => {
    withGen(0, 'm0');
    withGen(1, 'm1');
    const deleted = pruneOldGenerations(tmp, 5);
    expect(deleted).toEqual([]);
  });

  it('drops the oldest directories beyond the cap', () => {
    withGen(0, 'm0');
    withGen(1, 'm1');
    withGen(2, 'm2');
    withGen(3, 'm3');
    const deleted = pruneOldGenerations(tmp, 2);
    expect(deleted.sort((a, b) => a - b)).toEqual([0, 1]);
    expect(existsSync(join(tmp, 'generations', 'gen-0000'))).toBe(false);
    expect(existsSync(join(tmp, 'generations', 'gen-0001'))).toBe(false);
    expect(existsSync(join(tmp, 'generations', 'gen-0002'))).toBe(true);
    expect(existsSync(join(tmp, 'generations', 'gen-0003'))).toBe(true);
  });

  it('returns an empty list when the generations dir is absent', () => {
    expect(pruneOldGenerations(tmp, 5)).toEqual([]);
  });

  it('keepRecent <= 0 is a no-op', () => {
    withGen(0, 'm0');
    expect(pruneOldGenerations(tmp, 0)).toEqual([]);
    expect(existsSync(join(tmp, 'generations', 'gen-0000'))).toBe(true);
  });
});

describe('safeArchivePath', () => {
  it('resolves clean paths within the archive root', () => {
    const result = safeArchivePath(tmp, 'generations', 'gen-0001', 'match.json');
    expect(result.startsWith(tmp)).toBe(true);
    expect(result.endsWith('match.json')).toBe(true);
  });

  it('rejects parent-directory traversal', () => {
    expect(() => safeArchivePath(tmp, '..', 'etc', 'passwd')).toThrow(/escape/i);
  });

  it('rejects mixed-case traversal', () => {
    expect(() => safeArchivePath(tmp, 'foo', '..', '..', '..', 'etc')).toThrow(/escape/i);
  });
});
