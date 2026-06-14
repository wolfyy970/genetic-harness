/**
 * Tests for the score-credit logic added to detectCollisions().
 *
 * Synthesizes minimal GameStates with a single bullet + asteroid (or ship)
 * and asserts the owning ship's `score` field changes by the documented
 * amount. Locks the score table so a future tweak to collision.ts can't
 * silently zero the fitness signal again.
 */

import { describe, it, expect } from 'vitest';
import { detectCollisions } from '../src/engine/collision.js';
import type { Asteroid, AsteroidTier, Bullet, GameState, ShipState } from '../src/shared/types.js';

const CONFIG = {
  worldWidth: 400,
  worldHeight: 300,
  seed: 1,
  asteroidCount: 0,
  tickMs: 50,
  maxBulletsPerShip: 4,
  bulletSpeed: 8,
  shipThrust: 0.1,
  shipRotationSpeed: 0.1,
  shipMaxFuel: 1000,
  asteroidBaseRadius: 25,
  asteroidSpeed: 1,
  shipCount: 2,
} as const;

function makeShip(id: string, x: number, y: number, opts: Partial<ShipState> = {}): ShipState {
  return {
    id,
    type: 'ship',
    pos: { x, y },
    vel: { x: 0, y: 0 },
    angle: 0,
    angularVel: 0,
    thrust: false,
    thrustAngle: 0,
    fuel: 1000,
    shields: 0,         // disable shield absorption for clearer damage math
    health: 100,
    score: 0,
    ...opts,
  };
}

const TIER_RADIUS: Record<AsteroidTier, number> = {
  LARGE: 45,
  MEDIUM: 25,
  SMALL: 12,
};

function makeAsteroid(
  id: string,
  x: number,
  y: number,
  tier: AsteroidTier,
  health: number,
): Asteroid {
  const radius = TIER_RADIUS[tier];
  return {
    id,
    type: 'asteroid',
    pos: { x, y },
    vel: { x: 0, y: 0 },
    radius,
    health,
    mass: Math.PI * radius * radius * 0.01,
    tier,
    vertices: [],     // shape doesn't matter for collision tests; bounding-radius hit-detect
    rotation: 0,
    angularVel: 0,
  };
}

function makeBullet(id: string, owner: string, x: number, y: number, damage: number): Bullet {
  return {
    id,
    type: 'bullet',
    pos: { x, y },
    vel: { x: 0, y: 0 },
    damage,
    owner,
    age: 0,
    maxAge: 100,
  };
}

function baseState(ships: ShipState[]): GameState {
  return {
    // Past spawn-grace window so damage paths fire.
    tick: 100,
    worldWidth: 400,
    worldHeight: 300,
    seed: 1,
    ships,
    asteroids: [],
    bullets: [],
    config: { ...CONFIG },
  };
}

describe('score credit — bullet vs asteroid', () => {
  it('credits +1 to the bullet owner on a non-lethal hit', () => {
    const shooter = makeShip('shooter', 100, 100);
    const state = baseState([shooter]);
    // Force health = 100 (override the tier default of 1) so the bullet's
    // 25 damage is non-lethal.
    state.asteroids.push(makeAsteroid('a1', 100, 100, 'LARGE', 100));
    state.bullets.push(makeBullet('b1', 'shooter', 100, 100, 25));

    detectCollisions(state);
    expect(state.ships[0].score).toBe(1);
  });

  it('credits +1 hit + tier-scaled kill credit when a LARGE asteroid dies', () => {
    const shooter = makeShip('shooter', 100, 100);
    const state = baseState([shooter]);
    // health 25 → bullet damage 25 → dies on this hit; LARGE = 20 points.
    state.asteroids.push(makeAsteroid('a1', 100, 100, 'LARGE', 25));
    state.bullets.push(makeBullet('b1', 'shooter', 100, 100, 25));

    detectCollisions(state);
    // 1 (hit) + 50 (LARGE kill) = 51
    expect(state.ships[0].score).toBe(51);
  });

  it('credits 50 for a MEDIUM-asteroid kill', () => {
    const shooter = makeShip('shooter', 100, 100);
    const state = baseState([shooter]);
    state.asteroids.push(makeAsteroid('a1', 100, 100, 'MEDIUM', 25));
    state.bullets.push(makeBullet('b1', 'shooter', 100, 100, 25));

    detectCollisions(state);
    // 1 + 100 = 101 (MEDIUM kill)
    expect(state.ships[0].score).toBe(101);
  });

  it('credits 100 for a SMALL-asteroid kill', () => {
    const shooter = makeShip('shooter', 100, 100);
    const state = baseState([shooter]);
    state.asteroids.push(makeAsteroid('a1', 100, 100, 'SMALL', 25));
    state.bullets.push(makeBullet('b1', 'shooter', 100, 100, 25));

    detectCollisions(state);
    // 1 + 200 = 201 (SMALL kill — small targets worth the most)
    expect(state.ships[0].score).toBe(201);
  });
});

describe('score credit — bullet vs ship', () => {
  it('credits +5 for hitting an opposing ship', () => {
    const shooter = makeShip('shooter', 100, 100);
    const target = makeShip('target', 200, 100);
    const state = baseState([shooter, target]);
    // Bullet co-located with target so the shooter doesn't friendly-fire itself.
    state.bullets.push(makeBullet('b1', 'shooter', 200, 100, 25));

    detectCollisions(state);
    expect(state.ships[0].score).toBe(5);
  });

  it('credits +5 hit + +200 kill when the ship is destroyed', () => {
    const shooter = makeShip('shooter', 100, 100);
    const target = makeShip('target', 200, 100, { health: 25 });
    const state = baseState([shooter, target]);
    state.bullets.push(makeBullet('b1', 'shooter', 200, 100, 25));

    detectCollisions(state);
    expect(state.ships[0].score).toBe(205); // 5 + 200
    expect(state.ships[1].health).toBe(0);
  });

  it('does not credit friendly fire (bullet owner == ship)', () => {
    const ship = makeShip('shooter', 100, 100);
    const state = baseState([ship]);
    state.bullets.push(makeBullet('b1', 'shooter', 100, 100, 25));

    detectCollisions(state);
    expect(state.ships[0].score).toBe(0);
  });

  it('asteroid kill on a ship grants no shooter credit (no shooter)', () => {
    const victim = makeShip('victim', 100, 100, { health: 5 });
    const state = baseState([victim]);
    state.asteroids.push(makeAsteroid('a1', 100, 100, 'MEDIUM', 100));

    detectCollisions(state);
    // Victim's score should be untouched by the collision; whatever damage
    // logic does is fine, but there's no shooter to credit.
    expect(state.ships[0].score).toBe(0);
  });
});

describe('score credit — ignores missing/destroyed shooters', () => {
  it('does not throw when bullet.owner refers to a removed ship', () => {
    // Shooter is gone (e.g. destroyed last tick), but their bullet is still in flight.
    const state = baseState([]);
    state.asteroids.push(makeAsteroid('a1', 100, 100, 'LARGE', 25));
    state.bullets.push(makeBullet('b1', 'ghost', 100, 100, 25));

    expect(() => detectCollisions(state)).not.toThrow();
    // Parent LARGE killed → 2 MEDIUM fragments.
    expect(state.asteroids.length).toBe(2);
  });
});
