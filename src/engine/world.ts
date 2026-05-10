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
  angleBetween,
  SeededRNG,
  clamp,
} from './utils.js';
import { applyActionToShip } from './actions.js';
import { logger } from '../shared/logger.js';

// =============================================================================
// Constants
// =============================================================================

const MAX_BULLETS = 128;
const BULLET_LIFETIME = 60;
const ASTEROID_SPAWN_MARGIN = 100;
const ASTEROID_MARGIN = ASTEROID_SPAWN_MARGIN;
const FRICTION = 0.999;
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

function createAsteroid(
  pos: Vector2D,
  radius: number,
  vel: Vector2D,
  config: GameConfig,
  rng: SeededRNG,
): Asteroid {
  const health = Math.ceil(radius / 15);
  const mass = Math.PI * radius * radius * 0.01;
  return {
    id: nextId(),
    type: 'asteroid',
    pos: { ...pos },
    vel: { ...vel },
    radius,
    health,
    mass,
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

  // Spawn ships at corners
  const shipPositions: Vector2D[] = [
    { x: config.worldWidth * 0.25, y: config.worldHeight * 0.25 },
    { x: config.worldWidth * 0.75, y: config.worldHeight * 0.25 },
    { x: config.worldWidth * 0.25, y: config.worldHeight * 0.75 },
    { x: config.worldWidth * 0.75, y: config.worldHeight * 0.75 },
  ];

  const shipCount = Math.min(4, config.worldWidth * config.worldHeight / 50000);
  for (let i = 0; i < shipCount; i++) {
    const pos = shipPositions[i % shipPositions.length];
    const angle = rng.nextRangeInclusive(0, Math.PI * 2);
    ships.push(createShip(`ship-${i}`, pos, angle, config));
  }

  // Spawn asteroids away from ships
  for (let i = 0; i < config.asteroidCount; i++) {
    let pos: Vector2D = { x: 0, y: 0 };
    let valid = false;
    let attempts = 0;

    while (!valid && attempts < 20) {
      pos = {
        x: rng.nextRange(ASTEROID_MARGIN, config.worldWidth - ASTEROID_MARGIN),
        y: rng.nextRange(ASTEROID_MARGIN, config.worldHeight - ASTEROID_MARGIN),
      };
      valid = true;
      for (const ship of ships) {
        if (dist(pos, ship.pos) < 150) {
          valid = false;
          break;
        }
      }
      attempts++;
    }

    if (!valid) {
      pos = {
        x: rng.nextRange(ASTEROID_MARGIN, config.worldWidth - ASTEROID_MARGIN),
        y: rng.nextRange(ASTEROID_MARGIN, config.worldHeight - ASTEROID_MARGIN),
      };
    }

    const radius = rng.nextRangeInclusive(
      config.asteroidBaseRadius,
      config.asteroidBaseRadius * 3,
    );
    const speed = rng.nextRange(0.1, config.asteroidSpeed);
    const angle = rng.nextRangeInclusive(0, Math.PI * 2);
    const vel = {
      x: Math.cos(angle) * speed,
      y: Math.sin(angle) * speed,
    };

    asteroids.push(createAsteroid(pos, radius, vel, config, rng));
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
      .map((b) => ({ ...b, age: b.age + 1 }))
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

    // Thrust
    if (ship.thrust && ship.fuel > 0) {
      const thrustX = Math.cos(ship.thrustAngle) * state.config.shipThrust;
      const thrustY = Math.sin(ship.thrustAngle) * state.config.shipThrust;
      ship.vel.x += thrustX;
      ship.vel.y += thrustY;
      ship.fuel -= Math.abs(thrustX) + Math.abs(thrustY);
    } else {
      ship.thrust = false;
    }

    // Natural damping
    ship.vel.x *= FRICTION;
    ship.vel.y *= FRICTION;

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

const SENSOR_RANGE = 200;

/**
 * Build the BotState for a specific ship.
 * Provides a limited view of the world (sensor range + full asteroid awareness).
 */
export function buildBotState(
  state: GameState,
  shipId: string,
): BotStateType | null {
  const ship = state.ships.find((s) => s.id === shipId);
  if (!ship) return null;

  const opponents = state.ships.filter((s) => s.id !== shipId);
  const nearbyAsteroids: Asteroid[] = state.asteroids.filter(
    (a) => dist(a.pos, ship.pos) <= SENSOR_RANGE,
  );
  const nearbyOpponents: ShipState[] = opponents.filter(
    (s) => dist(s.pos, ship.pos) <= SENSOR_RANGE,
  );
  const nearbyBullets: Bullet[] = state.bullets.filter(
    (b) => dist(b.pos, ship.pos) <= SENSOR_RANGE,
  );
  const nearby = [
    ...nearbyAsteroids,
    ...nearbyOpponents,
    ...nearbyBullets,
  ] as Entity[];

  return {
    ship,
    nearbyEntities: nearby,
    asteroids: state.asteroids,
    opponents,
    bullets: state.bullets,
    score: ship.score,
    tick: state.tick,
  } as BotStateType;
}
