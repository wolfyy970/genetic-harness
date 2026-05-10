/**
 * Tests for the frozen reference roster: every scripted bot must compile
 * and produce a valid action when called with a representative state.
 *
 * If any of these fail, the entire evaluator cascade is broken — every
 * candidate evaluation rests on the roster booting cleanly.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { REFERENCE_ROSTER } from '../src/orchestrator/reference.js';
import { compileReferenceRoster } from '../src/orchestrator/evaluator.js';
import { IsolatePool } from '../src/runtime/isolate.js';
import type { BotState } from '../src/shared/types.js';

const SAMPLE_STATE: BotState = {
  ship: {
    id: 'ship-0',
    type: 'ship',
    pos: { x: 100, y: 100 },
    vel: { x: 0, y: 0 },
    angle: 0,
    angularVel: 0,
    thrust: false,
    thrustAngle: 0,
    fuel: 1000,
    shields: 100,
    health: 100,
    score: 0,
  },
  nearbyEntities: [],
  asteroids: [
    {
      id: 'a1',
      type: 'asteroid',
      pos: { x: 200, y: 200 },
      vel: { x: 0, y: 0 },
      radius: 25,
      health: 2,
      mass: 1,
    },
  ],
  opponents: [
    {
      id: 'ship-1',
      type: 'ship',
      pos: { x: 300, y: 300 },
      vel: { x: 0, y: 0 },
      angle: Math.PI,
      angularVel: 0,
      thrust: false,
      thrustAngle: 0,
      fuel: 1000,
      shields: 100,
      health: 100,
      score: 0,
    },
  ],
  bullets: [],
  score: 0,
  tick: 0,
};

const VALID_TYPES = new Set(['thrust', 'rotate', 'fire', 'wait']);

describe('Reference roster', () => {
  let pool: IsolatePool | null = null;

  afterEach(() => {
    if (pool) {
      pool.cleanup();
      pool = null;
    }
  });

  it('contains the four expected scripted bots in stable order', () => {
    expect(REFERENCE_ROSTER.map((b) => b.id)).toEqual([
      'ref-null',
      'ref-random',
      'ref-aggressive',
      'ref-evasive',
    ]);
  });

  it('compiles every reference bot into the pool', () => {
    pool = new IsolatePool();
    const compiled = compileReferenceRoster(pool);
    expect(compiled.size).toBe(REFERENCE_ROSTER.length);
    for (const bot of REFERENCE_ROSTER) {
      expect(compiled.has(bot.id)).toBe(true);
    }
  });

  it('every compiled reference bot returns a valid action on a representative state', () => {
    pool = new IsolatePool();
    const compiled = compileReferenceRoster(pool);
    for (const [id, bot] of compiled) {
      const result = pool.runTick(bot, SAMPLE_STATE, 100, 0);
      expect(result.error, `bot ${id} crashed: ${result.error}`).toBeUndefined();
      expect(result.action, `bot ${id} returned null action`).not.toBeNull();
      expect(VALID_TYPES.has(result.action!.type)).toBe(true);
    }
  });

  it('the aggressive bot fires when an opponent is in line', () => {
    pool = new IsolatePool();
    const compiled = compileReferenceRoster(pool);
    const aggro = compiled.get('ref-aggressive')!;
    // Opponent directly to the right — ship is angle=0 (facing +x).
    const aligned: BotState = {
      ...SAMPLE_STATE,
      opponents: [{ ...SAMPLE_STATE.opponents[0], pos: { x: 400, y: 100 } }],
    };
    const result = pool.runTick(aggro, aligned, 100, 0);
    expect(result.action).toEqual({ type: 'fire' });
  });
});
