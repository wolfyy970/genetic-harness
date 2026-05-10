/**
 * Utility functions for vector math, distance calculation, and pseudo-random number generation.
 *
 * @module utils
 */

import type { Vector2D, ShipState, Asteroid, Bullet } from '../shared/types.js';

/**
 * Whether coordinate wrapping is enabled (default: true).
 * When true, entities that move past world bounds wrap to the opposite side.
 */
export const WORLD_WRAP = true;

/**
 * Wrap coordinates to world bounds.
 *
 * If `WORLD_WRAP` is false, returns `pos` unchanged.
 * Handles negative values correctly (unlike a simple `%` operator).
 *
 * @param pos     - The position vector to wrap
 * @param width   - World width in pixels
 * @param height  - World height in pixels
 * @returns Wrapped position vector
 */
export function wrapPosition(pos: Vector2D, width: number, height: number): Vector2D {
  if (!WORLD_WRAP) return pos;
  return {
    x: ((pos.x % width) + width) % width,
    y: ((pos.y % height) + height) % height,
  };
}

/**
 * Clamp a value between min and max bounds.
 *
 * @param val - Value to clamp
 * @param min - Minimum bound
 * @param max - Maximum bound
 * @returns `val` clamped to [min, max]
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/**
 * Euclidean distance between two points.
 *
 * @param a - First point
 * @param b - Second point
 * @returns Distance as a floating-point number
 */
export function dist(a: Vector2D, b: Vector2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Angle (in radians) from point `a` to point `b`.
 *
 * Returns the angle in the range [-π, π] measured from the positive x-axis.
 *
 * @param a - Origin point
 * @param b - Target point
 * @returns Angle in radians
 */
export function angleBetween(a: Vector2D, b: Vector2D): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * Linear interpolation between two values.
 *
 * @param a - Start value
 * @param b - End value
 * @param t - Interpolation factor (0 = a, 1 = b, 0.5 = midpoint)
 * @returns Interpolated value
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Seeded pseudo-random number generator using the Mulberry32 algorithm.
 *
 * Produces a deterministic sequence of numbers in [0, 1) from a given seed.
 * Used for reproducible asteroid spawning, bot behavior, etc.
 *
 * @example
 * ```ts
 * const rng = new SeededRNG(42);
 * const x = rng.nextRange(0, 100);  // deterministic
 * const item = rng.pick(availableOptions);
 * ```
 */
export class SeededRNG {
  private state: number;

  /**
   * Create a new SeededRNG with the given seed.
   *
   * @param seed - Integer seed for deterministic random generation
   */
  constructor(seed: number) {
    this.state = seed | 0;
  }

  /**
   * Generate the next random number in [0, 1).
   *
   * @returns A floating-point number ≥ 0 and < 1
   */
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6D2B79F5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Generate a random number in [min, max).
   *
   * @param min - Lower bound (inclusive)
   * @param max - Upper bound (exclusive)
   * @returns Random number in [min, max)
   */
  nextRange(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /**
   * Generate a random number in [min, max]. (inclusive on both ends)
   *
   * @param min - Lower bound (inclusive)
   * @param max - Upper bound (inclusive)
   * @returns Random number in [min, max]
   */
  nextRangeInclusive(min: number, max: number): number {
    return min + this.next() * (max - min + 1);
  }

  /**
   * Pick a random element from an array.
   *
   * @param arr - Non-empty array to pick from
   * @returns A randomly selected element
   */
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /**
   * Shuffle an array in place using Fisher-Yates algorithm.
   *
   * @param arr - Array to shuffle (modified in place)
   * @returns The same array reference (for chaining)
   */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
