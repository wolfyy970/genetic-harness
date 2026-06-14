/**
 * Tests for the new ship-relative thrust semantics.
 *
 * Slice 1 of the real-Asteroids overhaul replaced `thrust { angle }` with
 * `thrust { direction: 1 | -1 }`. Forward thrust accelerates along
 * ship.angle; reverse thrust along ship.angle + π. Linear friction is zero —
 * momentum is preserved.
 */

import { describe, it, expect } from 'vitest';
import { createWorld, worldTick } from '../src/engine/world.js';
import type { GameConfig } from '../src/shared/types.js';

const BASE_CONFIG: GameConfig = {
  worldWidth: 1200,
  worldHeight: 800,
  seed: 1,
  asteroidCount: 0,
  tickMs: 50,
  maxBulletsPerShip: 3,
  bulletSpeed: 8,
  shipThrust: 0.15,
  shipRotationSpeed: 0.08,
  shipMaxFuel: 10000,
  asteroidBaseRadius: 25,
  asteroidSpeed: 2.5,
  shipCount: 1,
};

describe('Ship-relative thrust', () => {
  it('forward thrust accelerates along ship.angle', () => {
    const world = createWorld(BASE_CONFIG);
    // Aim due east.
    world.ships[0].angle = 0;
    world.ships[0].vel = { x: 0, y: 0 };
    const actions = new Map<string, any>([
      [world.ships[0].id, { type: 'thrust', direction: 1 }],
    ]);
    const next = worldTick(world, actions);
    expect(next.ships[0].vel.x).toBeGreaterThan(0);
    expect(Math.abs(next.ships[0].vel.y)).toBeLessThan(1e-6);
  });

  it('reverse thrust accelerates along ship.angle + π', () => {
    const world = createWorld(BASE_CONFIG);
    world.ships[0].angle = 0;
    world.ships[0].vel = { x: 0, y: 0 };
    const actions = new Map<string, any>([
      [world.ships[0].id, { type: 'thrust', direction: -1 }],
    ]);
    const next = worldTick(world, actions);
    expect(next.ships[0].vel.x).toBeLessThan(0);
    expect(Math.abs(next.ships[0].vel.y)).toBeLessThan(1e-6);
  });

  it('forward and reverse cost fuel at the same rate', () => {
    const fwdWorld = createWorld(BASE_CONFIG);
    fwdWorld.ships[0].angle = 0;
    fwdWorld.ships[0].vel = { x: 0, y: 0 };
    const fwd = worldTick(
      fwdWorld,
      new Map<string, any>([[fwdWorld.ships[0].id, { type: 'thrust', direction: 1 }]]),
    );
    const revWorld = createWorld(BASE_CONFIG);
    revWorld.ships[0].angle = 0;
    revWorld.ships[0].vel = { x: 0, y: 0 };
    const rev = worldTick(
      revWorld,
      new Map<string, any>([[revWorld.ships[0].id, { type: 'thrust', direction: -1 }]]),
    );
    const fwdBurn = BASE_CONFIG.shipMaxFuel - fwd.ships[0].fuel;
    const revBurn = BASE_CONFIG.shipMaxFuel - rev.ships[0].fuel;
    expect(Math.abs(fwdBurn - revBurn)).toBeLessThan(1e-6);
  });

  it('zero linear friction: momentum is preserved over many ticks', () => {
    const world = createWorld({ ...BASE_CONFIG, asteroidCount: 0, shipCount: 1 });
    world.ships[0].pos = { x: 600, y: 400 };
    world.ships[0].angle = 0;
    world.ships[0].vel = { x: 1.0, y: 0 };
    let state = world;
    for (let i = 0; i < 1000; i++) {
      state = worldTick(state, new Map());
    }
    // Velocity should be effectively unchanged (zero friction).
    expect(state.ships[0].vel.x).toBeCloseTo(1.0, 6);
    expect(Math.abs(state.ships[0].vel.y)).toBeLessThan(1e-6);
  });

  it('rotation still damps angularVel (rotational input is impulse-based)', () => {
    const world = createWorld(BASE_CONFIG);
    world.ships[0].angle = 0;
    world.ships[0].angularVel = 0.5; // high spin
    let state = world;
    for (let i = 0; i < 40; i++) {
      state = worldTick(state, new Map());
    }
    // Angular damping (0.9 per tick) means angularVel decays toward zero
    // (0.5 * 0.9^40 ≈ 7.4e-3).
    expect(Math.abs(state.ships[0].angularVel)).toBeLessThan(0.01);
  });
});
