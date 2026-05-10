/**
 * @module server/run-manager
 *
 * Spawns the orchestrator (`src/orchestrator/run.ts`) as a child process
 * so the HTTP server can stay responsive while a run is in progress.
 *
 * Design constraints:
 *  - One active run at a time. Concurrent runs would collide on the
 *    server's `archiveDir`. The HTTP layer surfaces a 409 if a run is
 *    already running.
 *  - Stdout / stderr is captured into a bounded in-memory ring buffer
 *    so the dashboard can tail the log without disk IO.
 *  - The orchestrator's per-generation `manifest.json` updates are the
 *    source of truth for "current generation"; the manager just tracks
 *    process lifecycle (started, exited, exitCode).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORCHESTRATOR_ENTRY = resolve(
  fileURLToPath(new URL('../orchestrator/run.ts', import.meta.url)),
);

const DEFAULT_LOG_BUFFER = 1000;

export type RunState = 'starting' | 'running' | 'exited' | 'error';

export interface RunRecord {
  id: string;
  state: RunState;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  /** Sanitized HarnessConfig overrides used to launch this run. */
  configOverrides: unknown;
  pid?: number;
}

interface InternalRun extends RunRecord {
  child?: ChildProcess;
  log: string[];
}

export interface RunManagerOptions {
  /** How many log lines to retain per run (FIFO). Default: 1000. */
  logBufferLines?: number;
  /**
   * Override how runs are spawned. Useful for tests that don't want to
   * actually invoke the real orchestrator. Default: `tsx <orchestrator-entry>`.
   */
  spawnFn?: (configJson: string) => ChildProcess;
}

const SECRET_KEYS = new Set(['llmApiKey']);

function sanitizeForRecord(overrides: unknown): unknown {
  if (!overrides || typeof overrides !== 'object') return overrides;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Manages the lifetime of orchestrator child processes. Single-active-run
 * by design; the dashboard surfaces 409 when a second concurrent run is
 * attempted.
 */
export class RunManager {
  private runs = new Map<string, InternalRun>();
  private active: InternalRun | null = null;
  private readonly logBufferLines: number;
  private spawnFn: (configJson: string) => ChildProcess;

  constructor(opts: RunManagerOptions = {}) {
    this.logBufferLines = opts.logBufferLines ?? DEFAULT_LOG_BUFFER;
    this.spawnFn =
      opts.spawnFn ??
      ((configJson: string) =>
        spawn('npx', ['tsx', ORCHESTRATOR_ENTRY, configJson], {
          stdio: ['ignore', 'pipe', 'pipe'],
        }));
  }

  /**
   * Replace the spawn function. Used by route-level tests so the live
   * server's RunManager doesn't actually invoke `tsx` during the suite.
   */
  setSpawnFn(fn: (configJson: string) => ChildProcess): void {
    this.spawnFn = fn;
  }

  /** True when a run is currently in progress. */
  isBusy(): boolean {
    return this.active !== null && this.active.state !== 'exited' && this.active.state !== 'error';
  }

  /**
   * Spawn the orchestrator as a child process. Throws if a run is
   * already active (the caller maps this to HTTP 409).
   */
  start(overrides: unknown): RunRecord {
    if (this.isBusy()) {
      throw new Error('A run is already active');
    }
    const id = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const record: InternalRun = {
      id,
      state: 'starting',
      startedAt: new Date().toISOString(),
      configOverrides: sanitizeForRecord(overrides),
      log: [],
    };
    this.runs.set(id, record);
    this.active = record;

    let child: ChildProcess;
    try {
      child = this.spawnFn(JSON.stringify(overrides ?? {}));
    } catch (err) {
      record.state = 'error';
      record.endedAt = new Date().toISOString();
      record.log.push(`spawn failed: ${(err as Error).message}`);
      this.active = null;
      return this.toPublic(record);
    }
    record.child = child;
    record.pid = child.pid ?? undefined;
    record.state = 'running';

    const append = (chunk: Buffer | string, prefix: string) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (!line) continue;
        record.log.push(`${prefix}${line}`);
        while (record.log.length > this.logBufferLines) record.log.shift();
      }
    };
    child.stdout?.on('data', (c: Buffer) => append(c, ''));
    child.stderr?.on('data', (c: Buffer) => append(c, '[err] '));
    child.on('exit', (code) => {
      record.state = code === 0 ? 'exited' : 'error';
      record.exitCode = code;
      record.endedAt = new Date().toISOString();
      if (this.active?.id === record.id) this.active = null;
    });
    child.on('error', (err) => {
      record.state = 'error';
      record.exitCode = -1;
      record.endedAt = new Date().toISOString();
      record.log.push(`process error: ${err.message}`);
      if (this.active?.id === record.id) this.active = null;
    });
    return this.toPublic(record);
  }

  /** Fetch one run's record (no log). */
  get(id: string): RunRecord | null {
    const r = this.runs.get(id);
    return r ? this.toPublic(r) : null;
  }

  /** Fetch the tail of a run's log. */
  log(id: string, lines: number = 200): string[] {
    const r = this.runs.get(id);
    if (!r) return [];
    return r.log.slice(-lines);
  }

  /** Send SIGINT to a running child. Idempotent on stopped runs. */
  stop(id: string): boolean {
    const r = this.runs.get(id);
    if (!r || !r.child) return false;
    if (r.state === 'exited' || r.state === 'error') return false;
    try {
      r.child.kill('SIGINT');
      return true;
    } catch {
      return false;
    }
  }

  /** List all runs, newest first. */
  list(): RunRecord[] {
    const arr = Array.from(this.runs.values()).map((r) => this.toPublic(r));
    arr.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return arr;
  }

  /** Clear all run records. Test-only utility. */
  reset(): void {
    for (const r of this.runs.values()) {
      try { r.child?.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.runs.clear();
    this.active = null;
  }

  /** Drop terminated runs older than the supplied count. */
  prune(keepRecent: number = 20): void {
    const sorted = Array.from(this.runs.values()).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
    const survivors = new Set(sorted.slice(0, keepRecent).map((r) => r.id));
    for (const r of sorted) {
      if (!survivors.has(r.id) && (r.state === 'exited' || r.state === 'error')) {
        this.runs.delete(r.id);
      }
    }
  }

  private toPublic(r: InternalRun): RunRecord {
    return {
      id: r.id,
      state: r.state,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      exitCode: r.exitCode,
      configOverrides: r.configOverrides,
      pid: r.pid,
    };
  }
}
