/**
 * @module interface
 */

/**
 * Arena plugin interface and registry.
 *
 * The plugin system allows different games to be plugged in
 * while the orchestrator interacts with a consistent API.
 */

import type { ArenaPlugin } from '../shared/types.js';

const arenas = new Map<string, ArenaPlugin>();
const DEFAULT_ARENA = 'asteroids';

/**
 * Register an arena plugin under a given name.
 */
export function registerArena(name: string, plugin: ArenaPlugin): void {
  if (arenas.has(name)) {
    console.warn(`Arena "${name}" already registered, overwriting.`);
  }
  arenas.set(name, plugin);
}

/**
 * Get an arena plugin by name. Returns undefined if not found.
 * Uses 'asteroids' as the default arena when no name is provided.
 */
export function getArena(name: string = DEFAULT_ARENA): ArenaPlugin | undefined {
  return arenas.get(name);
}

/**
 * Get the name of the default arena.
 */
export function getDefaultArena(): string {
  return DEFAULT_ARENA;
}
