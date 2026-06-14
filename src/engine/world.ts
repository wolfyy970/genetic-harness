/**
 * @module world
 */

/**
 * Game world state management.
 * Handles entity creation, physics updates, score accumulation, and game lifecycle.
 */

import type {
  Vector2D,
  ShipState,
  Asteroid,
  AsteroidTier,
  Bullet,
  Entity,
  GameState,
  GameConfig,
  BotAction,
  BotState as BotStateType,
} from '../shared/types.js';
import {
  wrapPosition,
  dist,
  toroidalDist,
  angleBetween,
  SeededRNG,
  clamp,
  generateAsteroidVertices,
} from './utils.js';
import { applyActionToShip } from './actions.js';
import { logger } from '../shared/logger.js';

// =============================================================================
// Asteroid Tier Table
// =============================================================================

/**
 * Per-tier asteroid parameters. Real Asteroids has three discrete sizes:
 * LARGE → 2 MEDIUM → 2 SMALL → destroyed. Smaller chunks are faster.
 *
 * `health = 1` for all tiers; bullet damage 25 destroys any tier in one hit
 * (arcade parity). Score table is keyed by tier (Small worth most).
 */
export interface AsteroidTierSpec {
  radius: number;
  health: number;
  vertexCount: number;
  splitInto: AsteroidTier | null;
  splitCount: number;
  /** Speed multiplier applied to a fragment relative to its parent. */
  speedFactor: number;
}

export const ASTEROID_TIERS: Record<AsteroidTier, AsteroidTierSpec> = {
  LARGE: {
    radius: 45,
    health: 1,
    vertexCount: 10,
    splitInto: 'MEDIUM',
    splitCount: 2,
    speedFactor: 1.0, // parent reference
  },
  MEDIUM: {
    radius: 25,
    health: 1,
    vertexCount: 8,
    splitInto: 'SMALL',
    splitCount: 2,
    speedFactor: 1.5,
  },
  SMALL: {
    radius: 12,
    health: 1,
    vertexCount: 6,
    splitInto: null,
    splitCount: 0,
    speedFactor: 1.5,
  },
};

// =============================================================================
// Constants
// =============================================================================

const MAX_BULLETS = 128;
/**
 * Bullet lifetime in ticks. At bullet-speed 8 px/tick × 200 ticks =
 * 1600px range ≈ 57% of the 2800px world width. Lets bots fire across
 * mid-range engagements; long enough for lead-the-target tactics to work
 * but bullets still expire before lapping the toroidal world.
 */
const BULLET_LIFETIME = 200;
const ASTEROID_SPAWN_MARGIN = 100;
const ASTEROID_MARGIN = ASTEROID_SPAWN_MARGIN;
/**
 * Minimum spawn-time clearance between an asteroid and any ship.
 * With 8 ships on a circle of radius ~210, this avoids cluster.
 */
const SHIP_ASTEROID_SPAWN_CLEARANCE = 200;
/**
 * Spawn invulnerability window (in ticks). Real Asteroids gives the player
 * a brief invulnerable spawn — same idea here so 8-way FFA starts don't
 * immediately self-eliminate via two ships' trajectories crossing.
 */
export const SPAWN_GRACE_TICKS = 30;
/**
 * Linear friction. Real Asteroids has zero friction — momentum is conserved.
 * Retained as a constant for tests/back-compat but **not applied** in
 * `worldTick`. Set above 0 only if a future game variant wants drag.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const FRICTION = 1.0;
const ANGULAR_DAMPING = 0.9;

// =============================================================================
// Entity Factories
// =============================================================================

let _idCounter = 0;

function nextId(): string {
  return `e${++_idCounter}`;
}

function createShip(
  id: string,
  pos: Vector2D,
  angle: number,
  config: GameConfig,
): ShipState {
  return {
    id,
    type: 'ship',
    pos: { ...pos },
    vel: { x: 0, y: 0 },
    angle,
    angularVel: 0,
    thrust: false,
    thrustAngle: 0,
    fuel: config.shipMaxFuel,
    shields: 100,
    health: 100,
    score: 0,
  };
}

/**
 * Create an asteroid of a given tier at `pos` with velocity `vel`.
 * Radius, health, and vertex count are derived from the tier spec.
 */
export function createAsteroid(
  tier: AsteroidTier,
  pos: Vector2D,
  vel: Vector2D,
  rng: SeededRNG,
  idOverride?: string,
): Asteroid {
  const spec = ASTEROID_TIERS[tier];
  const radius = spec.radius;
  const mass = Math.PI * radius * radius * 0.01;
  return {
    id: idOverride ?? nextId(),
    type: 'asteroid',
    pos: { ...pos },
    vel: { ...vel },
    radius,
    health: spec.health,
    mass,
    tier,
    vertices: generateAsteroidVertices(radius, rng, spec.vertexCount),
    rotation: rng.nextRange(0, Math.PI * 2),
    angularVel: rng.nextRange(-0.05, 0.05),
  };
}

function createBullet(
  pos: Vector2D,
  vel: Vector2D,
  owner: string,
  damage: number,
  maxAge?: number,
): Bullet {
  return {
    id: nextId(),
    type: 'bullet',
    pos: { ...pos },
    vel: { ...vel },
    damage,
    owner,
    age: 0,
    maxAge: maxAge ?? BULLET_LIFETIME,
  };
};

// =============================================================================
// World Initialization
// =============================================================================

/**
 * Create a new GameState with ships and asteroids spawned deterministically.
 */
export function createWorld(config: GameConfig): GameState {
  const rng = new SeededRNG(config.seed);
  const ships: ShipState[] = [];
  const asteroids: Asteroid[] = [];

  // Deterministic-on-circle spawn. Each of N ships sits at angle
  // `(i / N) × 2π` around the world centroid, on a radius of
  // `min(W,H) × 0.35`, facing inward (toward the centroid). Cap at 16 —
  // arena supports more than 8 if the harness wires bigger matches later.
  const derived = Math.floor((config.worldWidth * config.worldHeight) / 50000);
  const shipCount = Math.max(1, Math.min(16, config.shipCount ?? derived));
  const cx = config.worldWidth / 2;
  const cy = config.worldHeight / 2;
  const ring = Math.min(config.worldWidth, config.worldHeight) * 0.35;
  for (let i = 0; i < shipCount; i++) {
    const theta = (i / shipCount) * Math.PI * 2;
    const pos: Vector2D = {
      x: cx + Math.cos(theta) * ring,
      y: cy + Math.sin(theta) * ring,
    };
    // Face inward (toward centroid).
    const angle = theta + Math.PI;
    ships.push(createShip(`ship-${i}`, pos, angle, config));
  }

  // Spawn asteroids away from ships. Ships sit on a ring around the
  // centroid, so the centroid itself is a safe fallback if rejection
  // sampling fails on a crowded seed.
  for (let i = 0; i < config.asteroidCount; i++) {
    let pos: Vector2D = { x: cx, y: cy };
    let valid = false;
    let attempts = 0;

    while (!valid && attempts < 60) {
      pos = {
        x: rng.nextRange(ASTEROID_MARGIN, config.worldWidth - ASTEROID_MARGIN),
        y: rng.nextRange(ASTEROID_MARGIN, config.worldHeight - ASTEROID_MARGIN),
      };
      valid = true;
      for (const ship of ships) {
        if (dist(pos, ship.pos) < SHIP_ASTEROID_SPAWN_CLEARANCE) {
          valid = false;
          break;
        }
      }
      attempts++;
    }

    if (!valid) {
      // Fallback: place at world centroid with a small jitter — guaranteed
      // safe since ships are on a ring outside this radius.
      pos = {
        x: cx + rng.nextRange(-30, 30),
        y: cy + rng.nextRange(-30, 30),
      };
    }

    // All initial spawns are LARGE. Splits create MEDIUM then SMALL.
    const speed = rng.nextRange(0.5, config.asteroidSpeed);
    const angle = rng.nextRangeInclusive(0, Math.PI * 2);
    const vel = {
      x: Math.cos(angle) * speed,
      y: Math.sin(angle) * speed,
    };

    asteroids.push(createAsteroid('LARGE', pos, vel, rng));
  }

  return {
    tick: 0,
    worldWidth: config.worldWidth,
    worldHeight: config.worldHeight,
    seed: config.seed,
    ships,
    asteroids,
    bullets: [],
    config,
  };
}

// =============================================================================
// Physics Tick
// =============================================================================

/**
 * Advance the world state by one tick.
 * Processes ship actions, moves entities, spawns bullets, ages bullets.
 */
export function worldTick(
  state: GameState,
  agentActions: Map<string, BotAction>,
): GameState {
  const newState: GameState = {
    tick: state.tick + 1,
    worldWidth: state.worldWidth,
    worldHeight: state.worldHeight,
    seed: state.seed,
    ships: state.ships.map((s) => ({ ...s })),
    asteroids: state.asteroids.map((a) => ({ ...a })),
    bullets: state.bullets
      .map((b) => {
        const newPos = {
          x: b.pos.x + b.vel.x,
          y: b.pos.y + b.vel.y,
        };
        wrapPosition(newPos, state.worldWidth, state.worldHeight);
        return { ...b, pos: newPos, age: b.age + 1 };
      })
      .filter((b) => b.age < b.maxAge),
    config: state.config,
  };

  // Apply bot actions to ships
  for (const [shipId, action] of Array.from(agentActions.entries())) {
    const ship = newState.ships.find((s) => s.id === shipId);
    if (!ship) {
      logger.warn({ shipId }, 'Unknown agent action target');
      continue;
    }
    applyActionToShip(ship, action, state.config);
  }

  // Physics update for ships
  for (const ship of newState.ships) {
    // Rotation
    ship.angle += ship.angularVel;
    ship.angularVel *= ANGULAR_DAMPING;

    // Thrust (ship-relative, forward or reverse).
    if (ship.thrust && ship.fuel > 0) {
      const thrustX = Math.cos(ship.thrustAngle) * state.config.shipThrust;
      const thrustY = Math.sin(ship.thrustAngle) * state.config.shipThrust;
      ship.vel.x += thrustX;
      ship.vel.y += thrustY;
      ship.fuel -= Math.abs(thrustX) + Math.abs(thrustY);
    } else {
      ship.thrust = false;
    }

    // Zero linear friction — real Asteroids preserves momentum. (Angular
    // damping above is intentional — rotational input is impulse-based.)

    // Position update
    ship.pos.x += ship.vel.x;
    ship.pos.y += ship.vel.y;
    wrapPosition(ship.pos, state.worldWidth, state.worldHeight);
  }

  // Asteroid physics
  for (const asteroid of newState.asteroids) {
    asteroid.pos.x += asteroid.vel.x;
    asteroid.pos.y += asteroid.vel.y;
    wrapPosition(asteroid.pos, state.worldWidth, state.worldHeight);
    asteroid.rotation += asteroid.angularVel;
  }

  // Bullet aging handled above; remove dead bullets
  newState.bullets = newState.bullets.filter((b) => b.age < b.maxAge);

  // Clamp fuel
  for (const ship of newState.ships) {
    ship.fuel = clamp(ship.fuel, 0, state.config.shipMaxFuel);
  }

  return newState;
}

/**
 * Spawn a bullet from a ship, if allowed.
 * Returns the updated bullets array.
 */
export function spawnBullet(
  state: GameState,
  shipId: string,
): GameState {
  const ship = state.ships.find((s) => s.id === shipId);
  if (!ship) return state;

  const activeBullets = state.bullets.filter((b) => b.owner === shipId);
  if (activeBullets.length >= state.config.maxBulletsPerShip) return state;

  if (state.bullets.length >= MAX_BULLETS) return state;

  const bulletVelX = Math.cos(ship.angle) * state.config.bulletSpeed;
  const bulletVelY = Math.sin(ship.angle) * state.config.bulletSpeed;
  const bulletPos = {
    x: ship.pos.x + Math.cos(ship.angle) * 15,
    y: ship.pos.y + Math.sin(ship.angle) * 15,
  };

  const bullet = createBullet(bulletPos, { x: bulletVelX, y: bulletVelY }, shipId, 25);
  const newBullets = [...state.bullets, bullet];

  return { ...state, bullets: newBullets };
}

// =============================================================================
// Sensor / Bot Perception
// =============================================================================

/**
 * Bot perception range in px. Scaled proportionally to the 12× world
 * area: 200 in the old 800px world → 600 in the new 2800px world. Bots
 * can now see threats and opponents at meaningful tactical distance.
 */
const SENSOR_RANGE = 600;

/**
 * Shift `other`'s position into `viewer`'s toroidal local frame.
 *
 * Returns a copy of `other` with `pos` adjusted so that
 * `other.pos.x - viewer.pos.x` and `other.pos.y - viewer.pos.y` give the
 * shortest signed deltas across the wrapping world. The viewer's own
 * `ship.pos` stays absolute, so absolute-frame logic (e.g. "orbit the
 * world centroid") still works.
 */
function shiftIntoLocalFrame<T extends { pos: Vector2D }>(
  other: T,
  viewer: ShipState,
  width: number,
  height: number,
): T {
  const halfW = width / 2;
  const halfH = height / 2;
  let dx = other.pos.x - viewer.pos.x;
  let dy = other.pos.y - viewer.pos.y;
  if (dx > halfW) dx -= width;
  else if (dx < -halfW) dx += width;
  if (dy > halfH) dy -= height;
  else if (dy < -halfH) dy += height;
  // Shallow copy with a rewritten `pos`. Bots receive the structured-clone
  // anyway when this crosses the isolate boundary, so shared internal refs
  // are not a concern.
  return { ...other, pos: { x: viewer.pos.x + dx, y: viewer.pos.y + dy } };
}

/**
 * Build the BotState for a specific ship.
 *
 * Provides a limited view of the world (sensor range + full asteroid
 * awareness). Crucially, every visible opponent/asteroid/bullet is
 * delivered in the viewer's **toroidal local frame**: their `pos` is
 * shifted so that `other.pos.x - ship.pos.x` is the shortest signed
 * distance across the wrapping world. Sensor-range filtering is also
 * toroidal — a target 20 px across the seam is visible, not "780 px away."
 *
 * The viewer's own `ship.pos` is unchanged (absolute world coords) so
 * absolute-frame logic (e.g. "orbit world centroid (400,300)") works.
 */
export function buildBotState(
  state: GameState,
  shipId: string,
): BotStateType | null {
  const ship = state.ships.find((s) => s.id === shipId);
  if (!ship) return null;
  const W = state.worldWidth;
  const H = state.worldHeight;

  // Toroidal sensor filter + local-frame projection in one pass.
  const visibleAsteroids: Asteroid[] = [];
  for (const a of state.asteroids) {
    if (toroidalDist(a.pos, ship.pos, W, H) <= SENSOR_RANGE) {
      visibleAsteroids.push(shiftIntoLocalFrame(a, ship, W, H));
    }
  }
  // Every other LIVE ship is visible (full opponent list), in local frame.
  // Dead ships (health <= 0) are filtered out so bots never target corpses.
  const allOpponents: ShipState[] = [];
  const nearbyOpponents: ShipState[] = [];
  for (const s of state.ships) {
    if (s.id === shipId) continue;
    if (s.health <= 0) continue;
    const shifted = shiftIntoLocalFrame(s, ship, W, H);
    allOpponents.push(shifted);
    if (toroidalDist(s.pos, ship.pos, W, H) <= SENSOR_RANGE) {
      nearbyOpponents.push(shifted);
    }
  }
  const visibleBullets: Bullet[] = [];
  for (const b of state.bullets) {
    if (toroidalDist(b.pos, ship.pos, W, H) <= SENSOR_RANGE) {
      visibleBullets.push(shiftIntoLocalFrame(b, ship, W, H));
    }
  }
  // Full-awareness asteroid list (all asteroids in local frame, not range-limited).
  const allAsteroidsLocal: Asteroid[] = state.asteroids.map((a) =>
    shiftIntoLocalFrame(a, ship, W, H),
  );
  // Full-awareness bullet list in local frame for the bots that want it.
  const allBulletsLocal: Bullet[] = state.bullets.map((b) =>
    shiftIntoLocalFrame(b, ship, W, H),
  );

  const nearby = [
    ...visibleAsteroids,
    ...nearbyOpponents,
    ...visibleBullets,
  ] as Entity[];

  return {
    ship,
    nearbyEntities: nearby,
    asteroids: allAsteroidsLocal,
    opponents: allOpponents,
    bullets: allBulletsLocal,
    score: ship.score,
    tick: state.tick,
  } as BotStateType;
}
