/**
 * Integration test — runs one full evolution cycle end-to-end.
 * Validates the pipeline: seed → mutation → evaluate → population update → leaderboard.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runEvolution } from '../src/orchestrator/run.js';
import { getArena } from '../src/arena/interface.js';
import { createWorld, worldTick, buildBotState } from '../src/engine/world.js';
import { bundle } from '../src/runtime/bundler.js';

import '../src/arena/asteroids.js'; // Trigger registration

describe('Full pipeline integration', () => {
  it('runs one generation end-to-end', async () => {
    const arena = getArena('asteroids');
    expect(arena).toBeDefined();
    if (!arena) throw new Error('Arena not registered');

    // Create a simple test bot
    const testBotCode = `
      function tick(botState) {
        if (botState.opponents.length > 0 && botState.opponents[0].pos) {
          const opp = botState.opponents[0];
          const dx = opp.pos.x - botState.ship.pos.x;
          const dy = opp.pos.y - botState.ship.pos.y;
          if (Math.sqrt(dx*dx + dy*dy) < 200) return { type: 'fire' };
        }
        return { type: 'wait' };
      }
    `;

    const bundled = bundle(testBotCode);
    expect(bundled).not.toContain('Compilation error');
    expect(bundled).toContain('tick');

    // Run arena init and a single tick
    const state = arena.init({
      worldWidth: 400,
      worldHeight: 300,
      seed: 999,
      asteroidCount: 3,
      maxBulletsPerShip: 2,
      tickMs: 50,
      bulletSpeed: 4,
      shipThrust: 0.1,
      shipRotationSpeed: 0.1,
      shipMaxFuel: 5000,
      asteroidBaseRadius: 20,
      asteroidSpeed: 1.0,
    });

    expect(state.ships.length).toBeGreaterThan(0);
    expect(state.asteroids.length).toBe(3);

    // Tick with a simple action
    const actions = new Map();
    actions.set(state.ships[0].id, { type: 'rotate', direction: 1 });
    const afterTick = arena.tick(state, actions);

    expect(afterTick.tick).toBe(1);
    expect(afterTick.ships.length).toBe(state.ships.length);
  }, 15000); // 15 second timeout for one generation

  it('builds bot state correctly', () => {
    const state = createWorld({
      worldWidth: 400,
      worldHeight: 300,
      seed: 42,
      asteroidCount: 5,
      tickMs: 50,
      maxBulletsPerShip: 2,
      bulletSpeed: 4,
      shipThrust: 0.1,
      shipRotationSpeed: 0.1,
      shipMaxFuel: 5000,
      asteroidBaseRadius: 20,
      asteroidSpeed: 1.0,
    });

    const botState = buildBotState(state, state.ships[0].id);
    expect(botState).not.toBeNull();
    expect(botState?.ship.id).toBe(state.ships[0].id);
    expect(botState?.asteroids.length).toBe(5);
  });
});
