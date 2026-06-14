/**
 * Tests for the curated seed templates.
 *
 * Two jobs:
 *   1. Every template compiles and produces a valid action — the
 *      evaluator cascade falls over if any seed crashes to bundle/boot.
 *   2. Templates are behaviorally DISTINCT. The whole point of the 2026-05
 *      rewrite was killing the "drifter wins everything" pathology where
 *      all templates collapsed to the same strategy. We assert that under
 *      a few concrete world states, the templates produce different
 *      actions — proxy for "strategies are actually different."
 */

import { describe, it, expect, afterEach } from 'vitest';
import { SEED_TEMPLATES, REFERENCE_ROSTER } from '../src/orchestrator/reference.js';
import { compileBotSet } from '../src/orchestrator/evaluator.js';
import { validateBotSource } from '../src/orchestrator/mutation.js';
import { IsolatePool } from '../src/runtime/isolate.js';
import type { BotState, BotAction } from '../src/shared/types.js';

const VALID_TYPES = new Set(['thrust', 'rotate', 'fire', 'wait']);

// Hero anchors at world center. The harness pre-shifts other entities
// into the hero's local frame, so an opponent "directly ahead at 400 px"
// has its pos at (HERO_X + 400, HERO_Y) — same as the absolute position
// when the hero is at world center.
const HERO_X = 1400;
const HERO_Y = 1050;

/**
 * State factory — a representative 8-ship FFA state. The hero ship sits
 * mid-world facing +x. Helper positions like `ahead(d)` make it obvious
 * what local-frame delta a bot will see.
 */
function ahead(distPx: number): { x: number; y: number } {
  return { x: HERO_X + distPx, y: HERO_Y };
}
function offset(dx: number, dy: number): { x: number; y: number } {
  return { x: HERO_X + dx, y: HERO_Y + dy };
}

function baseState(over: Partial<BotState> = {}): BotState {
  return {
    ship: {
      id: 'ship-0', type: 'ship',
      pos: { x: HERO_X, y: HERO_Y },
      vel: { x: 0, y: 0 },
      angle: 0, angularVel: 0,
      thrust: false, thrustAngle: 0,
      fuel: 1000, shields: 100, health: 100, score: 0,
    },
    nearbyEntities: [],
    asteroids: [
      {
        id: 'a1', type: 'asteroid',
        pos: ahead(400), vel: { x: 0, y: 0 },
        radius: 25, health: 1, mass: 1,
        tier: 'MEDIUM', vertices: [], rotation: 0, angularVel: 0,
      },
    ],
    opponents: [
      {
        id: 'ship-1', type: 'ship',
        pos: ahead(600), vel: { x: 0, y: 0 },
        angle: Math.PI, angularVel: 0,
        thrust: false, thrustAngle: 0,
        fuel: 1000, shields: 100, health: 100, score: 0,
      },
    ],
    bullets: [],
    score: 0,
    tick: 0,
    ...over,
  };
}

function runAll(state: BotState): Map<string, BotAction | null> {
  const pool = new IsolatePool();
  const compiled = compileBotSet(pool, SEED_TEMPLATES);
  const out = new Map<string, BotAction | null>();
  for (const [id, bot] of compiled) {
    const r = pool.runTick(bot, state, 100, 0);
    out.set(id, r.action);
  }
  pool.cleanup();
  return out;
}

describe('Seed templates — lineup', () => {
  it('exposes 8 templates in stable order', () => {
    expect(SEED_TEMPLATES).toHaveLength(8);
    expect(SEED_TEMPLATES.map((b) => b.id)).toEqual([
      'ref-null',
      'ref-random',
      'ref-sharpshooter',
      'ref-brawler',
      'ref-asteroid-hunter',
      'ref-skirmisher',
      'ref-coward',
      'ref-berserker',
    ]);
  });

  it('keeps the REFERENCE_ROSTER deprecated alias working', () => {
    expect(REFERENCE_ROSTER).toBe(SEED_TEMPLATES);
  });

  it('every template passes the production validator (no hallucinations)', () => {
    for (const t of SEED_TEMPLATES) {
      const v = validateBotSource(t.source);
      if (!v.ok) {
        console.error(`Template ${t.id} failed validation:`);
        console.error(JSON.stringify(v.issues, null, 2));
      }
      expect(v.ok).toBe(true);
    }
  });
});

describe('Seed templates — runtime', () => {
  let pool: IsolatePool | null = null;
  afterEach(() => {
    if (pool) { pool.cleanup(); pool = null; }
  });

  it('compiles every template into the isolate pool', () => {
    pool = new IsolatePool();
    const compiled = compileBotSet(pool, SEED_TEMPLATES);
    expect(compiled.size).toBe(SEED_TEMPLATES.length);
    for (const t of SEED_TEMPLATES) expect(compiled.has(t.id)).toBe(true);
  });

  it('every template returns a valid BotAction on a representative state', () => {
    pool = new IsolatePool();
    const compiled = compileBotSet(pool, SEED_TEMPLATES);
    for (const [id, bot] of compiled) {
      const r = pool.runTick(bot, baseState(), 100, 0);
      expect(r.error, `bot ${id} crashed: ${r.error}`).toBeUndefined();
      expect(r.action, `bot ${id} returned null`).not.toBeNull();
      expect(VALID_TYPES.has(r.action!.type), `bot ${id} returned invalid type ${r.action!.type}`).toBe(true);
    }
  });
});

describe('Seed templates — behavioral distinctness', () => {
  it('Sharpshooter holds position (does NOT thrust forward) when target in range and aim-locked', () => {
    // Opponent directly ahead at 400 px — within 600px fire range and on
    // the hero's heading axis (aim error ≈ 0). Sharpshooter should fire,
    // NOT thrust toward.
    const actions = runAll(baseState({
      opponents: [{
        id: 'ship-1', type: 'ship',
        pos: ahead(400), vel: { x: 0, y: 0 },
        angle: Math.PI, angularVel: 0,
        thrust: false, thrustAngle: 0,
        fuel: 1000, shields: 100, health: 100, score: 0,
      }],
    }));
    const sharp = actions.get('ref-sharpshooter');
    expect(sharp).not.toBeNull();
    expect(sharp!.type).not.toBe('thrust');
    expect(['fire', 'wait']).toContain(sharp!.type);
  });

  it('Brawler thrusts forward to close range when target is far', () => {
    // Opponent at 800 px ahead — beyond Brawler's 300px fire range,
    // beyond its 500px brake range — should pure-thrust toward it.
    const actions = runAll(baseState({
      opponents: [{
        id: 'ship-1', type: 'ship',
        pos: ahead(800), vel: { x: 0, y: 0 },
        angle: Math.PI, angularVel: 0,
        thrust: false, thrustAngle: 0,
        fuel: 1000, shields: 100, health: 100, score: 0,
      }],
    }));
    const br = actions.get('ref-brawler');
    expect(br!.type).toBe('thrust');
    expect((br as { type: 'thrust'; direction: 1 | -1 }).direction).toBe(1);
  });

  it('AsteroidHunter ignores opponents and locks onto SMALL asteroids', () => {
    // SMALL asteroid 400 px ahead, hero already aimed → fire.
    const actions = runAll(baseState({
      asteroids: [{
        id: 'a-small', type: 'asteroid',
        pos: ahead(400), vel: { x: 0, y: 0 },
        radius: 12, health: 1, mass: 0.5,
        tier: 'SMALL', vertices: [], rotation: 0, angularVel: 0,
      }],
      opponents: [],
    }));
    const ah = actions.get('ref-asteroid-hunter');
    expect(ah).not.toBeNull();
    expect(ah!.type).not.toBe('wait');
  });

  it('AsteroidHunter actively flees from a near LARGE asteroid', () => {
    const actions = runAll(baseState({
      asteroids: [{
        id: 'a-big', type: 'asteroid',
        pos: ahead(180), vel: { x: 0, y: 0 },
        radius: 60, health: 4, mass: 4,
        tier: 'LARGE', vertices: [], rotation: 0, angularVel: 0,
      }],
      opponents: [],
    }));
    const ah = actions.get('ref-asteroid-hunter');
    // Must NOT fire at a close LARGE — would split it next to us.
    expect(ah!.type).not.toBe('fire');
  });

  it('Coward rotates AWAY from an opponent directly in front', () => {
    // Opponent ahead at 200 px. Hero facing toward it (angle=0).
    // Coward should rotate to face away (180° off the line).
    const actions = runAll(baseState({
      opponents: [{
        id: 'ship-1', type: 'ship',
        pos: ahead(200), vel: { x: 0, y: 0 },
        angle: 0, angularVel: 0,
        thrust: false, thrustAngle: 0,
        fuel: 1000, shields: 100, health: 100, score: 0,
      }],
    }));
    const cow = actions.get('ref-coward');
    expect(cow).not.toBeNull();
    expect(cow!.type).toBe('rotate');
  });

  it('templates produce a variety of action types under a single state', () => {
    // The whole "drifter wins everything" pathology was that 6 of 8
    // templates collapsed to the same behavior. Assert that at least
    // 3 distinct action *types* show up across the 8 templates.
    const actions = runAll(baseState());
    const types = new Set<string>();
    for (const a of actions.values()) {
      if (a !== null) types.add(a.type);
    }
    expect(types.size).toBeGreaterThanOrEqual(3);
  });

  it('Null returns wait; Berserker returns thrust/rotate/fire (never wait)', () => {
    const actions = runAll(baseState());
    expect(actions.get('ref-null')).toEqual({ type: 'wait' });
    const berserk = actions.get('ref-berserker');
    expect(berserk!.type).not.toBe('wait');
  });

  it('no template hardcodes the old 800×600 world center', () => {
    // The whole bug class. Ensure nobody slips it back in.
    for (const t of SEED_TEMPLATES) {
      expect(t.source).not.toMatch(/cx\s*=\s*400/);
      expect(t.source).not.toMatch(/cy\s*=\s*300/);
    }
  });
});
