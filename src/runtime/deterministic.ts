/**
 * @module deterministic
 *
 * Emits a JS snippet that installs deterministic globals inside an
 * isolated-vm context. We use a string snippet (not pre-compiled host code)
 * so `_dtTime` and `_prngState` end up on the bot's global scope, where
 * the host can mutate them per tick via a one-line `evalSync` without
 * recompiling.
 *
 * Math.random algorithm matches `SeededRNG.next()` in `engine/utils.ts` —
 * keep the two in sync.
 */
export function deterministicSetupCode(seed: number, tickMs: number): string {
  return `
    var _prngState = ${seed | 0};
    var _dtTime = 0;
    Math.random = function() {
      _prngState = (_prngState + 0x6D2B79F5) | 0;
      var t = Math.imul(_prngState ^ (_prngState >>> 15), 1 | _prngState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    Date.now = function() { return _dtTime; };
    if (typeof performance === 'undefined') {
      globalThis.performance = { now: function() { return _dtTime; } };
    } else {
      performance.now = function() { return _dtTime; };
    }
    var __noop = function() {};
    globalThis.setTimeout = __noop;
    globalThis.setInterval = __noop;
    globalThis.clearTimeout = __noop;
    globalThis.clearInterval = __noop;
    globalThis.queueMicrotask = __noop;
    globalThis.console = { log: __noop, warn: __noop, error: __noop, info: __noop, debug: __noop };
    globalThis.fetch = __noop;
    globalThis.XMLHttpRequest = __noop;
    globalThis.require = __noop;
    globalThis.process = undefined;
    globalThis.global = undefined;
    globalThis.__tickMs = ${tickMs};
  `;
}

/** Build the JS snippet that advances `_dtTime` to a new tick. */
export function advanceTimeCode(tickNumber: number, tickMs: number): string {
  return `_dtTime = ${tickNumber * tickMs};`;
}
