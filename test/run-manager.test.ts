/**
 * Tests for src/server/run-manager.ts. Avoids actually invoking
 * `tsx src/orchestrator/run.ts` by injecting a fake spawn function that
 * returns a child whose stdout/stderr/exit we drive directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { RunManager } from '../src/server/run-manager.js';

class FakeStream extends EventEmitter {}

class FakeChild extends EventEmitter {
  pid = 42_000 + Math.floor(Math.random() * 1000);
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  killSignal: string | null = null;

  kill(signal?: string): boolean {
    this.killed = true;
    this.killSignal = signal ?? 'SIGTERM';
    // Emit synchronous exit so the test can assert state quickly.
    setImmediate(() => this.emit('exit', signal === 'SIGINT' ? 0 : 1));
    return true;
  }
}

let manager: RunManager;
let lastChild: FakeChild | null = null;

beforeEach(() => {
  lastChild = null;
  manager = new RunManager({
    spawnFn: () => {
      const c = new FakeChild();
      lastChild = c;
      return c as unknown as ChildProcess;
    },
  });
});

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('RunManager.start', () => {
  it('returns a record with state=running and a pid', () => {
    const rec = manager.start({ maxGenerations: 1 });
    expect(rec.state).toBe('running');
    expect(rec.pid).toBe(lastChild!.pid);
    expect(rec.id).toMatch(/^run-/);
    expect(manager.isBusy()).toBe(true);
  });

  it('strips llmApiKey from the persisted configOverrides', () => {
    const rec = manager.start({ maxGenerations: 1, llmApiKey: 'secret' });
    const co = rec.configOverrides as Record<string, unknown>;
    expect('llmApiKey' in co).toBe(false);
    expect(co.maxGenerations).toBe(1);
  });

  it('refuses concurrent runs', () => {
    manager.start({});
    expect(() => manager.start({})).toThrow(/already active/);
  });
});

describe('RunManager log capture', () => {
  it('records stdout lines with no prefix, stderr with [err]', () => {
    manager.start({});
    lastChild!.stdout.emit('data', Buffer.from('hello\nworld\n'));
    lastChild!.stderr.emit('data', Buffer.from('boom\n'));
    const log = manager.log(manager.list()[0].id);
    expect(log).toEqual(['hello', 'world', '[err] boom']);
  });

  it('caps the log buffer at logBufferLines', async () => {
    const m = new RunManager({
      logBufferLines: 3,
      spawnFn: () => {
        const c = new FakeChild();
        lastChild = c;
        return c as unknown as ChildProcess;
      },
    });
    m.start({});
    for (let i = 0; i < 10; i++) {
      lastChild!.stdout.emit('data', Buffer.from(`line${i}\n`));
    }
    const log = m.log(m.list()[0].id);
    expect(log.length).toBe(3);
    expect(log[0]).toBe('line7');
    expect(log[2]).toBe('line9');
  });
});

describe('RunManager.stop', () => {
  it('sends SIGINT and moves the run to exited', async () => {
    const rec = manager.start({});
    expect(manager.stop(rec.id)).toBe(true);
    expect(lastChild!.killSignal).toBe('SIGINT');
    await flushImmediate();
    const after = manager.get(rec.id);
    expect(after?.state).toBe('exited');
    expect(manager.isBusy()).toBe(false);
  });

  it('returns false when run is unknown', () => {
    expect(manager.stop('does-not-exist')).toBe(false);
  });

  it('returns false on already-exited run', async () => {
    const rec = manager.start({});
    manager.stop(rec.id);
    await flushImmediate();
    expect(manager.stop(rec.id)).toBe(false);
  });
});

describe('RunManager.list', () => {
  it('returns runs newest-first', async () => {
    const a = manager.start({});
    manager.stop(a.id);
    await flushImmediate();
    // Wait one ms so the second run gets a distinct timestamp.
    await new Promise((r) => setTimeout(r, 5));
    const b = manager.start({});

    const list = manager.list();
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });
});

describe('RunManager exit handling', () => {
  it('sets state=exited and exitCode=0 when child exits cleanly', async () => {
    manager.start({});
    lastChild!.emit('exit', 0);
    await flushImmediate();
    const rec = manager.list()[0];
    expect(rec.state).toBe('exited');
    expect(rec.exitCode).toBe(0);
    expect(manager.isBusy()).toBe(false);
  });

  it('sets state=error when child exits non-zero', async () => {
    manager.start({});
    lastChild!.emit('exit', 1);
    await flushImmediate();
    const rec = manager.list()[0];
    expect(rec.state).toBe('error');
    expect(rec.exitCode).toBe(1);
  });

  it('sets state=error when the child emits error', async () => {
    manager.start({});
    lastChild!.emit('error', new Error('spawn failed'));
    await flushImmediate();
    const rec = manager.list()[0];
    expect(rec.state).toBe('error');
    expect(manager.log(rec.id).some((l) => /spawn failed/.test(l))).toBe(true);
  });
});
