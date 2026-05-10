/**
 * Tests for the GameConfig.shipCount override and the ship-count derivation
 * formula in createWorld. The original code had a float-in-for-loop bug
 * that produced 19 ships in the default world; this guards against
 * regressions.
 */

import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/engine/world.js';
import type { GameConfig } from '../src/shared/types.js';

const BASE: GameConfig = {
  worldWidth: 1200,
  worldHeight: 800,
  seed: 42,
  asteroidCount: 0,
  tickMs: 50,
  maxBulletsPerShip: 3,
  bulletSpeed: 8,
  shipThrust: 0.15,
  shipRotationSpeed: 0.08,
  shipMaxFuel: 10000,
  asteroidBaseRadius: 30,
  asteroidSpeed: 1.5,
};

describe('createWorld ship count', () => {
  it('caps derived ship count at 4 even on huge worlds', () => {
    const w = createWorld({ ...BASE, worldWidth: 100_000, worldHeight: 100_000 });
    expect(w.ships.length).toBeLessThanOrEqual(4);
  });

  it('honors an explicit shipCount override', () => {
    const w = createWorld({ ...BASE, shipCount: 2 });
    expect(w.ships.length).toBe(2);
  });

  it('always produces at least one ship', () => {
    const w = createWorld({ ...BASE, worldWidth: 100, worldHeight: 100, shipCount: 0 });
    expect(w.ships.length).toBeGreaterThanOrEqual(1);
  });

  it('clamps shipCount override to at most 4', () => {
    const w = createWorld({ ...BASE, shipCount: 99 });
    expect(w.ships.length).toBeLessThanOrEqual(4);
  });
});
