/**
 * @module renderer
 */

/**
 * Renderer utilities for the asteroids arena.
 * Converts GameState into ReplayFrame objects suitable for visualization.
 */

import type { GameState, ReplayFrame } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a full `GameState` into a `ReplayFrame` suitable for visualization.
 *
 * Every active entity is included:
 * - **Ships**: position, angle (orientation), health, shield.
 * - **Asteroids**: position, radius, health.
 * - **Bullets**: position only (minimal visual payload).
 *
 * @param state  The current game state to render.
 * @returns      A `ReplayFrame` describing the arena at this tick.
 */
export function toReplayFrame(state: GameState): ReplayFrame {
  const entities: ReplayFrame['entities'] = [];

  // Ships — dead ships (health <= 0) are omitted so the canvas stops
  // rendering corpses once they're destroyed. Their final score still
  // lives in the match report.
  for (const ship of state.ships) {
    if (ship.health <= 0) continue;
    entities.push({
      type: 'ship',
      id: ship.id,
      pos: { x: ship.pos.x, y: ship.pos.y },
      angle: ship.angle,
      health: ship.health,
      shield: ship.shields,
      score: ship.score,
    });
  }

  // Asteroids
  for (const asteroid of state.asteroids) {
    entities.push({
      type: 'asteroid',
      id: asteroid.id,
      pos: { x: asteroid.pos.x, y: asteroid.pos.y },
      radius: asteroid.radius,
      health: asteroid.health,
      vertices: asteroid.vertices.map((v) => ({ x: v.x, y: v.y })),
      rotation: asteroid.rotation,
      tier: asteroid.tier,
    });
  }

  // Bullets
  for (const bullet of state.bullets) {
    entities.push({
      type: 'bullet',
      id: bullet.id,
      pos: { x: bullet.pos.x, y: bullet.pos.y },
    });
  }

  return {
    type: 'asteroids',
    entities,
    tick: state.tick,
  };
}
