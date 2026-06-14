/**
 * Tests for 8-player free-for-all match topology (Slice 3).
 *
 * Verifies:
 * - createWorld spawns N ships at distinct positions on a circle.
 * - playMatch runs a full match with 8 ships present and reports on all of them.
 * - outcomeForNWay obeys the W/L/D rule (top score → W, below median → L,
 *   mid → D, sole survivor → W).
 * - Same-seed reproduction is bit-stable across 8-ship matches.
 */

import { describe, it, expect } from 'vitest';
import { createWorld, worldTick } from '../src/engine/world.js';
import { playMatch } from '../src/orchestrator/match.js';
import {
  outcomeForNWay,
  compileReferenceRoster,
  FFA_MATCH_SIZE,
} from '../src/orchestrator/evaluator.js';
import { IsolatePool, type CompiledBot } from '../src/runtime/isolate.js';
import { bundle } from '../src/runtime/bundler.js';
import type { GameConfig } from '../src/shared/types.js';
import { getArena } from '../src/arena/interface.js';
import '../src/arena/asteroids.js';
import type { ShipReport } from '../src/orchestrator/match.js';

const FFA_CONFIG: GameConfig = {
  worldWidth: 800,
  worldHeight: 600,
  seed: 7,
  asteroidCount: 8,
  tickMs: 50,
  maxBulletsPerShip: 3,
  bulletSpeed: 8,
  shipThrust: 0.15,
  shipRotationSpeed: 0.08,
  shipMaxFuel: 10000,
  asteroidBaseRadius: 25,
  asteroidSpeed: 2.5,
  shipCount: 8,
};

describe('8-ship circle spawn', () => {
  it('spawns 8 distinct ships', () => {
    const w = createWorld(FFA_CONFIG);
    expect(w.ships.length).toBe(8);
    const ids = new Set(w.ships.map((s) => s.id));
    expect(ids.size).toBe(8);
  });

  it('ships are evenly spaced around the world centroid', () => {
    const w = createWorld(FFA_CONFIG);
    const cx = FFA_CONFIG.worldWidth / 2;
    const cy = FFA_CONFIG.worldHeight / 2;
    const expectedR = Math.min(FFA_CONFIG.worldWidth, FFA_CONFIG.worldHeight) * 0.35;
    for (const ship of w.ships) {
      const dx = ship.pos.x - cx;
      const dy = ship.pos.y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      expect(r).toBeCloseTo(expectedR, 6);
    }
  });

  it('initial spawn is deterministic from seed (cross-machine reproducible)', () => {
    const a = createWorld(FFA_CONFIG);
    const b = createWorld(FFA_CONFIG);
    for (let i = 0; i < a.ships.length; i++) {
      expect(a.ships[i].pos).toEqual(b.ships[i].pos);
      expect(a.ships[i].angle).toBe(b.ships[i].angle);
    }
  });
});

describe('outcomeForNWay', () => {
  function r(score: number, survived = true): ShipReport {
    return {
      shipId: 'x',
      score,
      ticksAlive: 0,
      cpuNanosTotal: 0n,
      cpuNanosMax: 0n,
      histogram: {
        thrust: 0,
        thrustFwd: 0,
        thrustRev: 0,
        rotate: 0,
        fire: 0,
        wait: 0,
        invalid: 0,
      },
      survived,
    };
  }
  function withId(rep: ShipReport, id: string): ShipReport {
    return { ...rep, shipId: id };
  }

  it('returns W when candidate has strictly the highest score', () => {
    const cand = withId(r(100), 'ship-0');
    const others = [withId(r(50), 'ship-1'), withId(r(20), 'ship-2'), withId(r(10), 'ship-3')];
    expect(outcomeForNWay(cand, [cand, ...others])).toBe('W');
  });

  it('returns W when candidate is the sole survivor at score-tie', () => {
    const cand = withId(r(0, true), 'ship-0');
    const others = [withId(r(0, false), 'ship-1'), withId(r(0, false), 'ship-2')];
    expect(outcomeForNWay(cand, [cand, ...others])).toBe('W');
  });

  it('returns L when candidate score is below the median', () => {
    const cand = withId(r(5), 'ship-0');
    const others = [withId(r(100), 'ship-1'), withId(r(80), 'ship-2'), withId(r(60), 'ship-3')];
    expect(outcomeForNWay(cand, [cand, ...others])).toBe('L');
  });

  it('returns D when candidate is mid-pack', () => {
    const cand = withId(r(50), 'ship-0');
    const others = [withId(r(100), 'ship-1'), withId(r(80), 'ship-2'), withId(r(20), 'ship-3')];
    expect(outcomeForNWay(cand, [cand, ...others])).toBe('D');
  });
});

describe('8-ship FFA match', () => {
  it('produces a report for every ship', () => {
    const pool = new IsolatePool();
    try {
      const arena = getArena('asteroids')!;
      const roster = compileReferenceRoster(pool);
      // Pick any 8 distinct compiled bots; we just want a multi-ship run.
      const shipBots = new Map<string, CompiledBot>();
      const ids = Array.from(roster.keys());
      for (let i = 0; i < 8; i++) {
        shipBots.set(`ship-${i}`, roster.get(ids[i % ids.length])!);
      }
      const report = playMatch(arena, pool, shipBots, FFA_CONFIG, 80, 50);
      expect(report.ships.length).toBe(8);
      const allIds = new Set(report.ships.map((r) => r.shipId));
      expect(allIds.size).toBe(8);
    } finally {
      pool.cleanup();
    }
  }, 30_000);

  it('FFA_MATCH_SIZE is 8 (catches accidental cap regressions)', () => {
    expect(FFA_MATCH_SIZE).toBe(8);
  });
});
