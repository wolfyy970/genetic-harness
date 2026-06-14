/**
 * @module run
 */

/**
 * Main evolutionary loop for the genetic harness.
 *
 * Orchestrates the full cycle:
 *   1. Initialize population with seed bots
 *   2. Generate mutations via LLM
 *   3. Evaluate mutations through cascade
 *   4. Update MAP-Elites grid
 *   5. Migrate between islands
 *   6. Repeat until convergence or max generations
 *   7. Output leaderboard and archive
 */

import { logger } from '../shared/logger.js';
import type {
  HarnessConfig,
  ArchivedBot,
  ArenaPlugin,
  FitnessResult,
  MutationContext,
} from '../shared/types.js';
import { loadConfig } from '../shared/config.js';
import { Population } from './population.js';
import { generateMutationWithRetry, generateDiverseSeeds, type DiverseSeed } from './mutation.js';
import { getOrProbeCapabilities } from './llm-capabilities.js';
import {
  evaluate,
  compileBotSet,
  buildFitnessFromStats,
  FFA_MATCH_SIZE,
} from './evaluator.js';
import { playMatch, aggressionScore, economyScore } from './match.js';
import { SEED_TEMPLATES, type ScriptedBot } from './reference.js';
import { bundle, BUNDLE_ERROR_PREFIX } from '../runtime/bundler.js';
import { IsolatePool, type CompiledBot } from '../runtime/isolate.js';
import { HeartbeatMonitor } from './heartbeat.js';
import { getArena } from '../arena/interface.js';
import '../arena/asteroids.js';
import {
  writeLeaderboard,
  loadLeaderboard,
  clearArchiveDir,
  appendGenerationToManifest,
  pruneOldGenerations,
} from '../replay/store.js';
import { recordEliteReplays, sanitizeConfig } from '../replay/elite-replays.js';
import { setLeaderboard } from '../server.js';

/** Zero-fitness placeholder used while a seed bot is awaiting evaluation. */
function zeroFitness(shipId: string): FitnessResult {
  return {
    shipId,
    winRate: 0,
    avgScore: 0,
    avgFuelPerTick: 0,
    avgTicksAlive: 0,
    totalMatches: 0,
    totalTicksAlive: 0,
    cpuTimeTotal: 0n,
    memoryUsed: 0,
    crashes: 0,
    fitnessScore: 0,
    aggression: 0,
    economy: 0,
  };
}

/**
 * Generate a simple seed bot that does basic avoidance behavior.
 *
 * Creates a bot that rotates away from nearby threats and fires at
 * close-range opponents. Used as the starting point for each island.
 *
 * @param id        - Unique identifier for the bot
 * @param island    - Index of the island this bot belongs to
 * @param generation - Current generation number
 * @returns An ArchivedBot with basic avoidance code
 */
function makeSeedBot(id: string, island: number, generation: number): ArchivedBot {
  return {
    id: `seed-${id}-${generation}`,
    source: `// Seed bot. The LLM mutates this — it must DO something useful so
// the LLM has a real signal to refine, not a broken passive baseline.
//
// Strategy:
//   1. If an asteroid is dangerously close and we're closing on it,
//      brake (reverse thrust) — collisions are tier-lethal.
//   2. Pick the nearest live opponent in sensor range; rotate to face
//      its lead position (10 ticks ahead) and fire when aimed.
//   3. If no opponent in range, shoot at the nearest asteroid in line
//      of sight — small ones are worth 200 points.
//   4. Otherwise drift forward to explore.
function tick(s) {
  const ship = s.ship;
  const opps = s.opponents || [];
  const rocks = s.asteroids || [];

  // ---- 1. Imminent asteroid collision? Brake. ----
  let nearestRock = null;
  let nearestRockD = Infinity;
  for (const a of rocks) {
    const dx = a.pos.x - ship.pos.x;
    const dy = a.pos.y - ship.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy) - (a.radius || 25);
    if (d < nearestRockD) { nearestRockD = d; nearestRock = a; }
  }
  if (nearestRock && nearestRockD < 60) {
    // Reverse thrust kills closing speed regardless of facing.
    return { type: 'thrust', direction: -1 };
  }

  // ---- 2. Engage nearest live opponent ----
  let target = null;
  let targetD = Infinity;
  for (const o of opps) {
    const dx = o.pos.x - ship.pos.x;
    const dy = o.pos.y - ship.pos.y;
    const d = dx * dx + dy * dy;
    if (d < targetD) { targetD = d; target = o; }
  }
  if (target) {
    // Lead the shot: predict 10 ticks of opponent motion.
    const vx = target.vel ? target.vel.x : 0;
    const vy = target.vel ? target.vel.y : 0;
    const leadX = target.pos.x + vx * 10;
    const leadY = target.pos.y + vy * 10;
    const aimAng = Math.atan2(leadY - ship.pos.y, leadX - ship.pos.x);
    let diff = aimAng - ship.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) < 0.12) return { type: 'fire' };
    return { type: 'rotate', direction: diff > 0 ? 1 : -1 };
  }

  // ---- 3. No opponent in range — pick off an asteroid ----
  if (nearestRock) {
    const aimAng = Math.atan2(
      nearestRock.pos.y - ship.pos.y,
      nearestRock.pos.x - ship.pos.x,
    );
    let diff = aimAng - ship.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (Math.abs(diff) < 0.15) return { type: 'fire' };
    return { type: 'rotate', direction: diff > 0 ? 1 : -1 };
  }

  // ---- 4. Empty space — drift forward to scout. ----
  return { type: 'thrust', direction: 1 };
}`,
    shipId: id,
    fitness: zeroFitness(id),
    stage: 0,
    timestamp: Date.now(),
    metadata: {
      generation,
      island,
      behavioralSignature: [],
      complexity: 1,
      noveltyScore: 1.0,
    },
  };
}

/** Summary returned by runEvolution. */
export interface EvolutionSummary {
  generations: number;
  archiveSize: number;
  leaderboard: ArchivedBot[];
  totalMutations: number;
  acceptedMutations: number;
}

/** Options for the evaluator that survive across the whole run. */
interface EvalOpts {
  pool: IsolatePool;
  ownPool: boolean;
  /** Per-generation FFA opponent pool — overridden each generation. */
  opponentPool?: CompiledBot[];
  /** Per-generation self-play archive snapshot — overridden each generation. */
  selfPlayPool?: ArchivedBot[];
}

/**
 * Pick the initial set of seed bots based on `config.seedMode`.
 *
 *   - `diverse`: LLM-generated population sampled across the joint
 *     behavioural space (~50 distinct profiles by default). The richest
 *     starting point. Async — handled separately in `seedInitialPopulation`.
 *   - `curated`: the 8 hand-coded SEED_TEMPLATES.
 *   - `minimal`: the single active boilerplate seed bot.
 *   - `blank`: a single wait bot — pure emergence.
 *
 * All seed modes produce *mutable* bots: they can be displaced from their
 * MAP-Elites cell by anything better.
 */
function pickSeedSources(
  mode: HarnessConfig['seedMode'],
  islandCount: number,
): ScriptedBot[] {
  switch (mode) {
    case 'blank':
      return [{
        id: 'blank-0',
        name: 'Blank',
        description: 'No-op wait bot — pure emergence baseline.',
        source: `function tick(s) { return { type: 'wait' }; }`,
      }];
    case 'minimal': {
      // The boilerplate seed bot — same source that `makeSeedBot` uses.
      const template = makeSeedBot('minimal-seed', 0, 0);
      return Array.from({ length: Math.max(1, islandCount) }, (_, i) => ({
        id: `minimal-seed-${i}`,
        name: `Minimal Seed ${i}`,
        description: 'Active boilerplate seed (thrust + aim + fire).',
        source: template.source,
      }));
    }
    case 'diverse':
      // Handled asynchronously in seedInitialPopulation — fall back to
      // curated if somehow reached here.
      return SEED_TEMPLATES;
    case 'curated':
    default:
      return SEED_TEMPLATES;
  }
}

/**
 * Number of bots `seedMode: 'diverse'` requests from the LLM. We tried 50
 * and Qwen3.6-distill consistently truncated / lost coherence past ~30 bots
 * in one response — the trailing entries collapsed to near-duplicates or
 * dropped fields. 24 fits comfortably in the 8000-token budget at full
 * fidelity and still gives evolution a richly varied starting population;
 * the rest of the 324-cell Cartesian gets filled by mutation across gens.
 */
const DIVERSE_SEED_COUNT = 24;

/** Wrap a scripted bot as an ArchivedBot with placeholder fitness. */
function archiveFromTemplate(t: ScriptedBot, generation: number): ArchivedBot {
  return {
    id: t.id,
    source: t.source,
    shipId: t.id,
    fitness: zeroFitness(t.id),
    stage: 0,
    timestamp: Date.now(),
    metadata: {
      generation,
      island: 0,
      behavioralSignature: [],
      complexity: 1,
      noveltyScore: 1.0,
    },
  };
}

/**
 * Seed the population with the chosen template set and give each one a
 * real fitness score via a small round of FFA matches.
 *
 * If the seed set has ≥2 bots: run 3 FFA matches (different seeds) with
 * all templates participating. Aggregate per-template stats from those
 * matches → real fitness.
 *
 * If the seed set has 1 bot: skip the FFA, just add the lone seed with
 * zero fitness. It'll get a real score the moment any mutation of it
 * shows up and they compete in the standard cascade.
 */
async function seedInitialPopulation(opts: {
  config: HarnessConfig;
  arena: ArenaPlugin;
  pool: IsolatePool;
  population: Population;
}): Promise<void> {
  const { config, arena, pool, population } = opts;

  // `diverse` mode: ask the LLM for N varied bots at once. Falls back to
  // `curated` if the call returns zero usable seeds.
  let templates: ScriptedBot[];
  if (config.seedMode === 'diverse') {
    logger.info({ count: DIVERSE_SEED_COUNT }, 'Generating diverse seed population via LLM');
    let diverse: DiverseSeed[] = [];
    try {
      diverse = await generateDiverseSeeds(config, DIVERSE_SEED_COUNT);
    } catch (err) {
      logger.warn({ err }, 'generateDiverseSeeds failed — falling back to curated');
    }
    if (diverse.length === 0) {
      logger.warn('Diverse seeding produced 0 usable bots — falling back to curated templates');
      templates = SEED_TEMPLATES;
    } else {
      templates = diverse.map((d) => ({
        id: d.id,
        name: d.id,
        description: `LLM-generated seed (profile: ${JSON.stringify(d.profile)})`,
        source: d.source,
      }));
      logger.info({ valid: templates.length }, 'Diverse seed population ready');
    }
  } else {
    templates = pickSeedSources(config.seedMode, config.islandCount);
  }

  // Compile each template; drop anything that fails to bundle/boot.
  const compiled: Array<{ tmpl: ScriptedBot; bot: CompiledBot }> = [];
  for (const tmpl of templates) {
    const bundled = bundle(tmpl.source);
    if (bundled.startsWith(BUNDLE_ERROR_PREFIX)) {
      logger.warn({ id: tmpl.id, error: bundled.slice(0, 200) }, 'Seed template failed to bundle');
      continue;
    }
    try {
      const bot = pool.compileBot(bundled);
      compiled.push({ tmpl, bot });
    } catch (err) {
      logger.warn({ id: tmpl.id, err }, 'Seed template failed to boot');
    }
  }
  if (compiled.length === 0) {
    throw new Error(`No seed templates compiled (mode=${config.seedMode})`);
  }

  // Single-template path: just add it with zero fitness.
  if (compiled.length === 1) {
    const only = compiled[0];
    const archived = archiveFromTemplate(only.tmpl, 0);
    population.addCandidate(archived);
    logger.info(
      { id: only.tmpl.id, mode: config.seedMode },
      'Seeded population (single template, no warm-up FFA)',
    );
    return;
  }

  // Multi-template path: batch the seeds into FFA-sized groups and run a
  // few passes so every seed gets ~3 matches. With 50 diverse seeds we'd
  // do ceil(50/8) = 7 matches per pass × 3 passes = 21 FFA matches in the
  // seed phase. With 8 curated templates we do 1 match per pass × 3 = 3.
  const stats = new Map<
    string,
    {
      matches: number;
      wins: number;
      draws: number;
      totalScore: number;
      totalTicksAlive: number;
      totalCpuNanos: bigint;
      maxCpuNanosPerTick: bigint;
      crashes: number;
      aggressionSum: number;
      economySum: number;
      signature: string[];
    }
  >();
  for (const { tmpl } of compiled) {
    stats.set(tmpl.id, {
      matches: 0,
      wins: 0,
      draws: 0,
      totalScore: 0,
      totalTicksAlive: 0,
      totalCpuNanos: 0n,
      maxCpuNanosPerTick: 0n,
      crashes: 0,
      aggressionSum: 0,
      economySum: 0,
      signature: [],
    });
  }

  /** Seeded Fisher-Yates so the batching order is deterministic per pass. */
  function shufflePass<T>(arr: T[], seed: number): T[] {
    const a = [...arr];
    let s = (seed | 0) || 1;
    for (let i = a.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) | 0;
      const j = Math.abs(s) % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const PASS_SEEDS = [11, 22, 33];
  let matchCounter = 0;
  for (const passSeed of PASS_SEEDS) {
    const order = shufflePass(compiled, passSeed);
    for (let off = 0; off < order.length; off += FFA_MATCH_SIZE) {
      const batch = order.slice(off, off + FFA_MATCH_SIZE);
      if (batch.length < 2) continue; // need ≥ 2 ships for a meaningful match

      const shipBots = new Map<string, CompiledBot>();
      const shipIdToTmpl = new Map<string, ScriptedBot>();
      batch.forEach(({ tmpl, bot }, i) => {
        const shipId = `ship-${i}`;
        shipBots.set(shipId, bot);
        shipIdToTmpl.set(shipId, tmpl);
      });

      const gameConfig = {
        worldWidth: 2800,
        worldHeight: 2100,
        seed: passSeed * 100 + matchCounter,
        asteroidCount: 24,
        tickMs: 50,
        maxBulletsPerShip: 3,
        bulletSpeed: 8,
        shipThrust: 0.15,
        shipRotationSpeed: 0.08,
        shipMaxFuel: 10000,
        asteroidBaseRadius: 25,
        asteroidSpeed: 2.5,
        shipCount: shipBots.size,
      };
      const report = playMatch(arena, pool, shipBots, gameConfig, 2000, 50);
      matchCounter += 1;

      // Compute ranks by score desc for outcome tagging.
      const sorted = [...report.ships].sort((a, b) => b.score - a.score);
      const top = sorted[0]?.score ?? 0;
      const second = sorted[1]?.score ?? 0;
      const median = sorted[Math.floor(sorted.length / 2)]?.score ?? 0;
      for (const sr of report.ships) {
        const tmpl = shipIdToTmpl.get(sr.shipId);
        if (!tmpl) continue;
        const s = stats.get(tmpl.id);
        if (!s) continue;
        const outcome: 'W' | 'L' | 'D' =
          sr.score === top && top > second ? 'W'
          : sr.score < median ? 'L'
          : 'D';
        s.matches += 1;
        if (outcome === 'W') s.wins += 1;
        else if (outcome === 'D') s.draws += 1;
        s.totalScore += sr.score;
        s.totalTicksAlive += sr.ticksAlive;
        s.totalCpuNanos += sr.cpuNanosTotal;
        if (sr.cpuNanosMax > s.maxCpuNanosPerTick) s.maxCpuNanosPerTick = sr.cpuNanosMax;
        s.crashes += sr.histogram.invalid;
        s.aggressionSum += aggressionScore(sr.histogram);
        s.economySum += economyScore(sr.histogram);
        s.signature.push(`seed-ffa:${gameConfig.seed}:${outcome}`);
      }
    }
  }
  logger.info(
    { templates: compiled.length, matches: matchCounter, mode: config.seedMode },
    'Seed-phase FFAs complete',
  );

  // Archive each seed with its aggregated fitness.
  for (const { tmpl } of compiled) {
    const aggregated = stats.get(tmpl.id);
    if (!aggregated) continue;
    const fitness = buildFitnessFromStats(
      { shipId: tmpl.id, ...aggregated },
      config.mode,
      config,
    );
    const archived: ArchivedBot = {
      id: tmpl.id,
      source: tmpl.source,
      shipId: tmpl.id,
      fitness,
      stage: 2,
      timestamp: Date.now(),
      metadata: {
        generation: 0,
        island: 0,
        behavioralSignature: aggregated.signature,
        complexity: 1,
        noveltyScore: 1.0,
      },
    };
    population.addCandidate(archived);
    logger.info(
      {
        id: tmpl.id,
        fitness: fitness.fitnessScore,
        winRate: fitness.winRate,
        avgScore: fitness.avgScore,
      },
      'Seeded population from template',
    );
  }

  // Dispose the seed-FFA compile copies — the population stores ArchivedBots
  // (source only). Per-generation evaluations re-compile what they need.
  for (const { bot } of compiled) {
    try { pool.destroy(bot); } catch { /* ignore */ }
  }
}

/**
 * Hit `${baseUrl}/models` (OpenAI-compatible probe) and confirm the LLM
 * server is reachable within `timeoutMs`. Used as the startup gate so a
 * run with a typo'd or down endpoint fails *before* seeding rather than
 * silently producing zero-mutation noise.
 */
async function probeLlmEndpoint(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 5000,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = baseUrl.replace(/\/$/, '') + '/models';
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, latencyMs };
  } catch (err) {
    const msg = (err as Error).name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : (err as Error).message;
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the evolutionary loop for the genetic harness.
 *
 * Steps each generation:
 *   1. extract elites per island
 *   2. mutate via LLM (or mock)
 *   3. evaluate through the multi-stage cascade
 *   4. add accepted candidates to the population
 *   5. migrate between islands
 *
 * Returns an EvolutionSummary. Does *not* call process.exit; callers
 * (CLI wrapper or tests) decide whether to terminate.
 *
 * Stops early after `maxGenerations` (default 50) — pass via overrides.
 */
export async function runEvolution(
  overrides: Partial<HarnessConfig> & { maxGenerations?: number } = {},
): Promise<EvolutionSummary> {
  const config = loadConfig(overrides);
  const arena = getArena(config.arena);

  if (!arena) {
    logger.error({ arena: config.arena }, 'Arena not found — aborting evolution');
    return {
      generations: 0,
      archiveSize: 0,
      leaderboard: [],
      totalMutations: 0,
      acceptedMutations: 0,
    };
  }

  // ---- LLM probe ---------------------------------------------------------
  // Production runs must reach a real LLM. `'mock'` is preserved only as
  // an explicit opt-in test fixture (used by the suite); the dashboard and
  // CLI never set this. Any other unreachable URL hard-aborts before we
  // burn cycles on seeding/evaluation.
  //
  // The capability probe runs on the same trip — it detects what
  // `response_format` modes the server actually honors so the mutation
  // pipeline (Slice E) can pick the strongest available path.
  if (config.llmBaseUrl !== 'mock') {
    const probe = await probeLlmEndpoint(config.llmBaseUrl, config.llmApiKey);
    if (!probe.ok) {
      logger.error(
        { llmBaseUrl: config.llmBaseUrl, llmModel: config.llmModel, error: probe.error },
        'LLM endpoint unreachable — aborting run',
      );
      throw new Error(
        `LLM endpoint at ${config.llmBaseUrl} is unreachable: ${probe.error}. ` +
        `Set HARNESS_LLM_BASE_URL to a working OpenAI-compatible /v1 endpoint.`,
      );
    }
    logger.info(
      { llmBaseUrl: config.llmBaseUrl, llmModel: config.llmModel, latencyMs: probe.latencyMs },
      'LLM endpoint reachable',
    );

    // Structured-output capability probe. Stored on the cached singleton
    // so downstream callers (mutation, diverse-seed) can read it via
    // getOrProbeCapabilities(config) without re-running.
    const caps = await getOrProbeCapabilities(config);
    logger.info(
      {
        structuredOutput: caps.structuredOutput,
        jsonObjectHonored: caps.jsonObjectHonored,
        jsonSchemaHonored: caps.jsonSchemaHonored,
      },
      'LLM structured-output capabilities detected',
    );
  }

  logger.info({ populationSize: config.populationSize, islandCount: config.islandCount }, 'Starting evolution');

  // Capture any archived elites BEFORE we wipe (so the order is:
  // load → clear → write fresh). This lets the user check both
  // `clearArchiveBeforeRun` and `seedFromArchive.enabled` without losing
  // the elites they wanted to carry over.
  let archivedElites: ArchivedBot[] = [];
  if (config.seedFromArchive?.enabled && config.seedFromArchive.count > 0) {
    try {
      const loaded = loadLeaderboard(config.archiveDir);
      if (loaded && loaded.length > 0) {
        archivedElites = loaded.slice(0, config.seedFromArchive.count);
        logger.info(
          { count: archivedElites.length, requested: config.seedFromArchive.count },
          'Loaded archived elites for carry-over',
        );
      } else {
        logger.warn(
          { archiveDir: config.archiveDir },
          'seedFromArchive enabled but no leaderboard found — falling back to boilerplate seeds only',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load archived leaderboard — falling back to boilerplate seeds only');
    }
  }

  if (config.clearArchiveBeforeRun) {
    try {
      clearArchiveDir(config.archiveDir);
      logger.info({ archiveDir: config.archiveDir }, 'Cleared archive directory');
    } catch (err) {
      logger.warn({ err, archiveDir: config.archiveDir }, 'Failed to clear archive directory');
    }
  }

  // Initialize population
  const population = new Population({
    islandCount: config.islandCount,
    migrationInterval: config.migrationInterval,
  });

  const monitor = new HeartbeatMonitor(config.maxIdleMs, config.evalTimeoutMs);
  const monitorTimer = monitor.start(5000);

  // Single shared isolate pool for the run.
  const pool = new IsolatePool();
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  // ---- Seed phase ------------------------------------------------------
  // Pick the initial bots per `config.seedMode` and run a quick FFA round
  // so every seed enters the population with a real fitness score (and a
  // meaningful MAP-Elites cell placement). All seeds — including the
  // hand-coded templates — are *mutable*: they can be displaced from their
  // niche by better evolved bots later.
  try {
    await seedInitialPopulation({
      config,
      arena,
      pool,
      population,
    });
  } catch (err) {
    logger.error({ err }, 'Seed phase failed — aborting evolution');
    clearInterval(monitorTimer);
    monitor.clear();
    pool.cleanup();
    return {
      generations: 0,
      archiveSize: 0,
      leaderboard: [],
      totalMutations: 0,
      acceptedMutations: 0,
    };
  }

  const evalOpts: EvalOpts = { pool, ownPool: false };

  // Carry top-K elites from the previous archive (if requested). These are
  // *additional* seeds — the boilerplate seeds above still provide the
  // diversity floor. Each carry-over is re-evaluated through the cascade
  // before joining the population (fitness function may have shifted; old
  // scores aren't trustworthy). Carry-overs that fail to compile/evaluate
  // are dropped silently.
  if (archivedElites.length > 0) {
    // Carry-overs need real fitness against the *current* population.
    // Compile a snapshot of the post-seed-phase top-K as their opponents.
    const carryOpponents = population.getTopK(FFA_MATCH_SIZE - 1);
    const carryOpponentsCompiled: CompiledBot[] = [];
    for (const opp of carryOpponents) {
      const bundled = bundle(opp.source);
      if (bundled.startsWith(BUNDLE_ERROR_PREFIX)) continue;
      try {
        carryOpponentsCompiled.push(pool.compileBot(bundled));
      } catch { /* skip */ }
    }
    const carryEvalOpts: EvalOpts = {
      ...evalOpts,
      opponentPool: carryOpponentsCompiled,
    };
    let carried = 0;
    try {
      for (let i = 0; i < archivedElites.length; i++) {
        const elite = archivedElites[i];
        const island = i % config.islandCount;
        const carryBot: ArchivedBot = {
          ...elite,
          id: `carryover-${elite.id}`,
          metadata: { ...elite.metadata, island },
        };
        try {
          const result = await evaluate(carryBot, config.arena, config, carryEvalOpts);
          if (result.error) {
            logger.warn(
              { id: carryBot.id, error: result.error.slice(0, 200) },
              'Carry-over bot failed to evaluate — dropping',
            );
            continue;
          }
          carryBot.fitness = result.fitness;
          carryBot.stage = result.stage;
          population.addCandidate(carryBot);
          carried += 1;
          logger.info(
            { id: carryBot.id, island, fitness: carryBot.fitness.fitnessScore },
            'Carried over archived elite',
          );
        } catch (err) {
          logger.warn({ err, id: carryBot.id }, 'Carry-over evaluation threw — dropping');
        }
      }
    } finally {
      for (const c of carryOpponentsCompiled) {
        try { pool.destroy(c); } catch { /* ignore */ }
      }
    }
    logger.info({ carried, requested: archivedElites.length }, 'Carry-over seeding complete');
  }

  const maxGenerations = overrides.maxGenerations ?? 50;
  let generation = 0;
  let totalMutations = 0;
  let acceptedMutations = 0;

  while (generation < maxGenerations) {
    logger.info({ generation, population: population.summary() }, `Generation ${generation}`);

    // Get candidates to mutate (top bots from each island)
    const candidates = population.getNextGeneration();
    if (candidates.length === 0) {
      logger.warn('No candidates to mutate — seeding fallback bots');
      for (let i = 0; i < config.islandCount; i++) {
        population.addCandidate(makeSeedBot(`fallback-${i}`, i, generation));
      }
      generation++;
      continue;
    }

    // Generate mutations
    const mutationPromises = candidates.map(async (bot, idx) => {
      const id = `gen${generation}-bot${idx}-${bot.shipId}`;
      monitor.register(id);
      monitor.tick(id, 'generating mutation');

      try {
        const context: MutationContext = {
          bestK: population.getTopK(2),
          evaluationHistory: '',
          rewardReflection: {
            winRate: bot.fitness.winRate,
            avgScore: bot.fitness.avgScore,
            avgFuelPerTick: bot.fitness.avgFuelPerTick,
            avgTicksAlive: bot.fitness.avgTicksAlive,
            fuelBreakdownBySource: [],
            topBehavioralAxes: {
              aggression: bot.fitness.aggression ?? 0,
              economic: bot.fitness.economy ?? 0,
              defensive: 0,
            },
          },
          mode: config.mode,
          fuelBudget: config.fuelCeiling,
          λ: config.λ ?? 0,
        };

        const mutation = await generateMutationWithRetry(bot.source, context, config, 2);
        totalMutations++;

        monitor.tick(id, `mutated: ${mutation.reason}`);

        // Create archived bot for the mutation
        const newBot: ArchivedBot = {
          id,
          source: mutation.source,
          shipId: id,
          fitness: bot.fitness, // Will be updated by evaluator
          stage: 0,
          timestamp: Date.now(),
          metadata: {
            generation,
            island: 0,
            behavioralSignature: [],
            complexity: 1,
            noveltyScore: 1.0,
          },
        };

        return newBot;
      } catch (err: unknown) {
        logger.error({ err }, 'Mutation failed');
        // Mutation died — drop the heartbeat entry now since no eval will
        // run to clean it up.
        monitor.remove(id);
        return null;
      }
    });

    const newBots = (await Promise.all(mutationPromises)).filter(Boolean) as ArchivedBot[];

    // Evaluate mutations.
    //
    // Per-generation opponent sampling: take the top (FFA_MATCH_SIZE - 1)
    // bots from the current population. These act as the FFA opponents for
    // every candidate evaluated this generation. The pool is compiled
    // *once per generation* and re-used across all candidate evaluations,
    // then disposed at the end of the generation. This is the survival-
    // of-the-fittest substrate: candidates have to beat the *current*
    // strongest bots, not a hand-coded frozen roster.
    const opponentArchive = population.getTopK(FFA_MATCH_SIZE - 1);
    const opponentCompiled: CompiledBot[] = [];
    const opponentIds: string[] = [];
    for (const opp of opponentArchive) {
      const bundled = bundle(opp.source);
      if (bundled.startsWith(BUNDLE_ERROR_PREFIX)) continue;
      try {
        opponentCompiled.push(pool.compileBot(bundled));
        opponentIds.push(opp.shipId);
      } catch (err) {
        logger.warn({ id: opp.id, err }, 'Per-gen opponent compile failed — skipping');
      }
    }

    const selfPlayPool = config.stages.selfPlay?.enabled
      ? population.getTopK(config.stages.selfPlay.topK)
      : [];
    const evalOptsForGen: EvalOpts = {
      ...evalOpts,
      opponentPool: opponentCompiled,
      selfPlayPool,
    };

    try {
      const evalPromises = newBots.map(async (bot) => {
        monitor.tick(bot.id, 'evaluating');
        try {
          const result = await evaluate(bot, config.arena, config, evalOptsForGen);

          // Add to population with updated fitness
          if (!result.error && result.fitness) {
            const finalBot: ArchivedBot = {
              id: bot.id,
              source: result.source,
              shipId: result.shipId,
              fitness: result.fitness,
              stage: result.stage,
              timestamp: result.timestamp,
              metadata: bot.metadata,
            };
            population.addCandidate(finalBot);
            acceptedMutations++;
          }
          // Heartbeat: drop this task so it stops being reported as
          // "stalled" 5s after the gen completes. We previously only
          // .tick'd, which left a thousand zombie entries piling up.
          monitor.remove(bot.id);
          return result;
        } catch (err: unknown) {
          logger.error({ err }, 'Evaluation failed');
          monitor.remove(bot.id);
          return null;
        }
      });

      await Promise.all(evalPromises);
    } finally {
      // Dispose this generation's compiled opponents.
      for (const c of opponentCompiled) {
        try { pool.destroy(c); } catch { /* ignore */ }
      }
    }

    // Migration
    population.migrate();

    // Check for stalls
    const stalls = monitor.checkStalls();
    if (stalls.length > 0) {
      logger.warn({ stalls }, 'Stalled tasks detected');
    }

    generation++;

    // Snapshot the leaderboard so the HTTP UI sees per-generation progress.
    const snapshot = population
      .getArchive()
      .sort((a, b) => b.fitness.fitnessScore - a.fitness.fitnessScore)
      .slice(0, config.leaderboardSize);
    setLeaderboard(snapshot);
    try {
      writeLeaderboard(config.archiveDir, snapshot);
    } catch (err) {
      logger.warn({ err }, 'Failed to persist leaderboard.json');
    }

    // Replay recording (opt-in): re-run top-N elites against this
    // generation's opponent pool (sampled from population) with frame
    // capture. The opponents were already disposed by the eval-try
    // finally, so we re-compile them here on demand.
    if (config.recordReplays) {
      try {
        const elites = population.getTopK(config.replayCount);
        // Re-compile opponents for the recorded matches. They live only
        // for the duration of this block.
        const replayOppArchive = population.getTopK(FFA_MATCH_SIZE - 1);
        const replayOppCompiled: CompiledBot[] = [];
        const replayOppIds: string[] = [];
        for (const opp of replayOppArchive) {
          const bundled = bundle(opp.source);
          if (bundled.startsWith(BUNDLE_ERROR_PREFIX)) continue;
          try {
            replayOppCompiled.push(pool.compileBot(bundled));
            replayOppIds.push(opp.shipId);
          } catch { /* skip */ }
        }

        const entry = recordEliteReplays({
          arena,
          arenaName: config.arena,
          pool,
          opponentPool: replayOppCompiled,
          opponentIds: replayOppIds,
          elites,
          generation: generation - 1,
          archiveDir: config.archiveDir,
          config,
          selfPlayPool,
        });

        // Dispose the replay-only opponent copies.
        for (const c of replayOppCompiled) {
          try { pool.destroy(c); } catch { /* ignore */ }
        }

        // Per-generation rollup for the chart panel.
        const archive = population.getArchive();
        const meanFitness =
          archive.length > 0
            ? archive.reduce((s, b) => s + b.fitness.fitnessScore, 0) / archive.length
            : 0;
        const meanFuel =
          archive.length > 0
            ? archive.reduce((s, b) => s + b.fitness.avgFuelPerTick, 0) / archive.length
            : 0;
        const bestEntry = snapshot[0];
        const stats = {
          generation: generation - 1,
          bestFitness: bestEntry?.fitness.fitnessScore ?? 0,
          bestWinRate: bestEntry?.fitness.winRate ?? 0,
          meanFitness,
          meanFuel,
          archiveSize: archive.length,
        };

        appendGenerationToManifest(config.archiveDir, {
          runId,
          arena: config.arena,
          sanitizedConfig: sanitizeConfig(config),
          entry,
          leaderboard: snapshot,
          mapElitesGrid: population.getGridSnapshot(),
          generationStats: stats,
        });

        // Bound disk usage by pruning generation directories beyond the
        // configured rolling window.
        if (config.replayKeepGenerations > 0) {
          pruneOldGenerations(config.archiveDir, config.replayKeepGenerations);
        }
      } catch (err) {
        logger.warn({ err }, 'Replay recording failed for this generation');
      }
    }

    // Log progress
    const best = population.getBest();
    if (best) {
      logger.info({
        generation,
        bestScore: best.fitness.fitnessScore.toFixed(2),
        bestWinRate: (best.fitness.winRate * 100).toFixed(1) + '%',
        accepted: acceptedMutations,
        total: totalMutations,
      }, 'Generation complete');
    }
  }

  // Output results
  const archive = population.getArchive();
  const leaderboard = archive
    .sort((a, b) => b.fitness.fitnessScore - a.fitness.fitnessScore)
    .slice(0, config.leaderboardSize);

  logger.info({
    generations: generation,
    archiveSize: archive.length,
    leaderboardSize: leaderboard.length,
    totalMutations,
    acceptedMutations,
  }, 'Evolution complete');

  clearInterval(monitorTimer);
  monitor.clear();
  pool.cleanup();

  return {
    generations: generation,
    archiveSize: archive.length,
    leaderboard,
    totalMutations,
    acceptedMutations,
  };
}

/**
 * CLI entry: invoked when this module is the program's main script.
 * Detects via Node's `import.meta.url` so importers don't trigger it.
 */
const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const overrides = process.argv[2] ? JSON.parse(process.argv[2]) : {};
  runEvolution(overrides)
    .then((summary) => {
      console.log(
        `\nEvolution complete: ${summary.generations} generations, ` +
          `${summary.archiveSize} archived, ${summary.acceptedMutations}/${summary.totalMutations} accepted.`,
      );
      if (summary.leaderboard[0]) {
        const best = summary.leaderboard[0];
        console.log(
          `Top: ${best.id} winRate=${(best.fitness.winRate * 100).toFixed(1)}% ` +
            `score=${best.fitness.fitnessScore.toFixed(3)} ` +
            `fuel=${best.fitness.avgFuelPerTick.toFixed(0)}ns/tick`,
        );
      }
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'Fatal error during evolution');
      process.exit(1);
    });
}
