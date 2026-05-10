/**
 * @module heartbeat
 */

/**
 * Heartbeat monitor for detecting stalled evaluations and tracking progress.
 */

import { logger } from '../shared/logger.js';

/**
 * Monitor for detecting stalled evaluations and tracking task progress.
 *
 * Tracks tasks by ID, records last activity timestamps, and reports
 * stalled tasks (those idle longer than maxIdleMs). Supports periodic
 * auto-checking via setInterval.
 *
 * @example
 * ```ts
 * const monitor = new HeartbeatMonitor(30_000, 60_000);
 * monitor.register('task-1');
 * monitor.tick('task-1', 'processing match 5/50');
 * const stalled = monitor.checkStalls();
 * const timer = monitor.start(5_000); // auto-check every 5s
 * monitor.remove('task-1');
 * ```
 */
export class HeartbeatMonitor {
  private tasks: Map<string, { lastActivity: number; progress: string }> = new Map();
  private maxIdleMs: number;
  private evalTimeoutMs: number;

  /**
   * Create a HeartbeatMonitor.
   * @param maxIdleMs    - Milliseconds before a task is considered stalled (default: 30000)
   * @param evalTimeoutMs - Milliseconds before an evaluation is considered timed out (default: 60000)
   */
  constructor(maxIdleMs: number = 30_000, evalTimeoutMs: number = 60_000) {
    this.maxIdleMs = maxIdleMs;
    this.evalTimeoutMs = evalTimeoutMs;
  }

  /**
   * Register a new task and start tracking it.
   *
   * @param id - Unique task identifier for tracking
   */
  register(id: string): void {
    this.tasks.set(id, { lastActivity: Date.now(), progress: 'starting' });
    logger.debug({ id }, 'Heartbeat: task registered');
  }

  /**
   * Update the task's last activity timestamp and progress message.
   *
   * @param id - Task identifier to update
   * @param progress - Optional progress description string
   */
  tick(id: string, progress?: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.lastActivity = Date.now();
    if (progress) task.progress = progress;
  }

  /**
   * Return list of stalled task IDs (idle longer than maxIdleMs).
   *
   * Tasks are considered stalled when their `lastActivity` timestamp
   * exceeds `maxIdleMs` milliseconds ago. Stalled tasks are logged
   * at WARN level.
   *
   * @returns Array of stalled task IDs
   */
  checkStalls(): string[] {
    const now = Date.now();
    const stalls: string[] = [];

    for (const [id, task] of Array.from(this.tasks.entries())) {
      if (now - task.lastActivity > this.maxIdleMs) {
        stalls.push(id);
        logger.warn({ id, idleMs: now - task.lastActivity }, 'Heartbeat: task stalled');
      }
    }

    return stalls;
  }

  /**
   * Get current progress for a task.
   *
   * @param id - Task identifier to query
   * @returns The last progress message, or undefined if task is not tracked
   */
  getProgress(id: string): string | undefined {
    return this.tasks.get(id)?.progress;
  }

  /**
   * Start periodic stall checking, returns interval ID.
   *
   * Automatically calls `checkStalls()` at the given interval and logs
   * WARN-level messages when stalled tasks are detected.
   *
   * @param intervalMs - Check interval in milliseconds (default: 5000)
   * @returns NodeJS.Timeout interval ID (use to stop with clearInterval)
   */
  start(intervalMs: number = 5_000): NodeJS.Timeout {
    return setInterval(() => {
      const stalls = this.checkStalls();
      if (stalls.length > 0) {
        logger.warn({ stalled: stalls }, 'Heartbeat: stalled tasks detected');
      }
    }, intervalMs);
  }

  /**
   * Get summary of all tasks.
   *
   * Computes totals for active and stalled tasks based on current
   * `lastActivity` timestamps.
   *
   * @returns Object with total, active, and stalled counts
   */
  summary(): { total: number; active: number; stalled: number } {
    const stalls = this.checkStalls();
    return {
      total: this.tasks.size,
      active: this.tasks.size - stalls.length,
      stalled: stalls.length,
    };
  }

  /**
   * Remove a task from tracking.
   *
   * @param id - Task identifier to remove
   */
  remove(id: string): void {
    this.tasks.delete(id);
  }

  /**
   * Clear all tracked tasks.
   */
  clear(): void {
    this.tasks.clear();
  }
}
