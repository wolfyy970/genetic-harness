/**
 * Tests for `recordEliteReplays` — the FFA + self-play recorder that
 * Slice 1 of the web-client overhaul put in place.
 *
 * Verifies:
 *   - FFA matches record 8 ship reports (1 candidate + 7 roster opponents).
 *   - Each FFA match generates one file per seed (default 3 seeds).
 *   - Manifest entries carry the new `seed`, `topology`, and `ranks` fields.
 *   - A non-empty `selfPlayPool` triggers an extra self-play match per
 *     elite; empty pool → no self-play match.
 *   - Participants role is `archived-elite` for self-play peers, `reference`
 *     for roster fill.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordEliteReplays } from '../src/replay/elite-replays.js';
import { compileBotSet } from '../src/orchestrator/evaluator.js';
import { SEED_TEMPLATES } from '../src/orchestrator/reference.js';
import { IsolatePool } from '../src/runtime/isolate.js';
import { loadConfig } from '../src/shared/config.js';
import { getArena } from '../src/arena/interface.js';
import '../src/arena/asteroids.js';
import type { ArchivedBot, FitnessResult } from '../src/shared/types.js';
import type { ReplayFile } from '../src/replay/types.js';

let tmpArchive: string;
let pool: IsolatePool;

beforeEach(() => {
  tmpArchive = mkdtempSync(join(tmpdir(), 'genharness-replays-'));
  pool = new IsolatePool();
});

afterEach(() => {
  pool.cleanup();
  rmSync(tmpArchive, { recursive: true, force: true });
});

function zeroFitness(id: string): FitnessResult {
  return {
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
    fitnessScore: 0.5,
  };
}

function makeElite(id: string, source: string): ArchivedBot {
  return {
    id,
    source,
    shipId: id,
    fitness: zeroFitness(id),
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

const SIMPLE_FIRE_BOT = `function tick(s) { return { type: 'fire' }; }`;
const SIMPLE_WAIT_BOT = `function tick(s) { return { type: 'wait' }; }`;

/**
 * Build a 7-bot opponent pool (Cartesian shape: matches the FFA slot count
 * minus the candidate). Drawn from SEED_TEMPLATES excluding 'ref-null'
 * since the no-op wait bot doesn't shape a meaningful match.
 */
function makeOpponentPool(): { opponentPool: any[]; opponentIds: string[] } {
  const templates = SEED_TEMPLATES.filter((t) => t.id !== 'ref-null').slice(0, 7);
  const compiledMap = compileBotSet(pool, templates);
  const opponentPool: any[] = [];
  const opponentIds: string[] = [];
  for (const t of templates) {
    const bot = compiledMap.get(t.id);
    if (bot) {
      opponentPool.push(bot);
      opponentIds.push(t.id);
    }
  }
  return { opponentPool, opponentIds };
}

describe('recordEliteReplays — FFA topology', () => {
  it('writes one FFA replay per (elite × seed) with 8 ship reports each', () => {
    const arena = getArena('asteroids')!;
    const { opponentPool, opponentIds } = makeOpponentPool();
    const config = loadConfig({
      llmBaseUrl: 'mock',
      recordReplays: true,
      replayMaxFrames: 50,
      replaySampleEvery: 5,
    });

    const elite = makeElite('elite-1', SIMPLE_FIRE_BOT);
    const entry = recordEliteReplays({
      arena,
      arenaName: 'asteroids',
      pool,
      opponentPool,
      opponentIds,
      elites: [elite],
      generation: 0,
      archiveDir: tmpArchive,
      config,
    });

    // 3 seeds × 1 elite × 1 FFA match each = 3 replay files.
    expect(entry.replays.length).toBe(3);
    for (const r of entry.replays) {
      expect(r.topology).toBe('ffa');
      expect(typeof r.seed).toBe('number');
      expect(r.ranks).toBeDefined();
      expect(r.ranks!.length).toBe(8);
    }
  }, 60_000);

  it('each FFA replay JSON file contains 8 participants and 8 ship reports', () => {
    const arena = getArena('asteroids')!;
    const { opponentPool, opponentIds } = makeOpponentPool();
    const config = loadConfig({
      llmBaseUrl: 'mock',
      recordReplays: true,
      replayMaxFrames: 30,
      replaySampleEvery: 10,
    });

    const elite = makeElite('elite-x', SIMPLE_FIRE_BOT);
    const entry = recordEliteReplays({
      arena,
      arenaName: 'asteroids',
      pool,
      opponentPool,
      opponentIds,
      elites: [elite],
      generation: 1,
      archiveDir: tmpArchive,
      config,
    });

    expect(entry.replays.length).toBeGreaterThan(0);
    const replayPath = join(tmpArchive, entry.replays[0].path);
    expect(existsSync(replayPath)).toBe(true);
    const file = JSON.parse(readFileSync(replayPath, 'utf8')) as ReplayFile;
    expect(file.schema).toBe(4);
    expect(file.participants.length).toBe(8);
    expect(file.shipReports.length).toBe(8);
    // ship-0 is the candidate by convention.
    expect(file.participants[0].shipId).toBe('ship-0');
    expect(file.participants[0].role).toBe('candidate');
    // Remaining 7 come from the (population) opponent pool, now tagged
    // 'archived-elite' (formerly 'reference' — the frozen-roster idea is gone).
    for (let i = 1; i < file.participants.length; i++) {
      expect(file.participants[i].role).toBe('archived-elite');
    }
  }, 60_000);
});

describe('recordEliteReplays — self-play topology', () => {
  it('skips self-play when selfPlayPool is empty', () => {
    const arena = getArena('asteroids')!;
    const { opponentPool, opponentIds } = makeOpponentPool();
    const config = loadConfig({
      llmBaseUrl: 'mock',
      recordReplays: true,
      replayMaxFrames: 30,
      replaySampleEvery: 10,
    });

    const elite = makeElite('only-elite', SIMPLE_FIRE_BOT);
    const entry = recordEliteReplays({
      arena,
      arenaName: 'asteroids',
      pool,
      opponentPool,
      opponentIds,
      elites: [elite],
      generation: 0,
      archiveDir: tmpArchive,
      config,
      selfPlayPool: [],
    });

    // All replays should be FFA, none self-play.
    expect(entry.replays.every((r) => r.topology === 'ffa')).toBe(true);
  }, 60_000);

  it('records a self-play match per elite when selfPlayPool is non-empty', () => {
    const arena = getArena('asteroids')!;
    const { opponentPool, opponentIds } = makeOpponentPool();
    const config = loadConfig({
      llmBaseUrl: 'mock',
      recordReplays: true,
      replayMaxFrames: 30,
      replaySampleEvery: 10,
    });

    const elite = makeElite('cand', SIMPLE_FIRE_BOT);
    const peer = makeElite('peer-1', SIMPLE_WAIT_BOT);

    const entry = recordEliteReplays({
      arena,
      arenaName: 'asteroids',
      pool,
      opponentPool,
      opponentIds,
      elites: [elite],
      generation: 0,
      archiveDir: tmpArchive,
      config,
      selfPlayPool: [peer],
    });

    const selfPlay = entry.replays.filter((r) => r.topology === 'selfplay');
    expect(selfPlay.length).toBe(1);

    // Self-play file: 1 candidate + 1 explicit archived-elite peer + 6
    // population-fill (also tagged archived-elite since the frozen-roster
    // concept is gone). 8 participants total.
    const file = JSON.parse(
      readFileSync(join(tmpArchive, selfPlay[0].path), 'utf8'),
    ) as ReplayFile;
    expect(file.participants.length).toBe(8);
    const archived = file.participants.filter((p) => p.role === 'archived-elite');
    const candidate = file.participants.filter((p) => p.role === 'candidate');
    expect(candidate.length).toBe(1);
    expect(archived.length).toBe(7);
  }, 60_000);

  it('manifest entry includes seed + topology + ranks fields', () => {
    const arena = getArena('asteroids')!;
    const { opponentPool, opponentIds } = makeOpponentPool();
    const config = loadConfig({
      llmBaseUrl: 'mock',
      recordReplays: true,
      replayMaxFrames: 30,
      replaySampleEvery: 10,
    });

    const elite = makeElite('cand', SIMPLE_FIRE_BOT);
    const peer = makeElite('peer', SIMPLE_WAIT_BOT);
    const entry = recordEliteReplays({
      arena,
      arenaName: 'asteroids',
      pool,
      opponentPool,
      opponentIds,
      elites: [elite],
      generation: 5,
      archiveDir: tmpArchive,
      config,
      selfPlayPool: [peer],
    });

    for (const r of entry.replays) {
      expect(r.seed).toBeTypeOf('number');
      expect(['ffa', 'selfplay']).toContain(r.topology);
      expect(Array.isArray(r.ranks)).toBe(true);
      expect(r.ranks!.length).toBe(8);
      // Ranks should be unique 1..8.
      const rankNumbers = r.ranks!.map((x) => x.rank).sort((a, b) => a - b);
      expect(rankNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
  }, 60_000);
});
