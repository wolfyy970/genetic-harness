/**
 * Tests for src/replay/recorder.ts.
 *
 * Exercises sampling, frame cap, and finalize-from-MatchReport. No
 * isolate-vm dependency — feeds synthetic GameStates and a stub arena.
 */

import { describe, it, expect } from 'vitest';
import { JsonReplayRecorder } from '../src/replay/recorder.js';
import type {
  ArenaPlugin,
  BotAction,
  GameConfig,
  GameState,
  ReplayFrame,
} from '../src/shared/types.js';
import type { MatchReport, ShipReport } from '../src/orchestrator/match.js';

const STUB_CONFIG: GameConfig = {
  worldWidth: 100,
  worldHeight: 100,
  seed: 1,
  asteroidCount: 0,
  tickMs: 50,
  maxBulletsPerShip: 1,
  bulletSpeed: 1,
  shipThrust: 0.1,
  shipRotationSpeed: 0.1,
  shipMaxFuel: 100,
  asteroidBaseRadius: 10,
  asteroidSpeed: 1,
};

function stubArena(): ArenaPlugin {
  return {
    init: () => ({
      tick: 0,
      worldWidth: 100,
      worldHeight: 100,
      seed: 1,
      ships: [],
      asteroids: [],
      bullets: [],
      config: STUB_CONFIG,
    }),
    tick: (s: GameState, _a: Map<string, BotAction>) => ({ ...s, tick: s.tick + 1 }),
    score: () => 0,
    renderer: (s: GameState): ReplayFrame => ({
      type: 'asteroids',
      tick: s.tick,
      entities: [],
    }),
  };
}

function stubReport(durationTicks: number): MatchReport {
  const ship: ShipReport = {
    shipId: 'ship-0',
    score: 7,
    ticksAlive: durationTicks,
    cpuNanosTotal: 12_345n,
    cpuNanosMax: 999n,
    histogram: { thrust: 1, rotate: 2, fire: 3, wait: 4, invalid: 0 },
    survived: true,
  };
  return { ships: [ship], durationTicks, endedByElimination: false };
}

function makeState(tick: number): GameState {
  return {
    tick,
    worldWidth: 100,
    worldHeight: 100,
    seed: 1,
    ships: [],
    asteroids: [],
    bullets: [],
    config: STUB_CONFIG,
  };
}

describe('JsonReplayRecorder', () => {
  it('records one frame per tick by default', () => {
    const r = new JsonReplayRecorder({
      arena: stubArena(),
      arenaName: 'asteroids',
      generation: 0,
      matchId: 'm',
      participants: [],
      config: STUB_CONFIG,
    });
    for (let t = 0; t < 5; t++) r.onTick(makeState(t));
    expect(r.frameCount()).toBe(5);
  });

  it('respects sampleEvery: only every Nth tick is captured', () => {
    const r = new JsonReplayRecorder({
      arena: stubArena(),
      arenaName: 'asteroids',
      generation: 0,
      matchId: 'm',
      participants: [],
      config: STUB_CONFIG,
      sampleEvery: 3,
    });
    for (let t = 0; t < 10; t++) r.onTick(makeState(t));
    // Frames captured at internal tickCounter = 3, 6, 9 → 3 frames.
    expect(r.frameCount()).toBe(3);
  });

  it('caps stored frames at maxFrames', () => {
    const r = new JsonReplayRecorder({
      arena: stubArena(),
      arenaName: 'asteroids',
      generation: 0,
      matchId: 'm',
      participants: [],
      config: STUB_CONFIG,
      maxFrames: 4,
    });
    for (let t = 0; t < 100; t++) r.onTick(makeState(t));
    expect(r.frameCount()).toBe(4);
  });

  it('finalize stringifies bigints in shipReports and includes all frames', () => {
    const r = new JsonReplayRecorder({
      arena: stubArena(),
      arenaName: 'asteroids',
      generation: 12,
      matchId: 'gen0012-elite-vs-ref',
      participants: [
        { shipId: 'ship-0', role: 'candidate', refId: 'cand-1' },
        { shipId: 'ship-1', role: 'reference', refId: 'ref-aggressive' },
      ],
      config: STUB_CONFIG,
    });
    for (let t = 0; t < 3; t++) r.onTick(makeState(t));
    const file = r.finalize(stubReport(3));

    expect(file.schema).toBe(1);
    expect(file.arena).toBe('asteroids');
    expect(file.generation).toBe(12);
    expect(file.matchId).toBe('gen0012-elite-vs-ref');
    expect(file.frames.length).toBe(3);
    expect(file.shipReports[0].cpuNanosTotal).toBe('12345');
    expect(file.shipReports[0].cpuNanosMax).toBe('999');
    expect(file.shipReports[0].histogram.fire).toBe(3);
    expect(file.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('clamps sampleEvery and maxFrames to >= 1', () => {
    const r = new JsonReplayRecorder({
      arena: stubArena(),
      arenaName: 'asteroids',
      generation: 0,
      matchId: 'm',
      participants: [],
      config: STUB_CONFIG,
      sampleEvery: 0,
      maxFrames: 0,
    });
    for (let t = 0; t < 5; t++) r.onTick(makeState(t));
    expect(r.frameCount()).toBe(1); // maxFrames clamped to 1
  });
});
