/**
 * Tests for the game engine (utils, actions, world, collision, renderer).
 */

import { describe, it, expect } from 'vitest';
import {
  wrapPosition,
  dist,
  angleBetween,
  lerp,
  SeededRNG,
  clamp,
} from '../src/engine/utils.js';
import { parseBotAction, describeAction } from '../src/engine/actions.js';
import { createWorld, worldTick, spawnBullet, buildBotState } from '../src/engine/world.js';
import { detectCollisions } from '../src/engine/collision.js';
import { toReplayFrame } from '../src/engine/renderer.js';
import type { GameConfig } from '../src/shared/types.js';

// =============================================================================
// Utils tests
// =============================================================================

describe('Utils', () => {
  it('wraps positions that exceed world bounds', () => {
    const wrapped = wrapPosition({ x: 1300, y: 900 }, 1200, 800);
    expect(wrapped.x).toBe(100);
    expect(wrapped.y).toBe(100);
  });

  it('handles negative wrapped positions', () => {
    const wrapped = wrapPosition({ x: -50, y: -100 }, 1200, 800);
    expect(wrapped.x).toBe(1150);
    expect(wrapped.y).toBe(700);
  });

  it('leaves valid positions unchanged', () => {
    const pos = { x: 500, y: 400 };
    const wrapped = wrapPosition(pos, 1200, 800);
    expect(wrapped).toEqual(pos);
  });

  it('calculates distance correctly', () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
    expect(dist({ x: 1, y: 1 }, { x: 1, y: 1 })).toBeCloseTo(0);
  });

  it('calculates angle between two points', () => {
    const angle = angleBetween({ x: 0, y: 0 }, { x: 1, y: 0 });
    expect(angle).toBeCloseTo(0);
  });

  it('clamps values correctly', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('lerps correctly', () => {
    expect(lerp(0, 10, 0.5)).toBeCloseTo(5);
    expect(lerp(0, 10, 0)).toBeCloseTo(0);
    expect(lerp(0, 10, 1)).toBeCloseTo(10);
  });

  it('SeededRNG produces deterministic results', () => {
    const rng1 = new SeededRNG(12345);
    const rng2 = new SeededRNG(12345);
    for (let i = 0; i < 10; i++) {
      expect(rng1.next()).toBeCloseTo(rng2.next());
    }
  });

  it('SeededRNG gives different sequences for different seeds', () => {
    const rng1 = new SeededRNG(12345);
    const rng2 = new SeededRNG(54321);
    expect(rng1.next()).not.toBeCloseTo(rng2.next());
  });

  it('SeededRNG picks elements correctly', () => {
    const rng = new SeededRNG(42);
    const arr = ['a', 'b', 'c', 'd', 'e'];
    const picked = rng.pick(arr);
    expect(['a', 'b', 'c', 'd', 'e']).toContain(picked);
  });

  it('SeededRNG shuffles deterministically', () => {
    const rng1 = new SeededRNG(42);
    const rng2 = new SeededRNG(42);
    const arr1 = [1, 2, 3, 4, 5];
    const arr2 = [1, 2, 3, 4, 5];
    rng1.shuffle(arr1);
    rng2.shuffle(arr2);
    expect(arr1).toEqual(arr2);
  });
});

// =============================================================================
// Actions tests
// =============================================================================

describe('Actions', () => {
  it('parses string actions', () => {
    expect(parseBotAction('thrust')).toEqual({ type: 'thrust', angle: 0 });
    expect(parseBotAction('rotate-left')).toEqual({ type: 'rotate', direction: -1 });
    expect(parseBotAction('rotate-right')).toEqual({ type: 'rotate', direction: 1 });
    expect(parseBotAction('fire')).toEqual({ type: 'fire' });
    expect(parseBotAction('wait')).toEqual({ type: 'wait' });
    expect(parseBotAction('invalid')).toEqual({ type: 'wait' });
  });

  it('parses object actions', () => {
    expect(parseBotAction({ type: 'thrust', angle: 1.57 })).toEqual({
      type: 'thrust',
      angle: 1.57,
    });
    expect(parseBotAction({ type: 'fire' })).toEqual({ type: 'fire' });
  });

  it('describes actions correctly', () => {
    expect(describeAction({ type: 'thrust', angle: 0 })).toContain('thrust');
    expect(describeAction({ type: 'fire' })).toBe('fire');
    expect(describeAction({ type: 'wait' })).toBe('wait');
  });
});

// =============================================================================
// World tests
// =============================================================================

describe('World', () => {
  const config: GameConfig = {
    worldWidth: 1200,
    worldHeight: 800,
    seed: 42,
    asteroidCount: 5,
    tickMs: 50,
    maxBulletsPerShip: 3,
    bulletSpeed: 8,
    shipThrust: 0.15,
    shipRotationSpeed: 0.08,
    shipMaxFuel: 10000,
    asteroidBaseRadius: 30,
    asteroidSpeed: 1.5,
  };

  it('creates a world with the correct number of ships', () => {
    const world = createWorld(config);
    expect(world.ships.length).toBeGreaterThan(0);
    expect(world.ships.length).toBeLessThanOrEqual(4);
  });

  it('creates a world with the correct number of asteroids', () => {
    const world = createWorld(config);
    expect(world.asteroids.length).toBe(config.asteroidCount);
  });

  it('ships start with zero velocity', () => {
    const world = createWorld(config);
    for (const ship of world.ships) {
      expect(ship.vel.x).toBeCloseTo(0);
      expect(ship.vel.y).toBeCloseTo(0);
    }
  });

  it('world tick increments the tick counter', () => {
    const world = createWorld(config);
    const updated = worldTick(world, new Map());
    expect(updated.tick).toBe(1);
  });

  it('world tick advances ship positions', () => {
    const world = createWorld(config);
    const initialPos = { ...world.ships[0].pos };
    const actions = new Map<string, any>();
    actions.set(world.ships[0].id, { type: 'thrust' as const, angle: 0 });
    const updated = worldTick(world, actions);
    const ship = updated.ships[0];
    // Ship should have moved due to thrust
    expect(ship.vel.x).toBeGreaterThan(0);
  });

  it('spawning a bullet increases bullet count', () => {
    const world = createWorld(config);
    const before = world.bullets.length;
    const after = spawnBullet(world, world.ships[0].id);
    expect(after.bullets.length).toBe(before + 1);
  });

  it('buildBotState returns valid bot state', () => {
    const world = createWorld(config);
    const botState = buildBotState(world, world.ships[0].id);
    expect(botState).not.toBeNull();
    expect(botState?.ship.id).toBe(world.ships[0].id);
    expect(botState?.asteroids.length).toBe(config.asteroidCount);
    expect(botState?.opponents.length).toBe(world.ships.length - 1);
  });
});

// =============================================================================
// Collision tests
// =============================================================================

describe('Collision', () => {
  const collisionConfig: GameConfig = {
    worldWidth: 1200,
    worldHeight: 800,
    seed: 42,
    asteroidCount: 5,
    tickMs: 50,
    maxBulletsPerShip: 3,
    bulletSpeed: 8,
    shipThrust: 0.15,
    shipRotationSpeed: 0.08,
    shipMaxFuel: 10000,
    asteroidBaseRadius: 30,
    asteroidSpeed: 1.5,
  };

  it('detects bullet-asteroid collision', () => {
    const world = createWorld({
      ...collisionConfig,
      seed: 100,
    });
    // Place a bullet very close to an asteroid
    const asteroid = world.asteroids[0];
    const bullet = {
      id: 'test-bullet',
      type: 'bullet' as const,
      pos: { x: asteroid.pos.x + 5, y: asteroid.pos.y + 5 },
      vel: { x: 0, y: 0 },
      damage: 25,
      owner: 'ship-0',
      age: 0,
      maxAge: 60,
    };
    world.bullets.push(bullet);

    const collisions = detectCollisions(world);
    const bulletHit = collisions.find((c) => c.type === 'bullet_asteroid');
    expect(bulletHit).toBeDefined();
  });

  it('detects asteroid-ship collision', () => {
    const world = createWorld({
      ...collisionConfig,
      seed: 200,
    });
    // Move an asteroid close to a ship
    const ship = world.ships[0];
    const asteroid = world.asteroids[0];
    asteroid.pos = { x: ship.pos.x + 10, y: ship.pos.y + 10 };

    const collisions = detectCollisions(world);
    const shipHit = collisions.find((c) => c.type === 'asteroid_ship');
    expect(shipHit).toBeDefined();
  });
});

// =============================================================================
// Renderer tests
// =============================================================================

describe('Renderer', () => {
  const rendererConfig: GameConfig = {
    worldWidth: 1200,
    worldHeight: 800,
    seed: 42,
    asteroidCount: 5,
    tickMs: 50,
    maxBulletsPerShip: 3,
    bulletSpeed: 8,
    shipThrust: 0.15,
    shipRotationSpeed: 0.08,
    shipMaxFuel: 10000,
    asteroidBaseRadius: 30,
    asteroidSpeed: 1.5,
  };

  it('converts game state to replay frame', () => {
    const world = createWorld(rendererConfig);
    const frame = toReplayFrame(world);
    expect(frame.type).toBe('asteroids');
    expect(frame.tick).toBe(0);
    expect(frame.entities.length).toBeGreaterThan(0);
  });

  it('replay frame includes all entity types', () => {
    const world = createWorld(rendererConfig);
    const frame = toReplayFrame(world);
    const hasShip = frame.entities.some((e) => e.type === 'ship');
    const hasAsteroid = frame.entities.some((e) => e.type === 'asteroid');
    expect(hasShip).toBe(true);
    expect(hasAsteroid).toBe(true);
  });
});
