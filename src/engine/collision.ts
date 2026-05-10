/**
 * @module collision
 */

/**
 * Collision detection for the asteroids arena.
 * Handles bullet-asteroid, bullet-ship, asteroid-ship, and asteroid-asteroid collisions.
 * Mutates the GameState in-place to apply collision effects, and returns a list of events.
 */

import type {
  Asteroid,
  Bullet,
  CollisionEvent,
  GameState,
  ShipState,
} from '../shared/types.js';
import { dist, generateAsteroidVertices, SeededRNG } from './utils.js';

// Collision radii offsets (hitboxes)
const BULLET_RADIUS = 3;
const SHIP_RADIUS = 10;

// Ship-asteroid collision damage. Real Asteroids gives one mistake — we
// give two at rest, one at full speed. Ship has 100 health.
const COLLISION_DAMAGE_BASE = 50;
const COLLISION_DAMAGE_VEL_FACTOR = 1.0;

// Score table — Asteroids-arcade convention. Smaller targets are worth more.
const SCORE_BULLET_HIT_ASTEROID = 1;
const SCORE_ASTEROID_LARGE = 20;   // radius ≥ 40
const SCORE_ASTEROID_MEDIUM = 50;  // 20 ≤ radius < 40
const SCORE_ASTEROID_SMALL = 100;  // radius < 20
const SCORE_BULLET_HIT_SHIP = 5;
const SCORE_SHIP_KILL = 200;

/** Credit a ship's score by id. No-op if the ship is missing or already destroyed. */
function creditScore(state: GameState, shipId: string, points: number): void {
  const ship = state.ships.find((s) => s.id === shipId);
  if (!ship) return;
  ship.score += points;
}

/** Score for destroying an asteroid of the given radius. */
function asteroidKillScore(radius: number): number {
  if (radius >= 40) return SCORE_ASTEROID_LARGE;
  if (radius >= 20) return SCORE_ASTEROID_MEDIUM;
  return SCORE_ASTEROID_SMALL;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect and resolve all collisions between entities in the current game state.
 *
 * Side-effects (mutating `state` in-place):
 * - Bullet-asteroid: reduces asteroid health; splits large asteroids into 2-3 smaller ones.
 * - Bullet-ship: applies damage to the ship; marks it destroyed if health drops to 0 or below.
 * - Asteroid-ship: damages the ship based on asteroid size and relative velocity;
 *   destroys ships with health ≤ 0.
 * - Asteroid-asteroid: no structural effect (visual-only).
 *
 * @param state  The current game state to scan for collisions.
 * @returns      An array of collision events that occurred this tick.
 */
export function detectCollisions(state: GameState): CollisionEvent[] {
  const events: CollisionEvent[] = [];

  // Collect indices of asteroids to remove so we can safely mutate while iterating
  const asteroidsToRemove = new Set<number>();
  const asteroidsToSplit: Asteroid[] = [];

  // -----------------------------------------------------------------------
  // Bullet-asteroid collisions
  // -----------------------------------------------------------------------
  for (let bi = state.bullets.length - 1; bi >= 0; bi--) {
    const bullet = state.bullets[bi];
    if (bullet.age >= bullet.maxAge) {
      state.bullets.splice(bi, 1);
      continue;
    }

    let hit = false;
    for (let ai = 0; ai < state.asteroids.length; ai++) {
      if (asteroidsToRemove.has(ai)) continue;

      const asteroid = state.asteroids[ai];
      if (dist(bullet.pos, asteroid.pos) < asteroid.radius + BULLET_RADIUS) {
        // Remove the bullet
        state.bullets.splice(bi, 1);
        hit = true;

        // Apply damage
        asteroid.health -= bullet.damage;

        // Credit the shooting ship for landing the hit.
        creditScore(state, bullet.owner, SCORE_BULLET_HIT_ASTEROID);

        events.push({
          type: 'bullet_asteroid',
          bullet,
          asteroid,
        });

        // If asteroid health is 0 or below, remove it
        if (asteroid.health <= 0) {
          asteroidsToRemove.add(ai);
          // Kill credit, scaled by parent radius.
          creditScore(state, bullet.owner, asteroidKillScore(asteroid.radius));
          events.push({
            type: 'asteroid_destroyed',
            asteroid,
            bullet,
          });

          // Split before removing
          if (asteroid.radius > 20) {
            const fragments = spawnAsteroidFragments(asteroid, 2);
            asteroidsToSplit.push(...fragments);
          }
        } else if (asteroid.radius > 30) {
          // Split large but still-alive asteroids
          const fragments = spawnAsteroidFragments(asteroid, 2);
          asteroidsToSplit.push(...fragments);
        }

        break; // one bullet hits at most one asteroid
      }
    }

    // If the bullet didn't hit anything, keep iterating to the next bullet
  }

  // -----------------------------------------------------------------------
  // Bullet-ship collisions (including friendly fire — owner check is
  // informational; we still report the event regardless)
  // -----------------------------------------------------------------------
  for (const bullet of state.bullets) {
    for (const ship of state.ships) {
      if (ship.health <= 0) continue;

      if (dist(bullet.pos, ship.pos) < SHIP_RADIUS + BULLET_RADIUS) {
        ship.shields = Math.max(0, ship.shields - bullet.damage * 0.5);

        if (ship.shields <= 0) {
          ship.health -= bullet.damage;
        } else {
          ship.health -= Math.ceil(bullet.damage * 0.5);
        }

        // Don't credit friendly fire (bullet hitting your own ship is its
        // own punishment via lost health).
        if (bullet.owner !== ship.id) {
          creditScore(state, bullet.owner, SCORE_BULLET_HIT_SHIP);
        }

        events.push({
          type: 'bullet_ship',
          bullet,
          ship,
        });

        if (ship.health <= 0) {
          ship.health = 0;
          if (bullet.owner !== ship.id) {
            creditScore(state, bullet.owner, SCORE_SHIP_KILL);
          }
          events.push({
            type: 'ship_destroyed',
            ship,
            bullet,
          });
        }

        break; // bullet consumed
      }
    }
  }

  // -----------------------------------------------------------------------
  // Asteroid-ship collisions
  // -----------------------------------------------------------------------
  for (const asteroid of state.asteroids) {
    if (asteroidsToRemove.has(state.asteroids.indexOf(asteroid))) continue;

    for (const ship of state.ships) {
      if (ship.health <= 0) continue;

      if (dist(asteroid.pos, ship.pos) < asteroid.radius + SHIP_RADIUS) {
        const relVel = Math.sqrt(
          Math.pow(asteroid.vel.x - ship.vel.x, 2) +
            Math.pow(asteroid.vel.y - ship.vel.y, 2),
        );

        // Damage scales with relative velocity. Base damage is intentionally
        // high so collisions are real evolutionary pressure — bots that
        // ignore asteroids die in 1-2 hits.
        const velocityFactor = 1 + relVel * COLLISION_DAMAGE_VEL_FACTOR;
        const totalDamage = COLLISION_DAMAGE_BASE * velocityFactor;

        // Shields absorb most damage first
        ship.shields = Math.max(0, ship.shields - totalDamage * 0.7);
        const remainingDamage = totalDamage * 0.3;

        if (ship.shields <= 0) {
          ship.health -= remainingDamage * 2;
        } else {
          ship.health -= remainingDamage;
        }

        events.push({
          type: 'asteroid_ship',
          asteroid,
          ship,
          velocity: relVel,
        });

        if (ship.health <= 0) {
          ship.health = 0;
          events.push({
            type: 'ship_destroyed',
            ship,
            asteroid,
          });
        }

        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Asteroid-asteroid collisions (visual only — record event, no structural
  // changes)
  // -----------------------------------------------------------------------
  for (let i = 0; i < state.asteroids.length; i++) {
    if (asteroidsToRemove.has(i)) continue;

    for (let j = i + 1; j < state.asteroids.length; j++) {
      if (asteroidsToRemove.has(j)) continue;

      const a = state.asteroids[i];
      const b = state.asteroids[j];

      if (dist(a.pos, b.pos) < a.radius + b.radius) {
        events.push({
          type: 'asteroid_asteroid',
          asteroidA: a,
          asteroidB: b,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Apply asteroid removals and splits in-place
  // -----------------------------------------------------------------------
  if (asteroidsToRemove.size > 0) {
    // Compact asteroids array, preserving order
    let write = 0;
    for (let r = 0; r < state.asteroids.length; r++) {
      if (!asteroidsToRemove.has(r)) {
        state.asteroids[write] = state.asteroids[r];
        write++;
      }
    }
    state.asteroids.length = write;
  }

  // Append split fragments to the asteroids array
  state.asteroids.push(...asteroidsToSplit);

  return events;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split an asteroid into 2-3 smaller fragments.
 *
 * Each fragment inherits a fraction of the parent's velocity,
 * with a small random perturbation. Radii are reduced by ~40-50%.
 *
 * @param parent   The asteroid to split.
 * @param count    Number of fragments to create (2 or 3).
 * @returns        An array of new `Asteroid` objects ready to be inserted
 *                 into `state.asteroids`.
 */
function spawnAsteroidFragments(parent: Asteroid, count: number): Asteroid[] {
  const fragments: Asteroid[] = [];
  // Derive a fragment-local RNG from the parent id so vertex jitter is
  // reproducible without coupling to the global tick RNG.
  const seed =
    Array.from(parent.id).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 17) ^
    Math.floor(parent.pos.x);
  const rng = new SeededRNG(seed);
  const childRadius = parent.radius * rng.nextRange(0.45, 0.55);
  const speed = Math.sqrt(parent.vel.x * parent.vel.x + parent.vel.y * parent.vel.y);

  for (let i = 0; i < count; i++) {
    const angleSpread =
      ((Math.PI * 2) / count) * i + rng.nextRange(-0.25, 0.25);
    const fragmentSpeed = speed * rng.nextRange(0.8, 1.2);

    const vel = {
      x: Math.cos(angleSpread) * fragmentSpeed,
      y: Math.sin(angleSpread) * fragmentSpeed,
    };
    const r = Math.max(10, childRadius);

    const fragment: Asteroid = {
      id: `${parent.id}-split-${i}`,
      type: 'asteroid',
      pos: {
        x: parent.pos.x + Math.cos(angleSpread) * parent.radius * 0.5,
        y: parent.pos.y + Math.sin(angleSpread) * parent.radius * 0.5,
      },
      vel,
      radius: r,
      health: Math.max(1, Math.ceil(r / 15)),
      mass: Math.PI * r * r * 0.01,
      vertices: generateAsteroidVertices(r, rng),
      rotation: rng.nextRange(0, Math.PI * 2),
      angularVel: rng.nextRange(-0.08, 0.08),
    };

    fragments.push(fragment);
  }

  return fragments;
}
