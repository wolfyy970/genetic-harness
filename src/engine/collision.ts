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
  AsteroidTier,
  Bullet,
  CollisionEvent,
  GameState,
  ShipState,
} from '../shared/types.js';
import { toroidalDist, SeededRNG } from './utils.js';
import { ASTEROID_TIERS, createAsteroid, SPAWN_GRACE_TICKS } from './world.js';

// Collision radii offsets (hitboxes)
const BULLET_RADIUS = 3;
const SHIP_RADIUS = 10;

/**
 * Asteroid-ship collision damage table. Real Asteroids = one mistake, one
 * life lost — we mirror that with tier-based lethality. A LARGE asteroid
 * one-shots from full HP (100); MEDIUM is two hits; SMALL is "chip"
 * damage that still bleeds you out if you get sloppy.
 *
 * Ship-ship and bullet-ship collisions stay on the old shield-mediated
 * pipeline; this only governs ship vs rock.
 */
const COLLISION_DAMAGE_BY_TIER = {
  LARGE: 100,
  MEDIUM: 60,
  SMALL: 30,
} as const;
/** Per-unit-of-closing-speed bonus multiplier. ramming at speed = worse. */
const COLLISION_DAMAGE_VEL_FACTOR = 0.5;
/** Legacy constant retained for ship-ship damage (uses shields pipeline). */
const SHIP_SHIP_DAMAGE_BASE = 50;

// Score table — Asteroids-arcade convention. Smaller targets are worth more.
// Tuned so destroying a single LARGE → 2 MEDIUM → 4 SMALL chain = 50 + 200
// + 800 = 1050 points; far above any "be passive and survive" baseline.
const SCORE_BULLET_HIT_ASTEROID = 1;
const SCORE_ASTEROID_LARGE = 50;
const SCORE_ASTEROID_MEDIUM = 100;
const SCORE_ASTEROID_SMALL = 200;
const SCORE_BULLET_HIT_SHIP = 5;
const SCORE_SHIP_KILL = 200;

/** Credit a ship's score by id. No-op if the ship is missing or already destroyed. */
function creditScore(state: GameState, shipId: string, points: number): void {
  const ship = state.ships.find((s) => s.id === shipId);
  if (!ship) return;
  ship.score += points;
}

/** Score for destroying an asteroid of the given tier. */
function asteroidKillScore(tier: AsteroidTier): number {
  switch (tier) {
    case 'LARGE': return SCORE_ASTEROID_LARGE;
    case 'MEDIUM': return SCORE_ASTEROID_MEDIUM;
    case 'SMALL': return SCORE_ASTEROID_SMALL;
  }
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

  // Spawn-grace: skip ship-damage paths for the first SPAWN_GRACE_TICKS so
  // 8-way FFA starts can't self-eliminate on tick 0-1. Asteroid kills via
  // bullets still resolve (no ship damage), so a candidate can still
  // pre-emptively shoot rocks during grace.
  const inGrace = state.tick < SPAWN_GRACE_TICKS;

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
      if (toroidalDist(bullet.pos, asteroid.pos, state.worldWidth, state.worldHeight) < asteroid.radius + BULLET_RADIUS) {
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
          // Kill credit, scaled by parent tier.
          creditScore(state, bullet.owner, asteroidKillScore(asteroid.tier));
          events.push({
            type: 'asteroid_destroyed',
            asteroid,
            bullet,
          });

          // Split per tier table: LARGE→2 MEDIUM, MEDIUM→2 SMALL, SMALL→destroyed.
          const fragments = spawnAsteroidFragments(asteroid);
          asteroidsToSplit.push(...fragments);
        }

        break; // one bullet hits at most one asteroid
      }
    }

    // If the bullet didn't hit anything, keep iterating to the next bullet
  }

  // -----------------------------------------------------------------------
  // Bullet-ship collisions. Real-Asteroids parity: a ship's own bullet
  // passes through it harmlessly.
  // -----------------------------------------------------------------------
  for (const bullet of state.bullets) {
    for (const ship of state.ships) {
      if (ship.health <= 0) continue;
      // No self-damage: own bullets fly through their owner.
      if (bullet.owner === ship.id) continue;

      if (toroidalDist(bullet.pos, ship.pos, state.worldWidth, state.worldHeight) < SHIP_RADIUS + BULLET_RADIUS) {
        if (inGrace) continue;
        ship.shields = Math.max(0, ship.shields - bullet.damage * 0.5);

        if (ship.shields <= 0) {
          ship.health -= bullet.damage;
        } else {
          ship.health -= Math.ceil(bullet.damage * 0.5);
        }

        creditScore(state, bullet.owner, SCORE_BULLET_HIT_SHIP);

        events.push({
          type: 'bullet_ship',
          bullet,
          ship,
        });

        if (ship.health <= 0) {
          ship.health = 0;
          creditScore(state, bullet.owner, SCORE_SHIP_KILL);
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
  // Ship-ship collisions. Symmetric damage scaled by closing velocity —
  // ramming at high speed mutually annihilates.
  // -----------------------------------------------------------------------
  for (let i = 0; i < state.ships.length; i++) {
    const a = state.ships[i];
    if (a.health <= 0) continue;
    for (let j = i + 1; j < state.ships.length; j++) {
      const b = state.ships[j];
      if (b.health <= 0) continue;

      if (toroidalDist(a.pos, b.pos, state.worldWidth, state.worldHeight) < SHIP_RADIUS * 2) {
        if (inGrace) continue;
        const relVel = Math.sqrt(
          Math.pow(a.vel.x - b.vel.x, 2) +
            Math.pow(a.vel.y - b.vel.y, 2),
        );
        const dmg = SHIP_SHIP_DAMAGE_BASE * (1 + relVel * COLLISION_DAMAGE_VEL_FACTOR);
        // Apply through shields like ship-asteroid: shields take 70%, hull 30%.
        for (const ship of [a, b]) {
          ship.shields = Math.max(0, ship.shields - dmg * 0.7);
          const remaining = dmg * 0.3;
          if (ship.shields <= 0) ship.health -= remaining * 2;
          else ship.health -= remaining;
        }
        events.push({ type: 'asteroid_ship', ship: a, velocity: relVel });
        events.push({ type: 'asteroid_ship', ship: b, velocity: relVel });
        if (a.health <= 0) {
          a.health = 0;
          events.push({ type: 'ship_destroyed', ship: a });
        }
        if (b.health <= 0) {
          b.health = 0;
          events.push({ type: 'ship_destroyed', ship: b });
        }
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

      if (toroidalDist(asteroid.pos, ship.pos, state.worldWidth, state.worldHeight) < asteroid.radius + SHIP_RADIUS) {
        if (inGrace) continue;
        const relVel = Math.sqrt(
          Math.pow(asteroid.vel.x - ship.vel.x, 2) +
            Math.pow(asteroid.vel.y - ship.vel.y, 2),
        );

        // Arcade-style lethality: damage is fully driven by the asteroid's
        // tier × closing-speed multiplier. No shield absorption — rocks
        // are meant to be feared. A LARGE asteroid at rest = 100 dmg = an
        // instant kill from full HP; a SMALL one is ~30 dmg so a careless
        // bot can survive a couple of grazes before dying.
        const tierBase = COLLISION_DAMAGE_BY_TIER[asteroid.tier];
        const totalDamage = tierBase * (1 + relVel * COLLISION_DAMAGE_VEL_FACTOR);
        ship.health -= totalDamage;

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

      if (toroidalDist(a.pos, b.pos, state.worldWidth, state.worldHeight) < a.radius + b.radius) {
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
 * Split an asteroid into fragments per its tier table (LARGE→2 MEDIUM,
 * MEDIUM→2 SMALL, SMALL→none). Each fragment moves outward from the parent
 * centroid with ~1.5× the parent's speed (real-Asteroids behaviour).
 *
 * Vertex jitter is seeded from the parent id so split shapes are
 * reproducible across runs.
 */
function spawnAsteroidFragments(parent: Asteroid): Asteroid[] {
  const parentSpec = ASTEROID_TIERS[parent.tier];
  const childTier = parentSpec.splitInto;
  const count = parentSpec.splitCount;
  if (!childTier || count === 0) return [];

  // Derive a fragment-local RNG from the parent id so vertex jitter is
  // reproducible without coupling to the global tick RNG.
  const seed =
    Array.from(parent.id).reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 17) ^
    Math.floor(parent.pos.x);
  const rng = new SeededRNG(seed);
  const parentSpeed = Math.sqrt(parent.vel.x * parent.vel.x + parent.vel.y * parent.vel.y);
  // Child specs determine the fragment speed factor (faster than parent).
  const childSpec = ASTEROID_TIERS[childTier];
  const baseSpeed = Math.max(1.0, parentSpeed) * childSpec.speedFactor;

  const fragments: Asteroid[] = [];
  for (let i = 0; i < count; i++) {
    const angleSpread =
      ((Math.PI * 2) / count) * i + rng.nextRange(-0.35, 0.35);
    const fragmentSpeed = baseSpeed * rng.nextRange(0.85, 1.15);

    const vel = {
      x: Math.cos(angleSpread) * fragmentSpeed,
      y: Math.sin(angleSpread) * fragmentSpeed,
    };
    const pos = {
      x: parent.pos.x + Math.cos(angleSpread) * parent.radius * 0.5,
      y: parent.pos.y + Math.sin(angleSpread) * parent.radius * 0.5,
    };

    const id = `${parent.id}-split-${i}`;
    fragments.push(createAsteroid(childTier, pos, vel, rng, id));
  }
  return fragments;
}
