/**
 * @module deterministic
 *
 * Ensures bots run in a fully deterministic, sandboxed environment
 * inside an isolated-vm context.
 *
 * - Math.random uses a seeded PRNG (Mulberry32) for reproducibility
 * - Date.now / performance.now are tick-driven (not wall-clock)
 * - Non-deterministic APIs (timers, network, modules) are stripped to no-ops
 */

import * as ivm from 'isolated-vm';

/**
 * Sets up deterministic globals inside an isolated-vm context.
 *
 * Seeded from (tickNumber * 31337 + 12345) for determinism across ticks.
 * Strips Math.random, Date.now, performance.now, timers, network, modules.
 *
 * @param isolate  - The isolated-vm isolate to create a context for
 * @param tickNumber - Current game tick number (used for seeding and time)
 * @param tickMs   - Target tick duration in milliseconds
 * @returns A new isolated-vm Context with all deterministic globals configured
 */
export function setupDeterministicContext(
  isolate: ivm.Isolate,
  tickNumber: number,
  tickMs: number,
): ivm.Context {
  const ctx = isolate.createContextSync();

  // Seed derived from tick number and tickMs for determinism across ticks
  const seed = tickNumber * 31337 + 12345;
  const currentTime = tickNumber * tickMs;

  ctx.evalSync(`
    (function() {
      // Seeded PRNG (Mulberry32) for deterministic Math.random
      var _prngState = ${seed};
      Math.random = function() {
        _prngState |= 0;
        _prngState = (_prngState + 0x6D2B79F5) | 0;
        var t = Math.imul(_prngState ^ (_prngState >>> 15), 1 | _prngState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      // Tick-driven time (not wall-clock)
      var _dtTime = ${currentTime};
      Date.now = function() { return _dtTime; };
      performance.now = function() { return _dtTime; };

      // No-op for async timer APIs (bots must not use them)
      var noop = function() {};
      setTimeout = noop;
      setInterval = noop;
      clearTimeout = noop;
      clearInterval = noop;

      // No-op console (bots must not print)
      console = { log: noop, warn: noop, error: noop };

      // No network access
      fetch = noop;
      XMLHttpRequest = noop;

      // No module loading
      require = noop;

      // No process / global access
      process = undefined;
      global = undefined;
    })();
  `);

  return ctx;
}

/**
 * Update time-based globals for a new tick.
 * Call this before each runTick to advance the game clock.
 *
 * @param ctx      - The isolated-vm context
 * @param tickNumber - Current tick number
 * @param tickMs   - Target tick duration in milliseconds
 */
export function updateDeterministicTime(
  ctx: ivm.Context,
  tickNumber: number,
  tickMs: number,
): void {
  const time = tickNumber * tickMs;
  ctx.evalSync(`_dtTime = ${time};`);
}
