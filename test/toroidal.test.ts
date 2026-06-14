/**
 * Tests for toroidal-world distance + local-frame BotState delivery.
 *
 * The world wraps. Two consequences must hold:
 *   1. Collision distance is the *shortest* path across the wrap, so a
 *      bullet at x=799 collides with a target at x=1 in the same tick.
 *   2. `buildBotState` delivers opponents/asteroids/bullets in the
 *      viewer's local frame: `o.pos.x - ship.pos.x` is the toroidal-
 *      shortest signed delta, no matter where the seam falls.
 */

import { describe, it, expect } from 'vitest';
import { toroidalDelta, toroidalDist, dist } from '../src/engine/utils.js';
import { buildBotState, createWorld, worldTick } from '../src/engine/world.js';
import { detectCollisions } from '../src/engine/collision.js';
import type { GameConfig } from '../src/shared/types.js';

const CONFIG: GameConfig = {
  worldWidth: 800,
  worldHeight: 600,
  seed: 11,
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

describe('toroidalDelta / toroidalDist', () => {
  it('agrees with plain Cartesian when no wrap is required', () => {
    const a = { x: 100, y: 100 };
    const b = { x: 250, y: 180 };
    const td = toroidalDist(a, b, 800, 600);
    expect(td).toBeCloseTo(dist(a, b), 6);
  });

  it('treats two points across the right/left seam as toroidally near', () => {
    // 5 px from the right edge → 5 px after wrap from the left edge.
    const a = { x: 795, y: 300 };
    const b = { x: 5, y: 300 };
    expect(toroidalDist(a, b, 800, 600)).toBe(10);
    expect(toroidalDist(b, a, 800, 600)).toBe(10);
  });

  it('treats two points across the top/bottom seam as toroidally near', () => {
    const a = { x: 400, y: 595 };
    const b = { x: 400, y: 5 };
    expect(toroidalDist(a, b, 800, 600)).toBe(10);
  });

  it('returns the shortest signed delta in both axes', () => {
    // a at (790, 590), b at (10, 10). Without wrap the delta is (-780, -580);
    // with wrap the shortest is (+20, +20).
    const a = { x: 790, y: 590 };
    const b = { x: 10, y: 10 };
    const { dx, dy } = toroidalDelta(a, b, 800, 600);
    expect(dx).toBe(20);
    expect(dy).toBe(20);
  });

  it('chooses the non-wrap delta when no seam-crossing is shorter', () => {
    const a = { x: 100, y: 100 };
    const b = { x: 250, y: 250 };
    const { dx, dy } = toroidalDelta(a, b, 800, 600);
    expect(dx).toBe(150);
    expect(dy).toBe(150);
  });
});

describe('toroidal collisions', () => {
  it('a bullet at x=799 hits a target at x=1 in the same tick (across seam)', () => {
    const world = createWorld({ ...CONFIG, shipCount: 1 });
    world.tick = 100; // past spawn-grace
    // Target ship at x=1.
    world.ships[0].pos = { x: 1, y: 300 };
    world.ships[0].health = 100;
    // Bullet at x=799 — toroidal distance to target is 2 px.
    world.bullets.push({
      id: 'b-seam',
      type: 'bullet',
      pos: { x: 799, y: 300 },
      vel: { x: 0, y: 0 },
      damage: 25,
      owner: 'nobody',
      age: 0,
      maxAge: 60,
    });
    detectCollisions(world);
    expect(world.ships[0].health).toBeLessThan(100);
  });

  it('a ship at x=10 collides toroidally with an asteroid at x=790', () => {
    const world = createWorld({ ...CONFIG, shipCount: 1, asteroidCount: 0 });
    world.tick = 100;
    const ship = world.ships[0];
    ship.pos = { x: 10, y: 300 };
    ship.health = 100;
    world.asteroids.push({
      id: 'wrap-a',
      type: 'asteroid',
      pos: { x: 790, y: 300 }, // 20 px toroidally from ship
      vel: { x: 0, y: 0 },
      radius: 25,
      health: 1,
      mass: 1,
      tier: 'MEDIUM',
      vertices: [],
      rotation: 0,
      angularVel: 0,
    });
    detectCollisions(world);
    // Asteroid radius 25 + ship radius 10 = 35; toroidal distance 20 → collision.
    expect(ship.health).toBeLessThan(100);
  });
});

describe('buildBotState delivers local-frame coordinates', () => {
  it('shifts an across-seam opponent into the viewer\'s local frame', () => {
    const world = createWorld({ ...CONFIG, shipCount: 2 });
    // Place ship-0 just inside the left edge, ship-1 just inside the right edge.
    world.ships[0].pos = { x: 10, y: 300 };
    world.ships[1].pos = { x: 790, y: 300 };
    const bs = buildBotState(world, 'ship-0')!;
    expect(bs).not.toBeNull();
    const opp = bs.opponents[0];
    // Naïve dx = 790 - 10 = 780 (long way). Toroidal-shortest dx = -20.
    const dx = opp.pos.x - bs.ship.pos.x;
    expect(dx).toBe(-20);
    // Sanity: the viewer's own pos is still absolute.
    expect(bs.ship.pos.x).toBe(10);
  });

  it('a target across the seam is "nearby" (toroidal sensor range)', () => {
    const world = createWorld({ ...CONFIG, shipCount: 2 });
    world.ships[0].pos = { x: 10, y: 300 };
    world.ships[1].pos = { x: 790, y: 300 };
    const bs = buildBotState(world, 'ship-0')!;
    // The opponent is in `nearbyEntities` because toroidal distance is 20.
    const nearbyShips = bs.nearbyEntities.filter((e) => e.type === 'ship');
    expect(nearbyShips.length).toBe(1);
  });

  it('an asteroid 400px away in absolute coords stays visible if toroidally close', () => {
    const world = createWorld({ ...CONFIG, shipCount: 1, asteroidCount: 0 });
    world.ships[0].pos = { x: 0, y: 300 };
    world.asteroids.push({
      id: 'a-wrap',
      type: 'asteroid',
      pos: { x: 750, y: 300 }, // 50 px toroidally from ship
      vel: { x: 0, y: 0 },
      radius: 25,
      health: 1,
      mass: 1,
      tier: 'MEDIUM',
      vertices: [],
      rotation: 0,
      angularVel: 0,
    });
    const bs = buildBotState(world, world.ships[0].id)!;
    const nearbyA = bs.nearbyEntities.filter((e) => e.type === 'asteroid');
    expect(nearbyA.length).toBe(1);
    // Local-frame x should be -50 (i.e. 50 px to the left, the short way).
    const localX = nearbyA[0].pos.x - bs.ship.pos.x;
    expect(localX).toBe(-50);
  });

  it('atan2 on local-frame positions gives the correct heading across the seam', () => {
    const world = createWorld({ ...CONFIG, shipCount: 2 });
    world.ships[0].pos = { x: 10, y: 300 };
    world.ships[1].pos = { x: 790, y: 300 }; // 20 px to the left of ship-0 toroidally
    const bs = buildBotState(world, 'ship-0')!;
    const opp = bs.opponents[0];
    const heading = Math.atan2(opp.pos.y - bs.ship.pos.y, opp.pos.x - bs.ship.pos.x);
    // Opponent is straight to the left → heading π (or -π).
    expect(Math.abs(Math.abs(heading) - Math.PI)).toBeLessThan(1e-9);
  });
});
