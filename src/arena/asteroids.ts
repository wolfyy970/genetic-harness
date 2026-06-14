/**
 * Multiplayer Asteroids arena — the v1 game implementation.
 *
 * Implements the ArenaPlugin interface:
 *   init(config) → GameState
 *   tick(state, agentActions) → GameState
 *   score(state, agentId) → number
 *   renderer(state) → ReplayFrame
 *
 * This module registers itself as the 'asteroids' arena plugin on import.
 *
 * @module arena/asteroids
 */

import type {
  ArenaPlugin,
  GameConfig,
  GameState,
  BotAction,
  ReplayFrame,
} from '../shared/types.js';
import { createWorld, worldTick, spawnBullet } from '../engine/world.js';
import { detectCollisions } from '../engine/collision.js';
import { toReplayFrame } from '../engine/renderer.js';

// Default config — 12× the original 800×600 area to give 8 FFA ships room
// to navigate. Evaluator / replay configs override this anyway, but the
// arena plugin needs sensible defaults for any direct `init()` call.
const DEFAULTS: Partial<GameConfig> = {
  worldWidth: 2800,
  worldHeight: 2100,
  seed: 42,
  asteroidCount: 24,
  tickMs: 50,
  maxBulletsPerShip: 3,
  bulletSpeed: 8,
  shipThrust: 0.15,
  shipRotationSpeed: 0.08,
  shipMaxFuel: 10000,
  asteroidBaseRadius: 30,
  asteroidSpeed: 1.5,
};

/**
 * Create the arena's default config, merged with any overrides.
 */
function makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    worldWidth: DEFAULTS.worldWidth!,
    worldHeight: DEFAULTS.worldHeight!,
    seed: DEFAULTS.seed!,
    asteroidCount: DEFAULTS.asteroidCount!,
    tickMs: DEFAULTS.tickMs!,
    maxBulletsPerShip: DEFAULTS.maxBulletsPerShip!,
    bulletSpeed: DEFAULTS.bulletSpeed!,
    shipThrust: DEFAULTS.shipThrust!,
    shipRotationSpeed: DEFAULTS.shipRotationSpeed!,
    shipMaxFuel: DEFAULTS.shipMaxFuel!,
    asteroidBaseRadius: DEFAULTS.asteroidBaseRadius!,
    asteroidSpeed: DEFAULTS.asteroidSpeed!,
    ...overrides,
  };
}

export const asteroids: ArenaPlugin = {
  /**
   * Initialize a new game.
   * Creates ships at corners and spawns asteroids away from them.
   */
  init(overrides: Partial<GameConfig> = {}): GameState {
    const config = makeConfig(overrides);
    return createWorld(config);
  },

  /**
   * Advance the game by one tick.
   *
   * Steps:
   *   1. Apply bot actions from the agentActions map
   *   2. Run physics (worldTick handles ship movement, asteroid drift, bullet aging)
   *   3. Spawn bullets for ships that fired
   *   4. Run collision detection and resolve
   *   5. Update scores
   */
  tick(state: GameState, agentActions: Map<string, BotAction>): GameState {
    // Apply bot actions and run physics
    let newState = worldTick(state, agentActions);

    // Spawn bullets for ships that requested fire
    for (const [shipId, action] of Array.from(agentActions.entries())) {
      if (action.type === 'fire') {
        newState = spawnBullet(newState, shipId);
      }
    }

    // Detect and resolve collisions
    const collisions = detectCollisions(newState);

    // Apply collision effects (in-place mutation)
    // detectCollisions already mutates state — remove dead bullets/asteroids,
    // apply damage to ships, etc.

    return newState;
  },

  /**
   * Return the score for a specific agent.
   */
  score(state: GameState, agentId: string): number {
    const ship = state.ships.find((s) => s.id === agentId);
    return ship ? ship.score : 0;
  },

  /**
   * Generate a replay frame for visualization.
   */
  renderer(state: GameState): ReplayFrame {
    return toReplayFrame(state);
  },
};

// Register this arena as the default
import { registerArena } from './interface.js';
registerArena('asteroids', asteroids);
