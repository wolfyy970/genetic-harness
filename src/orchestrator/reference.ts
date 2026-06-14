/**
 * @module reference
 *
 * Hand-coded **seed templates** for the initial population.
 *
 * These were previously a "frozen reference roster" that candidates fought
 * but never mutated against. That over-indexed on hand-coded quirks. Now
 * they're treated as *initial population members*: they enter the pool at
 * generation 0, get evaluated, get placed in MAP-Elites cells, and can be
 * mutated by the LLM or displaced by better bots in the same niche just
 * like any other candidate.
 *
 * Each bot exports the same `function tick(s)` shape as evolved bots, so
 * they go through the same bundler + isolate path.
 *
 * REWRITE NOTE — all templates were rebuilt in 2026-05 after the earlier
 * "drifter wins everything" pathology:
 *   - World was bumped 800×600 → 2800×2100 but the old templates had
 *     800×600-era constants baked in (drifter's `cx=400, cy=300`,
 *     250px engagement ranges, etc.). Drifter was the only template
 *     with proper rotate-to-aim, so it won the seed FFA by default.
 *   - Old templates used naïve angle math (`while (diff > PI) diff -=`)
 *     that the manual's canonical `((d - a + 3π) % 2π) - π` replaces.
 *   - Strategies were too similar (most were "find nearest + rotate +
 *     fire"). They now differ in concrete observable ways: who they
 *     target, when they brake, whether they sidestep, whether they
 *     avoid LARGE asteroids, etc.
 *
 * All 8 templates pass `validateBotSource()` and use world-proportional
 * constants. The 3 manual exemplars (Sniper, Brawler, AsteroidHunter)
 * are intentionally NOT copied verbatim — that would defeat the diversity
 * of the diverse-seed population. Templates 3-7 borrow individual idioms
 * (aim-error wraparound, asteroid avoidance) but combine them into
 * distinct strategies.
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

// ---------------------------------------------------------------------------
// 1. Null — control opponent. Returns wait every tick. Useful as a fitness
// floor and as smoke-test filler when the pool is otherwise empty.
// ---------------------------------------------------------------------------
const NULL_BOT: ScriptedBot = {
  id: 'ref-null',
  name: 'Null',
  description: 'Always waits. Acts as a fitness floor.',
  source: `function tick(s) { return { type: 'wait' }; }`,
};

// ---------------------------------------------------------------------------
// 2. Random — noise floor just above Null. Picks an action uniformly per
// tick. Sometimes scores from a lucky shot; usually doesn't.
// ---------------------------------------------------------------------------
const RANDOM_BOT: ScriptedBot = {
  id: 'ref-random',
  name: 'Random Walker',
  description: 'Picks an action uniformly at random.',
  source: `function tick(s) {
    var r = Math.random();
    if (r < 0.25) return { type: 'rotate', direction: r < 0.125 ? -1 : 1 };
    if (r < 0.45) return { type: 'thrust', direction: r < 0.40 ? 1 : -1 };
    if (r < 0.65) return { type: 'fire' };
    return { type: 'wait' };
  }`,
};

// ---------------------------------------------------------------------------
// 3. Sharpshooter — long-range sniper. Tight aim (<0.05 rad), fires
// only when target inside effective bullet range (~600 px). Holds
// position; never thrusts. Distinct from #6 (Brawler) by ENGAGEMENT
// DISTANCE — 600 px vs 200 px.
// ---------------------------------------------------------------------------
const SHARPSHOOTER_BOT: ScriptedBot = {
  id: 'ref-sharpshooter',
  name: 'Sharpshooter',
  description: 'Stationary long-range sniper. Tight aim, fires only on lock.',
  source: `function tick(s) {
    var ship = s.ship;
    var best = null, bestD2 = Infinity;
    for (var i = 0; i < s.opponents.length; i++) {
      var o = s.opponents[i];
      var dx = o.pos.x - ship.pos.x;
      var dy = o.pos.y - ship.pos.y;
      var d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = { o: o, dx: dx, dy: dy }; }
    }
    if (!best) return { type: 'wait' };
    var desired = Math.atan2(best.dy, best.dx);
    var err = ((desired - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (Math.abs(err) > 0.05) return { type: 'rotate', direction: err > 0 ? 1 : -1 };
    if (bestD2 < 600 * 600) return { type: 'fire' };
    return { type: 'wait' };
  }`,
};

// ---------------------------------------------------------------------------
// 4. Brawler — point-blank aggressor. Closes range, fires at <300 px,
// reverse-thrusts to brake before overshoot. Distinct from #3 by
// MOVEMENT — actively chases vs stationary.
// ---------------------------------------------------------------------------
const BRAWLER_BOT: ScriptedBot = {
  id: 'ref-brawler',
  name: 'Brawler',
  description: 'Point-blank aggressor. Closes range and brakes with reverse thrust.',
  source: `function tick(s) {
    var ship = s.ship;
    var best = null, bestD2 = Infinity;
    for (var i = 0; i < s.opponents.length; i++) {
      var o = s.opponents[i];
      var dx = o.pos.x - ship.pos.x;
      var dy = o.pos.y - ship.pos.y;
      var d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = { dx: dx, dy: dy, d2: d2 }; }
    }
    if (!best) return { type: 'wait' };
    var desired = Math.atan2(best.dy, best.dx);
    var err = ((desired - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (Math.abs(err) > 0.1) return { type: 'rotate', direction: err > 0 ? 1 : -1 };
    if (best.d2 < 300 * 300) return { type: 'fire' };
    var speed2 = ship.vel.x * ship.vel.x + ship.vel.y * ship.vel.y;
    if (best.d2 < 500 * 500 && speed2 > 16) return { type: 'thrust', direction: -1 };
    return { type: 'thrust', direction: 1 };
  }`,
};

// ---------------------------------------------------------------------------
// 5. AsteroidHunter — targets non-LARGE asteroids for big SMALL/MEDIUM
// scores. Keeps stand-off from LARGE (instakill risk). Distinct from
// every other template by TARGET TYPE — ignores opponents.
// ---------------------------------------------------------------------------
const ASTEROID_HUNTER_BOT: ScriptedBot = {
  id: 'ref-asteroid-hunter',
  name: 'Asteroid Hunter',
  description: 'Hunts SMALL/MEDIUM asteroids; avoids LARGE.',
  source: `function tick(s) {
    var ship = s.ship;
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < s.asteroids.length; i++) {
      var a = s.asteroids[i];
      var dx = a.pos.x - ship.pos.x;
      var dy = a.pos.y - ship.pos.y;
      var d2 = dx*dx + dy*dy;
      if (a.tier === 'LARGE') {
        if (d2 < 220 * 220) {
          var awayDesired = Math.atan2(-dy, -dx);
          var awayErr = ((awayDesired - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
          if (Math.abs(awayErr) > 0.15) return { type: 'rotate', direction: awayErr > 0 ? 1 : -1 };
          return { type: 'thrust', direction: 1 };
        }
        continue;
      }
      var value = (a.tier === 'SMALL' ? 200 : 100) / Math.max(1, Math.sqrt(d2));
      if (value > bestScore) { bestScore = value; best = { dx: dx, dy: dy, d2: d2 }; }
    }
    if (!best) return { type: 'wait' };
    var desired = Math.atan2(best.dy, best.dx);
    var err = ((desired - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (Math.abs(err) > 0.06) return { type: 'rotate', direction: err > 0 ? 1 : -1 };
    if (best.d2 < 550 * 550) return { type: 'fire' };
    return { type: 'thrust', direction: 1 };
  }`,
};

// ---------------------------------------------------------------------------
// 6. Skirmisher — sidestepping fighter. Faces opponent at a 90° offset
// so its velocity vector is perpendicular to the line of fire from the
// opponent. Fires when an opponent is within an arc roughly in front.
// Distinct: NOBODY ELSE uses orthogonal-heading positioning.
// ---------------------------------------------------------------------------
const SKIRMISHER_BOT: ScriptedBot = {
  id: 'ref-skirmisher',
  name: 'Skirmisher',
  description: 'Sidesteps perpendicular to opponent; fires on opportunistic locks.',
  source: `function tick(s) {
    var ship = s.ship;
    var best = null, bestD2 = Infinity;
    for (var i = 0; i < s.opponents.length; i++) {
      var o = s.opponents[i];
      var dx = o.pos.x - ship.pos.x;
      var dy = o.pos.y - ship.pos.y;
      var d2 = dx*dx + dy*dy;
      if (d2 < bestD2) { bestD2 = d2; best = { dx: dx, dy: dy, d2: d2 }; }
    }
    if (!best) {
      // No targets: rotate slowly to scan.
      return { type: 'rotate', direction: 1 };
    }
    // Desired heading is 90° offset from line-to-target (sidestep).
    var toTarget = Math.atan2(best.dy, best.dx);
    var perp = toTarget + Math.PI / 2;
    var perpErr = ((perp - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    var firingErr = ((toTarget - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    // Fire if target happens to be in front of us right now.
    if (Math.abs(firingErr) < 0.18 && best.d2 < 500 * 500) return { type: 'fire' };
    // Otherwise drift perpendicular.
    if (Math.abs(perpErr) > 0.2) return { type: 'rotate', direction: perpErr > 0 ? 1 : -1 };
    return { type: 'thrust', direction: 1 };
  }`,
};

// ---------------------------------------------------------------------------
// 7. Coward — opposite of Brawler. Runs from nearest opponent; fires only
// at opponents directly behind it (low-risk, no need to turn). Distinct
// from #8 (Evasive) by NEVER engaging asteroids — only opponents flee.
// ---------------------------------------------------------------------------
const COWARD_BOT: ScriptedBot = {
  id: 'ref-coward',
  name: 'Coward',
  description: 'Flees from nearest opponent; only fires when target is behind it.',
  source: `function tick(s) {
    var ship = s.ship;
    var nearest = null, nearestD2 = Infinity;
    for (var i = 0; i < s.opponents.length; i++) {
      var o = s.opponents[i];
      var dx = o.pos.x - ship.pos.x;
      var dy = o.pos.y - ship.pos.y;
      var d2 = dx*dx + dy*dy;
      if (d2 < nearestD2) { nearestD2 = d2; nearest = { dx: dx, dy: dy, d2: d2 }; }
    }
    if (!nearest) return { type: 'thrust', direction: 1 };
    var awayDesired = Math.atan2(-nearest.dy, -nearest.dx);
    var awayErr = ((awayDesired - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    // If currently facing AWAY from threat (i.e., threat is roughly behind us), opportunistic backward fire.
    var towardErr = ((Math.atan2(nearest.dy, nearest.dx) - ship.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    if (Math.abs(towardErr) > Math.PI - 0.25 && nearest.d2 < 400 * 400) return { type: 'fire' };
    if (Math.abs(awayErr) > 0.2) return { type: 'rotate', direction: awayErr > 0 ? 1 : -1 };
    return { type: 'thrust', direction: 1 };
  }`,
};

// ---------------------------------------------------------------------------
// 8. Berserker — pure chaos. Always thrust, always rotate, always fire.
// Useful because (a) generates events for other bots to react to,
// (b) sometimes lucks into kills, (c) total stylistic opposite of #3
// (Sharpshooter) — guarantees the seed FFA is not a sniper-monoculture.
// ---------------------------------------------------------------------------
const BERSERKER_BOT: ScriptedBot = {
  id: 'ref-berserker',
  name: 'Berserker',
  description: 'Cycles thrust / rotate / fire every 3 ticks. Pure chaos.',
  source: `function tick(s) {
    var n = s.tick % 3;
    if (n === 0) return { type: 'thrust', direction: 1 };
    if (n === 1) return { type: 'rotate', direction: 1 };
    return { type: 'fire' };
  }`,
};

/**
 * Hand-coded seed templates that populate generation 0 in
 * `seedMode: 'curated'`. Order is stable so a freshly-seeded archive
 * has deterministic shipIds.
 *
 * Note: these are now *seeds*, not *opponents*. They can mutate and
 * be displaced like anything else in the population.
 */
export const SEED_TEMPLATES: ScriptedBot[] = [
  NULL_BOT,
  RANDOM_BOT,
  SHARPSHOOTER_BOT,
  BRAWLER_BOT,
  ASTEROID_HUNTER_BOT,
  SKIRMISHER_BOT,
  COWARD_BOT,
  BERSERKER_BOT,
];

/**
 * @deprecated use `SEED_TEMPLATES`. Retained as a re-export so existing
 * tests and replay-recording code keep compiling while callers migrate to
 * sampling opponents from the live population.
 */
export const REFERENCE_ROSTER = SEED_TEMPLATES;

/** Look up a seed template by id. */
export function getSeedTemplate(id: string): ScriptedBot | undefined {
  return SEED_TEMPLATES.find((b) => b.id === id);
}

/** @deprecated alias for `getSeedTemplate`. */
export const getReferenceBot = getSeedTemplate;
