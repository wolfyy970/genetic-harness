/**
 * Tests for dead-ship handling — both perceptual and visual.
 *
 * Once a ship's health hits 0:
 *   1. It must not appear in any *other* ship's `opponents` list (bots
 *      should never target corpses).
 *   2. It must not appear in the per-frame replay output (the canvas
 *      stops rendering it).
 *   3. Its `id` is still in `state.ships` so the per-ship report at
 *      match end can read its final score.
 */

import { describe, it, expect } from 'vitest';
import { createWorld, buildBotState } from '../src/engine/world.js';
import { toReplayFrame } from '../src/engine/renderer.js';
import type { GameConfig } from '../src/shared/types.js';

const BASE: GameConfig = {
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
  shipCount: 3,
};

describe('buildBotState — dead ships are invisible to live bots', () => {
  it('omits a dead opponent from the live bot\'s opponents list', () => {
    const w = createWorld(BASE);
    // Kill ship-1; ship-0 should no longer see it.
    w.ships[1].health = 0;
    const bs = buildBotState(w, 'ship-0')!;
    expect(bs).not.toBeNull();
    const ids = bs.opponents.map((s) => s.id);
    expect(ids).not.toContain('ship-1');
    // ship-2 is still alive and still visible.
    expect(ids).toContain('ship-2');
  });

  it('omits a dead opponent from nearbyEntities even when in range', () => {
    const w = createWorld(BASE);
    // Position ship-1 right next to ship-0, then kill it.
    w.ships[1].pos = { x: w.ships[0].pos.x + 30, y: w.ships[0].pos.y };
    w.ships[1].health = 0;
    const bs = buildBotState(w, 'ship-0')!;
    const nearbyShips = bs.nearbyEntities.filter((e) => e.type === 'ship');
    expect(nearbyShips.find((s) => s.id === 'ship-1')).toBeUndefined();
  });

  it('preserves the dead ship in state.ships for end-of-match accounting', () => {
    const w = createWorld(BASE);
    w.ships[1].health = 0;
    // The raw state still tracks the dead ship — only the bots' view filters it.
    expect(w.ships.find((s) => s.id === 'ship-1')).toBeDefined();
  });
});

describe('toReplayFrame — dead ships are not rendered', () => {
  it('omits a dead ship from the rendered entities', () => {
    const w = createWorld(BASE);
    w.ships[1].health = 0;
    const frame = toReplayFrame(w);
    const renderedShipIds = frame.entities
      .filter((e) => e.type === 'ship')
      .map((e) => e.id);
    expect(renderedShipIds).not.toContain('ship-1');
    // Live ships still render.
    expect(renderedShipIds).toContain('ship-0');
    expect(renderedShipIds).toContain('ship-2');
  });

  it('renders all 3 ships when none are dead', () => {
    const w = createWorld(BASE);
    const frame = toReplayFrame(w);
    const renderedShipIds = frame.entities
      .filter((e) => e.type === 'ship')
      .map((e) => e.id);
    expect(renderedShipIds.length).toBe(3);
  });
});
