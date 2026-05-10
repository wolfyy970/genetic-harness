/**
 * Integration test: bundle a bot, run it inside an isolated-vm isolate,
 * and verify the tick function actually executes and returns an action.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { bundle } from '../src/runtime/bundler.js';
import { IsolatePool } from '../src/runtime/isolate.js';
import type { BotState } from '../src/shared/types.js';

const SAMPLE_BOT_STATE: BotState = {
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
  asteroids: [],
  opponents: [],
  bullets: [],
  score: 0,
  tick: 0,
};

describe('Bot execution inside isolate', () => {
  let pool: IsolatePool | null = null;

  afterEach(() => {
    if (pool) {
      pool.cleanup();
      pool = null;
    }
  });

  it('runs a fire-on-every-tick bot and returns the fire action', () => {
    pool = new IsolatePool();
    const source = `function tick(s) { return { type: 'fire' }; }`;
    const bundled = bundle(source);
    expect(bundled).not.toContain('Compilation error');

    const compiled = pool.compileBot(bundled);
    const result = pool.runTick(compiled, SAMPLE_BOT_STATE, 100, 0);
    expect(result.error).toBeUndefined();
    expect(result.action).toEqual({ type: 'fire' });
  }, 10_000);

  it('runs a position-aware bot that fires when opponents are close', () => {
    pool = new IsolatePool();
    const source = `
      function tick(s) {
        if (s.opponents.length === 0) return { type: 'wait' };
        const o = s.opponents[0];
        const dx = o.pos.x - s.ship.pos.x;
        const dy = o.pos.y - s.ship.pos.y;
        const d = Math.sqrt(dx*dx + dy*dy);
        if (d < 200) return { type: 'fire' };
        return { type: 'rotate', direction: 1 };
      }
    `;
    const bundled = bundle(source);
    const compiled = pool.compileBot(bundled);

    const stateNoOpponents = { ...SAMPLE_BOT_STATE, opponents: [] };
    const r1 = pool.runTick(compiled, stateNoOpponents, 100, 0);
    expect(r1.action).toEqual({ type: 'wait' });

    const stateNearby = {
      ...SAMPLE_BOT_STATE,
      opponents: [{ ...SAMPLE_BOT_STATE.ship, id: 'ship-1', pos: { x: 150, y: 100 } }],
    };
    const r2 = pool.runTick(compiled, stateNearby, 100, 1);
    expect(r2.action).toEqual({ type: 'fire' });
  }, 10_000);

  it('reports nonzero cpuNanos for compute-heavy ticks', () => {
    pool = new IsolatePool();
    const source = `function tick(s) {
      let x = 0;
      for (let i = 0; i < 10000; i++) x += i * i;
      return { type: 'wait' };
    }`;
    const bundled = bundle(source);
    const compiled = pool.compileBot(bundled);
    const result = pool.runTick(compiled, SAMPLE_BOT_STATE, 100, 0);
    expect(result.action).toEqual({ type: 'wait' });
    expect(result.cpuNanos).toBeGreaterThan(0n);
  }, 10_000);

  it('rejects bots that do not define globalThis.tick', () => {
    pool = new IsolatePool();
    const source = `var noopBot = 1;`;
    const bundled = bundle(source);
    expect(() => pool!.compileBot(bundled)).toThrow(
      /globalThis\.tick/i,
    );
  }, 10_000);

  it('handles bot crashes without poisoning the isolate', () => {
    pool = new IsolatePool();
    const source = `
      function tick(s) {
        if (s.tick === 0) throw new Error('boom');
        return { type: 'wait' };
      }
    `;
    const bundled = bundle(source);
    const compiled = pool.compileBot(bundled);

    const r1 = pool.runTick(compiled, { ...SAMPLE_BOT_STATE, tick: 0 }, 100, 0);
    expect(r1.action).toBeNull();
    expect(r1.error).toMatch(/boom/);

    const r2 = pool.runTick(compiled, { ...SAMPLE_BOT_STATE, tick: 1 }, 100, 1);
    expect(r2.action).toEqual({ type: 'wait' });
  }, 10_000);
});
