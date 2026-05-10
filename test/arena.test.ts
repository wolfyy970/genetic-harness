/**
 * Tests for the ArenaPlugin interface and registry.
 */

import { describe, it, expect } from 'vitest';
import '../src/arena/asteroids.js';  // Triggers arena registration
import { getArena } from '../src/arena/interface.js';

describe('Arenas', () => {
  it('registers the asteroids arena', () => {
    const arena = getArena('asteroids');
    expect(arena).toBeDefined();
    expect(arena?.init).toBeDefined();
    expect(arena?.tick).toBeDefined();
    expect(arena?.score).toBeDefined();
    expect(arena?.renderer).toBeDefined();
  });
});
