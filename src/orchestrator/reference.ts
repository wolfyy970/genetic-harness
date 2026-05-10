/**
 * @module reference
 *
 * Hand-coded scripted opponent bots — the frozen reference roster every
 * candidate plays against during evaluation. Per the AlphaStar discipline,
 * these are *never* mutated by evolution; their only job is to give the
 * candidate population a stable, behaviorally-diverse fitness signal.
 *
 * Each bot exports the same `function tick(s)` shape as evolved bots, so
 * they go through the same bundler + isolate path.
 */

export interface ScriptedBot {
  /** Stable id used in match ship assignment and behavioral signatures. */
  id: string;
  /** Display name. */
  name: string;
  /** One-sentence description of the bot's strategy. */
  description: string;
  /** Bot source code (same shape as evolved bots). */
  source: string;
}

/** No-op bot: returns wait every tick. Useful as a control. */
const NULL_BOT: ScriptedBot = {
  id: 'ref-null',
  name: 'Null',
  description: 'Always waits — control opponent.',
  source: `function tick(s) { return { type: 'wait' }; }`,
};

/** Random walker: rotates and fires at random. */
const RANDOM_BOT: ScriptedBot = {
  id: 'ref-random',
  name: 'Random Walker',
  description: 'Random rotate / fire / wait.',
  source: `function tick(s) {
    var r = Math.random();
    if (r < 0.25) return { type: 'rotate', direction: r < 0.125 ? -1 : 1 };
    if (r < 0.45) return { type: 'thrust', angle: 0 };
    if (r < 0.55) return { type: 'fire' };
    return { type: 'wait' };
  }`,
};

/** Aggressive: rotate toward nearest opponent and fire when close. */
const AGGRESSIVE_BOT: ScriptedBot = {
  id: 'ref-aggressive',
  name: 'Aggressive',
  description: 'Faces nearest opponent and fires when within range.',
  source: `function tick(s) {
    if (!s.opponents || s.opponents.length === 0) return { type: 'wait' };
    var ship = s.ship;
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < s.opponents.length; i++) {
      var o = s.opponents[i];
      var dx = o.pos.x - ship.pos.x;
      var dy = o.pos.y - ship.pos.y;
      var d = dx*dx + dy*dy;
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best) return { type: 'wait' };
    var ang = Math.atan2(best.pos.y - ship.pos.y, best.pos.x - ship.pos.x);
    var diff = ang - ship.angle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) < 0.15) return { type: 'fire' };
    return { type: 'rotate', direction: diff > 0 ? 1 : -1 };
  }`,
};

/** Evasive: thrusts away from the nearest threat (asteroid or ship). */
const EVASIVE_BOT: ScriptedBot = {
  id: 'ref-evasive',
  name: 'Evasive',
  description: 'Thrusts away from the nearest large object.',
  source: `function tick(s) {
    var ship = s.ship;
    var threats = (s.asteroids || []).concat(s.opponents || []);
    if (threats.length === 0) return { type: 'wait' };
    var worst = null;
    var worstScore = -Infinity;
    for (var i = 0; i < threats.length; i++) {
      var t = threats[i];
      if (!t.pos) continue;
      var dx = t.pos.x - ship.pos.x;
      var dy = t.pos.y - ship.pos.y;
      var d2 = dx*dx + dy*dy;
      if (d2 < 1) d2 = 1;
      var weight = (t.radius ? t.radius * t.radius : 100) / d2;
      if (weight > worstScore) { worstScore = weight; worst = t; }
    }
    if (!worst) return { type: 'wait' };
    var awayAng = Math.atan2(ship.pos.y - worst.pos.y, ship.pos.x - worst.pos.x);
    return { type: 'thrust', angle: awayAng };
  }`,
};

/** Sniper: stationary, faces nearest opponent, fires when aim is tight. */
const SNIPER_BOT: ScriptedBot = {
  id: 'ref-sniper',
  name: 'Sniper',
  description: 'Stationary; rotates to face nearest opponent; fires on tight aim.',
  source: `function tick(s) {
    if (!s.opponents || s.opponents.length === 0) return { type: 'wait' };
    var ship = s.ship;
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < s.opponents.length; i++) {
      var o = s.opponents[i];
      var dx = o.pos.x - ship.pos.x;
      var dy = o.pos.y - ship.pos.y;
      var d = dx*dx + dy*dy;
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best) return { type: 'wait' };
    var ang = Math.atan2(best.pos.y - ship.pos.y, best.pos.x - ship.pos.x);
    var diff = ang - ship.angle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) < 0.10) return { type: 'fire' };
    return { type: 'rotate', direction: diff > 0 ? 1 : -1 };
  }`,
};

/** Hunter: leads the shot by predicting opponent position 10 ticks ahead. */
const HUNTER_BOT: ScriptedBot = {
  id: 'ref-hunter',
  name: 'Hunter',
  description: 'Predicts opponent +10 ticks of motion; leads the shot.',
  source: `function tick(s) {
    if (!s.opponents || s.opponents.length === 0) return { type: 'wait' };
    var ship = s.ship;
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < s.opponents.length; i++) {
      var o = s.opponents[i];
      var dx = o.pos.x - ship.pos.x;
      var dy = o.pos.y - ship.pos.y;
      var d = dx*dx + dy*dy;
      if (d < bestD) { bestD = d; best = o; }
    }
    if (!best) return { type: 'wait' };
    var leadX = best.pos.x + (best.vel ? best.vel.x : 0) * 10;
    var leadY = best.pos.y + (best.vel ? best.vel.y : 0) * 10;
    var ang = Math.atan2(leadY - ship.pos.y, leadX - ship.pos.x);
    var diff = ang - ship.angle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    if (Math.abs(diff) < 0.12) return { type: 'fire' };
    return { type: 'rotate', direction: diff > 0 ? 1 : -1 };
  }`,
};

/** Drifter: maintains a drift around the world centroid; fires at near threats. */
const DRIFTER_BOT: ScriptedBot = {
  id: 'ref-drifter',
  name: 'Drifter',
  description: 'Drifts around the world centroid; fires at threats within 250px.',
  source: `function tick(s) {
    var ship = s.ship;
    // Pull toward arena center if drifting too far. Approximate by
    // thrusting toward centroid when |radial vel| is low.
    var cx = 400, cy = 300;
    var toCenterAng = Math.atan2(cy - ship.pos.y, cx - ship.pos.x);
    var threats = (s.opponents || []).concat(s.asteroids || []);
    var nearest = null;
    var nearestD2 = Infinity;
    for (var i = 0; i < threats.length; i++) {
      var t = threats[i];
      if (!t.pos) continue;
      var dx = t.pos.x - ship.pos.x;
      var dy = t.pos.y - ship.pos.y;
      var d2 = dx*dx + dy*dy;
      if (d2 < nearestD2) { nearestD2 = d2; nearest = t; }
    }
    if (nearest && nearestD2 < 250 * 250) {
      var ang = Math.atan2(nearest.pos.y - ship.pos.y, nearest.pos.x - ship.pos.x);
      var diff = ang - ship.angle;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) < 0.2) return { type: 'fire' };
      return { type: 'rotate', direction: diff > 0 ? 1 : -1 };
    }
    var speed2 = ship.vel.x * ship.vel.x + ship.vel.y * ship.vel.y;
    if (speed2 < 0.5) return { type: 'thrust', angle: toCenterAng };
    return { type: 'wait' };
  }`,
};

/** Berserker: full-throttle thrust + constant fire. Hard for "wait" to outlast. */
const BERSERKER_BOT: ScriptedBot = {
  id: 'ref-berserker',
  name: 'Berserker',
  description: 'Constant thrust + constant fire.',
  source: `function tick(s) {
    var n = s.tick % 6;
    if (n === 0) return { type: 'thrust', angle: s.ship.angle };
    if (n === 1) return { type: 'rotate', direction: 1 };
    return { type: 'fire' };
  }`,
};

/**
 * The frozen reference roster. Order is stable so behavioral signatures
 * (win/loss/draw vectors against the roster) are comparable across runs.
 */
export const REFERENCE_ROSTER: ScriptedBot[] = [
  NULL_BOT,
  RANDOM_BOT,
  AGGRESSIVE_BOT,
  EVASIVE_BOT,
  SNIPER_BOT,
  HUNTER_BOT,
  DRIFTER_BOT,
  BERSERKER_BOT,
];

/** Look up a reference bot by id. */
export function getReferenceBot(id: string): ScriptedBot | undefined {
  return REFERENCE_ROSTER.find((b) => b.id === id);
}
