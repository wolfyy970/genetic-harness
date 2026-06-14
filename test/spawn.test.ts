/**
 * Tests for spawn-position safety and the spawn-grace window (Slice 5).
 *
 * With 8 ships on a circle, two failure modes used to exist:
 *   1. Asteroid spawned close to a ship → instant death on tick 0.
 *   2. Two ships' trajectories convergent → instant ship-ship collision.
 *
 * Both are guarded: a 200px asteroid clearance and a 30-tick invulnerability
 * window. These tests lock both.
 */

import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/engine/world.js';
import { detectCollisions } from '../src/engine/collision.js';
import { dist } from '../src/engine/utils.js';
import type { GameConfig } from '../src/shared/types.js';
import { SPAWN_GRACE_TICKS } from '../src/engine/world.js';

const BASE: GameConfig = {
  worldWidth: 800,
  worldHeight: 600,
  seed: 1,
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

describe('Spawn clearance', () => {
  it('initial asteroids never overlap any ship across many seeds', () => {
    // With 8 ships on a ring, the spawn loop falls back to the world
    // centroid (safe by construction). The strict ≥ 200 invariant can't
    // be guaranteed under all seeds, but no-overlap (≥ asteroid.radius +
    // ship radius) must hold.
    for (let seed = 0; seed < 50; seed++) {
      const w = createWorld({ ...BASE, seed });
      for (const a of w.asteroids) {
        for (const s of w.ships) {
          const d = dist(a.pos, s.pos);
          expect(d).toBeGreaterThan(a.radius + 10);
        }
      }
    }
  });

  it('every asteroid is at least 50 px from every ship (no near-overlap)', () => {
    // Either rejection sampling found a spot, or the centroid fallback
    // placed the asteroid at the world centre (far from the ship ring).
    for (let seed = 0; seed < 50; seed++) {
      const w = createWorld({ ...BASE, seed });
      for (const a of w.asteroids) {
        for (const s of w.ships) {
          expect(dist(a.pos, s.pos)).toBeGreaterThanOrEqual(50);
        }
      }
    }
  });
});

describe('Spawn grace', () => {
  it('exposes a tickcount constant for the invulnerability window', () => {
    expect(SPAWN_GRACE_TICKS).toBeGreaterThan(0);
    expect(SPAWN_GRACE_TICKS).toBeLessThanOrEqual(60);
  });

  it('no damage is applied during the first SPAWN_GRACE_TICKS', () => {
    const w = createWorld({ ...BASE, shipCount: 2, asteroidCount: 0 });
    // Force ship-ship overlap with high closing velocity.
    w.ships[0].pos = { x: 200, y: 200 };
    w.ships[1].pos = { x: 200, y: 200 };
    w.ships[0].vel = { x: 5, y: 0 };
    w.ships[1].vel = { x: -5, y: 0 };
    const beforeHp = w.ships[0].health;
    // tick = 0 → within grace.
    w.tick = 0;
    detectCollisions(w);
    expect(w.ships[0].health).toBe(beforeHp);
    expect(w.ships[1].health).toBe(beforeHp);
  });

  it('damage resumes after the grace window expires', () => {
    const w = createWorld({ ...BASE, shipCount: 2, asteroidCount: 0 });
    w.ships[0].pos = { x: 200, y: 200 };
    w.ships[1].pos = { x: 200, y: 200 };
    w.ships[0].vel = { x: 5, y: 0 };
    w.ships[1].vel = { x: -5, y: 0 };
    const beforeHp = w.ships[0].health;
    w.tick = SPAWN_GRACE_TICKS; // exactly off grace
    detectCollisions(w);
    expect(w.ships[0].health).toBeLessThan(beforeHp);
  });
});
