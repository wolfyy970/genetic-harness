/**
 * Tests for the polygonal asteroid extension (Slice B).
 *
 * Locks the deterministic-from-seed shape, vertex count, and rotation
 * advancement, plus the renderer/replay-frame contract that the dashboard
 * viewer depends on.
 */

import { describe, it, expect } from 'vitest';
import { createWorld, worldTick } from '../src/engine/world.js';
import { toReplayFrame } from '../src/engine/renderer.js';
import { generateAsteroidVertices, SeededRNG } from '../src/engine/utils.js';
import type { GameConfig } from '../src/shared/types.js';

const CONFIG: GameConfig = {
  worldWidth: 800,
  worldHeight: 600,
  seed: 42,
  asteroidCount: 4,
  tickMs: 50,
  maxBulletsPerShip: 3,
  bulletSpeed: 8,
  shipThrust: 0.15,
  shipRotationSpeed: 0.08,
  shipMaxFuel: 10000,
  asteroidBaseRadius: 25,
  asteroidSpeed: 2.5,
  shipCount: 2,
};

describe('generateAsteroidVertices', () => {
  it('produces the requested number of vertices', () => {
    const verts = generateAsteroidVertices(30, new SeededRNG(1), 8);
    expect(verts.length).toBe(8);
  });

  it('is deterministic from the RNG seed', () => {
    const a = generateAsteroidVertices(30, new SeededRNG(99));
    const b = generateAsteroidVertices(30, new SeededRNG(99));
    expect(a).toEqual(b);
  });

  it('jitters vertex distance within ±25% of radius', () => {
    const r = 40;
    const verts = generateAsteroidVertices(r, new SeededRNG(7), 12);
    for (const v of verts) {
      const dist = Math.sqrt(v.x * v.x + v.y * v.y);
      expect(dist).toBeGreaterThanOrEqual(r * 0.75 - 1e-9);
      expect(dist).toBeLessThanOrEqual(r * 1.25 + 1e-9);
    }
  });
});

describe('createWorld asteroid shape', () => {
  it('every spawned asteroid has vertices and rotation fields', () => {
    const world = createWorld(CONFIG);
    expect(world.asteroids.length).toBeGreaterThan(0);
    for (const a of world.asteroids) {
      expect(Array.isArray(a.vertices)).toBe(true);
      expect(a.vertices.length).toBeGreaterThan(0);
      expect(typeof a.rotation).toBe('number');
      expect(typeof a.angularVel).toBe('number');
    }
  });

  it('same seed reproduces identical asteroid shapes (cross-machine determinism)', () => {
    const a = createWorld(CONFIG).asteroids;
    const b = createWorld(CONFIG).asteroids;
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i].vertices).toEqual(b[i].vertices);
      expect(a[i].rotation).toBe(b[i].rotation);
    }
  });
});

describe('worldTick advances asteroid rotation', () => {
  it('rotation increases by angularVel each tick', () => {
    const world = createWorld(CONFIG);
    const before = world.asteroids[0].rotation;
    const angularVel = world.asteroids[0].angularVel;
    const next = worldTick(world, new Map());
    const after = next.asteroids[0].rotation;
    expect(after).toBeCloseTo(before + angularVel, 9);
  });
});

describe('ReplayFrame asteroid serialization', () => {
  it('emits vertices, rotation, and tier per asteroid', () => {
    const world = createWorld(CONFIG);
    const frame = toReplayFrame(world);
    const ast = frame.entities.find((e) => e.type === 'asteroid');
    expect(ast).toBeDefined();
    expect(Array.isArray(ast!.vertices)).toBe(true);
    expect(ast!.vertices!.length).toBeGreaterThan(0);
    expect(typeof ast!.rotation).toBe('number');
    expect(['LARGE', 'MEDIUM', 'SMALL']).toContain(ast!.tier);
  });
});

describe('Asteroid tier semantics', () => {
  it('all initial spawns are LARGE', () => {
    const world = createWorld(CONFIG);
    for (const a of world.asteroids) {
      expect(a.tier).toBe('LARGE');
    }
  });

  it('LARGE → 2 MEDIUM on bullet kill', async () => {
    const { detectCollisions } = await import('../src/engine/collision.js');
    const world = createWorld({ ...CONFIG, asteroidCount: 1 });
    // Place a single LARGE asteroid + a co-located lethal bullet.
    const ast = world.asteroids[0];
    ast.health = 1;
    world.bullets.push({
      id: 'b1',
      type: 'bullet',
      pos: { x: ast.pos.x, y: ast.pos.y },
      vel: { x: 0, y: 0 },
      damage: 25,
      owner: 'nobody',
      age: 0,
      maxAge: 100,
    });
    detectCollisions(world);
    expect(world.asteroids.length).toBe(2);
    for (const f of world.asteroids) expect(f.tier).toBe('MEDIUM');
  });

  it('MEDIUM → 2 SMALL on bullet kill', async () => {
    const { detectCollisions } = await import('../src/engine/collision.js');
    const world = createWorld({ ...CONFIG, asteroidCount: 0 });
    world.asteroids.push({
      id: 'm1',
      type: 'asteroid',
      pos: { x: 100, y: 100 },
      vel: { x: 0.5, y: 0 },
      radius: 25,
      health: 1,
      mass: 1,
      tier: 'MEDIUM',
      vertices: [],
      rotation: 0,
      angularVel: 0,
    });
    world.bullets.push({
      id: 'b1',
      type: 'bullet',
      pos: { x: 100, y: 100 },
      vel: { x: 0, y: 0 },
      damage: 25,
      owner: 'nobody',
      age: 0,
      maxAge: 100,
    });
    detectCollisions(world);
    expect(world.asteroids.length).toBe(2);
    for (const f of world.asteroids) expect(f.tier).toBe('SMALL');
  });

  it('SMALL → destroyed with no fragments', async () => {
    const { detectCollisions } = await import('../src/engine/collision.js');
    const world = createWorld({ ...CONFIG, asteroidCount: 0 });
    world.asteroids.push({
      id: 's1',
      type: 'asteroid',
      pos: { x: 100, y: 100 },
      vel: { x: 0, y: 0 },
      radius: 12,
      health: 1,
      mass: 1,
      tier: 'SMALL',
      vertices: [],
      rotation: 0,
      angularVel: 0,
    });
    world.bullets.push({
      id: 'b1',
      type: 'bullet',
      pos: { x: 100, y: 100 },
      vel: { x: 0, y: 0 },
      damage: 25,
      owner: 'nobody',
      age: 0,
      maxAge: 100,
    });
    detectCollisions(world);
    expect(world.asteroids.length).toBe(0);
  });

  it('fragments are faster than their parent', async () => {
    const { detectCollisions } = await import('../src/engine/collision.js');
    const world = createWorld({ ...CONFIG, asteroidCount: 0 });
    const parentSpeed = 1.0;
    world.asteroids.push({
      id: 'p1',
      type: 'asteroid',
      pos: { x: 200, y: 200 },
      vel: { x: parentSpeed, y: 0 },
      radius: 45,
      health: 1,
      mass: 1,
      tier: 'LARGE',
      vertices: [],
      rotation: 0,
      angularVel: 0,
    });
    world.bullets.push({
      id: 'b1',
      type: 'bullet',
      pos: { x: 200, y: 200 },
      vel: { x: 0, y: 0 },
      damage: 25,
      owner: 'nobody',
      age: 0,
      maxAge: 100,
    });
    detectCollisions(world);
    expect(world.asteroids.length).toBe(2);
    for (const f of world.asteroids) {
      const speed = Math.sqrt(f.vel.x * f.vel.x + f.vel.y * f.vel.y);
      // childSpec.speedFactor 1.5 × max(1, parentSpeed=1) × [0.85, 1.15] →
      // worst case ~1.275, but we conservatively require > parentSpeed.
      expect(speed).toBeGreaterThan(parentSpeed);
    }
  });
});
