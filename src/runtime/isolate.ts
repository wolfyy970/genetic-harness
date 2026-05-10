/**
 * @module isolate
 *
 * V8 isolate pool for executing bot tick functions.
 *
 * Each bot lives in its own ivm.Isolate (separate heap, separate GC). The
 * bot bundle is compiled and run *inside that isolate's context once*, so
 * `globalThis.tick` is captured as an `ivm.Reference`. Per-tick execution
 * uses `applySync` with a CPU-time-budget timeout, which is the path
 * isolated-vm guarantees as monotonically deterministic at the V8 level.
 *
 * CPU time accounting: `isolate.cpuTime` is bigint nanoseconds of thread
 * time spent inside the isolate. Sampling before/after each `applySync`
 * yields a per-tick "fuel" measurement — a strong proxy for compute even
 * before we move to Wasmtime's deterministic fuel counter.
 */

import ivm from 'isolated-vm';
import { logger } from '../shared/logger.js';
import type { BotAction, BotState } from '../shared/types.js';
import { deterministicSetupCode, advanceTimeCode } from './deterministic.js';

/** Default per-isolate heap cap (MB). 64 MB matches the design doc. */
const DEFAULT_MEMORY_LIMIT_MB = 64;

/** Default tick duration in milliseconds for time virtualization. */
const DEFAULT_TICK_MS = 50;

/**
 * A bot compiled into a live isolate, ready to execute ticks.
 *
 * Holds direct references to the isolate, its context, and the captured
 * `tick` function. Per-tick CPU cost is sampled by reading
 * `isolate.cpuTime` before and after each `runTick` call.
 */
export interface CompiledBot {
  isolate: ivm.Isolate;
  context: ivm.Context;
  tickRef: ivm.Reference;
}

/** Result of a single per-tick execution. */
export interface TickResult {
  /** Action returned by the bot, or null if the bot crashed or timed out. */
  action: BotAction | null;
  /** Nanoseconds of cpuTime consumed by this tick alone. */
  cpuNanos: bigint;
  /** Set if the tick crashed or timed out. */
  error?: string;
}

/**
 * A pool of compiled bots. Owns the lifecycle of each isolate it creates.
 */
export class IsolatePool {
  private bots: CompiledBot[] = [];

  /**
   * Compile a bot from its bundled IIFE and prepare it for execution.
   *
   * 1. Create a fresh isolate with a memory cap.
   * 2. Create one context inside it.
   * 3. Eval the deterministic-globals snippet *first* (so the bot sees a
   *    stripped environment).
   * 4. Compile and run the bot bundle *in the same context* — this is what
   *    actually defines `globalThis.tick`.
   * 5. Capture `tick` as an `ivm.Reference` for synchronous re-invocation.
   *
   * Throws if the bundle fails to compile or run, or if it doesn't define
   * a callable `globalThis.tick`. The isolate is disposed on failure.
   */
  compileBot(
    bundle: string,
    opts: { memoryLimitMb?: number; tickMs?: number; seed?: number } = {},
  ): CompiledBot {
    const memoryLimit = opts.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
    const tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    const seed = opts.seed ?? 0;

    const isolate = new ivm.Isolate({ memoryLimit });
    let context: ivm.Context | null = null;
    try {
      context = isolate.createContextSync();

      // Install deterministic globals first.
      context.evalSync(deterministicSetupCode(seed, tickMs));

      // Compile and execute the bot bundle in the same context.
      const script = isolate.compileScriptSync(bundle);
      script.runSync(context, { timeout: 5000 });
      script.release();

      // Capture tick as a Reference for synchronous reuse.
      const tickRef = context.global.getSync('tick', { reference: true }) as
        | ivm.Reference
        | undefined;

      if (!tickRef || tickRef.typeof !== 'function') {
        throw new Error('Bot did not define a callable globalThis.tick');
      }

      const compiled: CompiledBot = { isolate, context, tickRef };
      this.bots.push(compiled);
      return compiled;
    } catch (err) {
      try {
        context?.release();
      } catch {
        /* ignore */
      }
      try {
        isolate.dispose();
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /**
   * Execute one tick of the bot.
   *
   * Synchronous from the host's perspective; uses `applySync` with a CPU
   * timeout. Returns the bot's action plus the nanoseconds of cpuTime
   * consumed by this tick (delta against the isolate's cumulative counter).
   *
   * On timeout or crash, returns `{ action: null, error }` so the caller
   * can downgrade the candidate's fitness without bringing down the pool.
   */
  runTick(
    bot: CompiledBot,
    state: BotState,
    cpuBudgetMs: number,
    tickNumber: number,
    tickMs: number = DEFAULT_TICK_MS,
  ): TickResult {
    // Advance the bot's internal clock.
    try {
      bot.context.evalSync(advanceTimeCode(tickNumber, tickMs));
    } catch (err) {
      return {
        action: null,
        cpuNanos: 0n,
        error: `time-update failed: ${(err as Error).message}`,
      };
    }

    const before = bot.isolate.cpuTime;
    try {
      const result = bot.tickRef.applySync(undefined, [state], {
        arguments: { copy: true },
        result: { copy: true },
        timeout: cpuBudgetMs,
      });
      const after = bot.isolate.cpuTime;
      return {
        action: (result as BotAction | null) ?? null,
        cpuNanos: after - before,
      };
    } catch (err) {
      const after = bot.isolate.cpuTime;
      return {
        action: null,
        cpuNanos: after - before,
        error: (err as Error).message,
      };
    }
  }

  /** Cumulative cpuTime in nanoseconds for this bot's isolate. */
  cpuNanosTotal(bot: CompiledBot): bigint {
    return bot.isolate.cpuTime;
  }

  /** Dispose a single bot, releasing all V8 resources. */
  destroy(bot: CompiledBot): void {
    try {
      bot.tickRef.release();
    } catch {
      /* ignore */
    }
    try {
      bot.context.release();
    } catch {
      /* ignore */
    }
    try {
      bot.isolate.dispose();
    } catch {
      /* ignore */
    }
    const idx = this.bots.indexOf(bot);
    if (idx !== -1) this.bots.splice(idx, 1);
  }

  /** Dispose every bot in the pool. */
  cleanup(): void {
    for (const bot of [...this.bots]) {
      this.destroy(bot);
    }
    this.bots = [];
    logger.debug('IsolatePool: cleaned up');
  }

  /** Number of live bots in the pool. */
  size(): number {
    return this.bots.length;
  }
}
