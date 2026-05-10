/**
 * Tests that `playMatch` correctly invokes the optional `MatchRecorder`
 * after each `arena.tick`, and that the absence of a recorder doesn't
 * change behavior.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { playMatch } from '../src/orchestrator/match.js';
import { IsolatePool, type CompiledBot } from '../src/runtime/isolate.js';
import { bundle } from '../src/runtime/bundler.js';
import { getArena } from '../src/arena/interface.js';
import type { MatchRecorder } from '../src/replay/recorder.js';
import type { GameConfig, GameState } from '../src/shared/types.js';
import '../src/arena/asteroids.js';

const MATCH_CONFIG: GameConfig = {
  worldWidth: 400,
  worldHeight: 300,
  seed: 1,
  asteroidCount: 1,
  tickMs: 50,
  maxBulletsPerShip: 1,
  bulletSpeed: 4,
  shipThrust: 0.15,
  shipRotationSpeed: 0.08,
  shipMaxFuel: 1000,
  asteroidBaseRadius: 20,
  asteroidSpeed: 0.5,
  shipCount: 2,
};

const NULL_BOT_SOURCE = `function tick(s) { return { type: 'wait' }; }`;

describe('playMatch with MatchRecorder', () => {
  let pool: IsolatePool | null = null;

  afterEach(() => {
    if (pool) {
      pool.cleanup();
      pool = null;
    }
  });

  function setup(): { bot: CompiledBot; opp: CompiledBot } {
    pool = new IsolatePool();
    const bot = pool.compileBot(bundle(NULL_BOT_SOURCE));
    const opp = pool.compileBot(bundle(NULL_BOT_SOURCE));
    return { bot, opp };
  }

  it('calls recorder.onTick once per arena.tick', () => {
    const { bot, opp } = setup();
    const arena = getArena('asteroids')!;
    const observed: number[] = [];
    const recorder: MatchRecorder = {
      onTick: (s: GameState) => observed.push(s.tick),
    };
    const shipBots = new Map<string, CompiledBot>([
      ['ship-0', bot],
      ['ship-1', opp],
    ]);
    const report = playMatch(arena, pool!, shipBots, MATCH_CONFIG, 20, 100, recorder);

    // Both bots return wait every tick; the loop runs to maxTicks=20.
    // Ticks observed are post-arena.tick, so they start at 1 and go up.
    expect(observed.length).toBe(report.durationTicks);
    expect(observed[0]).toBeGreaterThanOrEqual(1);
    expect(observed[observed.length - 1]).toBeGreaterThanOrEqual(observed[0]);
  }, 10_000);

  it('does not fail when no recorder is supplied (existing callers)', () => {
    const { bot, opp } = setup();
    const arena = getArena('asteroids')!;
    const shipBots = new Map<string, CompiledBot>([
      ['ship-0', bot],
      ['ship-1', opp],
    ]);
    expect(() =>
      playMatch(arena, pool!, shipBots, MATCH_CONFIG, 5, 100),
    ).not.toThrow();
  }, 10_000);
});
