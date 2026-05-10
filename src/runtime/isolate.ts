/**
 * @module isolate
 */

/**
 * isolated-vm pool management.
 *
 * Manages a pool of V8 isolates for safe bot execution. Each isolate
 * gets its own heap (64MB memory limit) and runs the bot's tick function
 * with CPU budget enforcement.
 */

import * as ivm from 'isolated-vm';
import { logger } from '../shared/logger.js';
import type { BotAction, BotState } from '../shared/types.js';
import {
  setupDeterministicContext,
  updateDeterministicTime,
} from './deterministic.js';

/**
 * A compiled bot ready to run inside an isolated-vm isolate.
 *
 * Holds the V8 isolate, a compiled script, an execution context,
 * and a CPU time metric for tracking resource usage.
 */
export interface CompiledBot {
  /** Compiled JavaScript ready to execute */
  script: ivm.Script;
  /** Execution context with deterministic globals set up */
  context: ivm.Context;
  /** The V8 isolate with 64MB memory limit */
  isolate: ivm.Isolate;
  /** CPU time metric from the isolate (bigint, nanoseconds) */
  cpuTimeMetric: bigint;
}

/**
 * Manages isolated V8 instances for bot execution.
 *
 * Each bot is compiled into a separate isolate with its own heap.
 * The pool recycles isolates and handles crashes gracefully.
 *
 * Usage:
 * ```ts
 * const pool = new IsolatePool();
 * const compiled = pool.compile(source, bundled);
 * pool.setupContext(compiled, 50);
 * const action = await pool.runTick(compiled, botState, 100);
 * pool.destroy(compiled);
 * pool.cleanup();
 * ```
 */
export class IsolatePool {
  private bots: CompiledBot[] = [];

  /**
   * Create a new V8 isolate with a 64MB memory limit.
   *
   * The isolate is added to the pool's internal bot array and returned
   * as a CompiledBot with a null script (placeholder). Call `compile()`
   * to bind a script to it.
   *
   * @returns A CompiledBot with a placeholder script and configured isolate
   */
  createIsolate(): CompiledBot {
    const isolate = new ivm.Isolate({ memoryLimit: 64 });
    const context = isolate.createContextSync();
    const bot: CompiledBot = {
      script: null as unknown as ivm.Script,
      context,
      isolate,
      cpuTimeMetric: isolate.cpuTime,
    };
    this.bots.push(bot);
    logger.info({ isolateId: this.bots.length }, 'Created new isolate');
    return bot;
  }

  /**
   * Compile a bot source into an isolate.
   *
   * Creates a new isolate, compiles the bundled IIFE into it, and
   * replaces the placeholder CompiledBot in the pool with a fully
   * compiled one.
   *
   * @param source - Original TypeScript source (for logging / error reporting)
   * @param bundle - Already-bundled IIFE string to compile into the isolate
   * @returns CompiledBot with script bound to the isolate
   * @throws If compilation fails, the isolate is cleaned up and the error re-thrown
   */
  compile(source: string, bundle: string): CompiledBot {
    const bot = this.createIsolate();
    try {
      const script = bot.isolate.compileScriptSync(bundle);
      const compiled: CompiledBot = {
        ...bot,
        script,
        cpuTimeMetric: bot.isolate.cpuTime,
      };
      // Replace the placeholder in the pool
      const idx = this.bots.indexOf(bot);
      if (idx !== -1) this.bots[idx] = compiled;
      logger.info(
        { sourceLength: source.length, bundleLength: bundle.length },
        'Compiled bot',
      );
      return compiled;
    } catch (err) {
      logger.error({ error: err }, 'Failed to compile bot');
      // Clean up the failed isolate
      this.destroy(bot);
      throw err;
    }
  }

  /**
   * Set up deterministic context for a compiled bot.
   *
   * Initializes Math.random with a seeded PRNG, sets time to tick-driven,
   * and strips unsafe APIs (timers, network, modules).
   *
   * @param bot - The compiled bot to configure
   * @param tickMs - Target tick duration in milliseconds
   */
  setupContext(bot: CompiledBot, tickMs: number): void {
    try {
      const ctx = setupDeterministicContext(bot.isolate, 0, tickMs);
      // Swap in the new context
      bot.context = ctx;
      logger.debug('Set up deterministic context');
    } catch (err) {
      logger.error({ error: err }, 'Failed to set up deterministic context');
    }
  }

  /**
   * Run one tick of the bot's tick function.
   *
   * Updates time-based globals, injects BotState into the isolate,
   * calls the bot's `tick(botState)` function with a CPU budget timeout,
   * and returns the result.
   *
   * @param bot         - The compiled bot (holds isolate, script, context)
   * @param botState    - The BotState to pass to the bot's tick function
   * @param cpuBudget   - CPU budget in milliseconds
   * @returns BotAction if the bot executed successfully, null on error/crash
   */
  async runTick(
    bot: CompiledBot,
    botState: BotState,
    cpuBudget: number,
  ): Promise<BotAction | null> {
    const { context, isolate } = bot;

    // Update time-based globals for this tick
    updateDeterministicTime(context, botState.tick, 50); // tickMs default 50

    // Inject bot state into the isolate context via ExternalCopy
    const stateCopy = new ivm.ExternalCopy(botState);
    await context.global.set('botState', stateCopy.copy());

    try {
      // Get the tick function reference from globalThis
      const tickRef = await context.global.get('tick');
      if (!(tickRef instanceof ivm.Reference)) {
        logger.error('tick is not a valid reference in isolate context');
        return null;
      }

      // Execute tick(botState) with CPU budget timeout (in microseconds)
      const timeoutUs = cpuBudget * 1_000;
      const resultRef = await tickRef.apply(undefined, [stateCopy.copy()], {
        timeout: timeoutUs,
      });

      // Convert the result back from the isolate
      const result = (resultRef as ivm.Reference).copySync() as BotAction;

      // Update CPU time metric
      bot.cpuTimeMetric = isolate.cpuTime;

      return result;
    } catch (err) {
      logger.error(
        { tick: botState.tick, error: err },
        'Isolate tick failed — marking for recreation',
      );
      return null;
    }
  }

  /**
   * Return the isolate's total CPU time used so far.
   *
   * @param bot - The compiled bot to query
   * @returns CPU time in nanoseconds (bigint)
   */
  getCPUUsage(bot: CompiledBot): bigint {
    return bot.isolate.cpuTime;
  }

  /**
   * Destroy a single isolate and remove it from the pool.
   *
   * Releases the script, context, and isolate resources. Errors during
   * release (e.g., already released) are silently ignored.
   *
   * @param bot - The compiled bot to destroy
   */
  destroy(bot: CompiledBot): void {
    try {
      bot.script.release();
    } catch {
      /* already released */
    }
    try {
      bot.context.release();
    } catch {
      /* already released */
    }
    try {
      bot.isolate.dispose();
    } catch {
      /* already disposed */
    }
    const idx = this.bots.indexOf(bot);
    if (idx !== -1) this.bots.splice(idx, 1);
    logger.debug('Destroyed isolate');
  }

  /**
   * Clean up all isolates in the pool.
   *
   * Iterates all bots in the pool, calls destroy() on each, and
   * clears the internal bot array. Errors are silently ignored.
   */
  cleanup(): void {
    for (const bot of this.bots) {
      try {
        this.destroy(bot);
      } catch {
        /* ignore cleanup errors */
      }
    }
    this.bots = [];
    logger.info('Cleaned up all isolates');
  }

  /**
   * Number of isolates currently in the pool.
   *
   * @returns Count of active CompiledBot instances
   */
  getBotCount(): number {
    return this.bots.length;
  }
}
