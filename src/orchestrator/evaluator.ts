/**
 * @module evaluator
 *
 * Multi-stage evaluation of a candidate bot.
 *
 * Cascade (8-player free-for-all topology):
 *   stage 0  Compile gate                — esbuild bundle must succeed,
 *                                          isolate must boot with a callable
 *                                          globalThis.tick.
 *   stage 1  Smoke roll-out              — short 1v1 vs the null opponent;
 *                                          kills crashy / silent / runaway-CPU
 *                                          bots cheaply before paying for FFA.
 *   stage 2  Reference-roster FFA        — N matches of {candidate + 7 non-Null
 *                                          roster bots}; multiple seeds.
 *   stage 3  Self-play FFA               — 1 match of {candidate + top-K elites
 *                                          + roster fill} to break the fixed-
 *                                          roster ceiling.
 *
 * N-way outcome rule: a match yields one W/L/D for the candidate.
 *   W: candidate has strictly the highest score (or is sole survivor)
 *   L: candidate score is below the median of all 8 ships
 *   D: otherwise (mid-pack)
 */

import { logger } from '../shared/logger.js';
import type {
  ArchivedBot,
  ArenaPlugin,
  BotAction,
  EvaluationResult,
  FitnessResult,
  GameConfig,
  HarnessConfig,
} from '../shared/types.js';
import { getArena } from '../arena/interface.js';
import { IsolatePool, type CompiledBot } from '../runtime/isolate.js';
import { bundle, BUNDLE_ERROR_PREFIX } from '../runtime/bundler.js';
import {
  playMatch,
  aggressionScore,
  economyScore,
  type ShipReport,
} from './match.js';
import { REFERENCE_ROSTER, type ScriptedBot } from './reference.js';

/**
 * Per-match cap (in ticks). 2000 × 50ms tickMs = 100s of game time —
 * enough for a full 8-ship FFA arc (initial encounter → mid-match attrition
 * → asteroid-field cleanup → endgame chase). `playMatch` exits early as
 * soon as `aliveCount <= 1`, so most matches end well below this cap. The
 * cap is the safety valve for two-passive-bots-refuse-to-engage scenarios
 * that would otherwise run forever.
 */
const DEFAULT_MATCH_TICKS = 2000;
const SMOKE_MATCH_TICKS = 100;
const TICK_CPU_BUDGET_MS = 50;
/** Seeds per FFA stage. 3 matches × ~8 ships ≈ same wall-cost as the old 12 1v1s. */
const SEEDS_PER_FFA = 3;
/** Free-for-all match size including the candidate. */
export const FFA_MATCH_SIZE = 8;

/**
 * Concrete arena config for evaluation matches.
 *
 * `shipCount` is passed by the caller — 2 for the smoke 1v1, 8 for FFA.
 * Asteroid count is small to keep computational cost stable.
 */
function makeMatchConfig(
  seed: number,
  shipCount: number,
  overrides: Partial<GameConfig> = {},
): GameConfig {
  // 2800×2100 world = 12× the original area (800×600). At 8 ships on a
  // ring of radius min(W,H)*0.35 ≈ 735px, ships start ~560px apart —
  // enough room for real navigation. Asteroid count scales to 24 so the
  // field stays interesting without being overcrowded.
  return {
    worldWidth: 2800,
    worldHeight: 2100,
    seed,
    asteroidCount: 24,
    tickMs: 50,
    maxBulletsPerShip: 3,
    bulletSpeed: 8,
    shipThrust: 0.15,
    shipRotationSpeed: 0.08,
    shipMaxFuel: 10000,
    asteroidBaseRadius: 25,
    asteroidSpeed: 2.5,
    shipCount,
    ...overrides,
  };
}

/**
 * Compile a candidate bot into the pool. Returns null if compile fails
 * (the caller treats this as a stage-0 failure).
 */
function tryCompile(
  pool: IsolatePool,
  source: string,
): { bot: CompiledBot | null; error?: string } {
  const bundled = bundle(source);
  if (bundled.startsWith(BUNDLE_ERROR_PREFIX)) {
    return { bot: null, error: bundled };
  }
  try {
    const bot = pool.compileBot(bundled);
    return { bot };
  } catch (err) {
    return { bot: null, error: (err as Error).message };
  }
}

/**
 * Compile a set of scripted bots into the pool, keyed by id. Used both for
 * seeding the initial population from `SEED_TEMPLATES` and for any context
 * that needs a small lookup of compiled bots.
 */
export function compileBotSet(
  pool: IsolatePool,
  bots: ScriptedBot[],
): Map<string, CompiledBot> {
  const out = new Map<string, CompiledBot>();
  for (const bot of bots) {
    const { bot: compiled, error } = tryCompile(pool, bot.source);
    if (!compiled) {
      throw new Error(`Seed template "${bot.id}" failed to compile: ${error}`);
    }
    out.set(bot.id, compiled);
  }
  return out;
}

/**
 * @deprecated alias for `compileBotSet`. The "reference roster" mental
 * model is gone — templates seed the population and then evolve.
 */
export const compileReferenceRoster = (
  pool: IsolatePool,
  roster: ScriptedBot[] = REFERENCE_ROSTER,
): Map<string, CompiledBot> => compileBotSet(pool, roster);

// ---------------------------------------------------------------------------
// Fitness construction
// ---------------------------------------------------------------------------

/** Inputs the fitness function aggregates over. */
interface AggregatedStats {
  shipId: string;
  matches: number;
  wins: number;
  draws: number;
  totalScore: number;
  totalTicksAlive: number;
  totalCpuNanos: bigint;
  maxCpuNanosPerTick: bigint;
  crashes: number;
  /** Running sums for aggression / economy averages; divided by `matches` at the end. */
  aggressionSum: number;
  economySum: number;
  /** Per-opponent W/L/D string (used as behavioral signature). */
  signature: string[];
}

/**
 * Combine a candidate's per-match stats into a FitnessResult, with the
 * scalar `fitnessScore` chosen by the harness mode.
 */
export function buildFitnessFromStats(
  stats: AggregatedStats,
  mode: HarnessConfig['mode'],
  config: Pick<HarnessConfig, 'fuelCeiling' | 'λ'>,
): FitnessResult {
  const winRate = stats.matches > 0 ? stats.wins / stats.matches : 0;
  const drawRate = stats.matches > 0 ? stats.draws / stats.matches : 0;
  const avgScore = stats.matches > 0 ? stats.totalScore / stats.matches : 0;
  const avgTicksAlive =
    stats.matches > 0 ? stats.totalTicksAlive / stats.matches : 0;
  const avgFuelPerTick =
    stats.totalTicksAlive > 0
      ? Number(stats.totalCpuNanos) / stats.totalTicksAlive
      : 0;
  const meanAggression = stats.matches > 0 ? stats.aggressionSum / stats.matches : 0;
  const meanEconomy = stats.matches > 0 ? stats.economySum / stats.matches : 0;

  let fitnessScore: number;
  switch (mode) {
    case 'capped': {
      const ceiling = config.fuelCeiling ?? Infinity;
      if (avgFuelPerTick > ceiling) {
        fitnessScore = -1; // disqualified
      } else {
        fitnessScore = winRate + 0.25 * drawRate;
      }
      break;
    }
    case 'weighted': {
      const lambda = config.λ ?? 0;
      // λ is per-fuel-unit penalty; normalize by 1e6 ns so a typical
      // λ ≈ 1 means "1ms/tick of CPU costs you 1 unit of win-rate."
      fitnessScore = winRate - lambda * (avgFuelPerTick / 1e6);
      break;
    }
    case 'pareto':
    case 'pure':
    default:
      fitnessScore = winRate + 0.25 * drawRate;
      break;
  }

  return {
    shipId: stats.shipId,
    winRate,
    avgScore,
    avgFuelPerTick,
    avgTicksAlive,
    totalMatches: stats.matches,
    totalTicksAlive: stats.totalTicksAlive,
    cpuTimeTotal: stats.totalCpuNanos,
    memoryUsed: 0,
    crashes: stats.crashes,
    fitnessScore,
    aggression: meanAggression,
    economy: meanEconomy,
  };
}

function emptyStats(shipId: string, crashes = 1): AggregatedStats {
  return {
    shipId,
    matches: 0,
    wins: 0,
    draws: 0,
    totalScore: 0,
    totalTicksAlive: 0,
    totalCpuNanos: 0n,
    maxCpuNanosPerTick: 0n,
    crashes,
    aggressionSum: 0,
    economySum: 0,
    signature: [],
  };
}

/**
 * Fold one match's candidate-side report into the running stats.
 * Returns true if the report was non-null (the match counted).
 */
function mergeMatchIntoStats(
  stats: AggregatedStats,
  candidateReport: ShipReport | undefined,
  outcome: Outcome,
): boolean {
  if (!candidateReport) return false;
  stats.matches += 1;
  if (outcome === 'W') stats.wins += 1;
  else if (outcome === 'D') stats.draws += 1;
  stats.totalScore += candidateReport.score;
  stats.totalTicksAlive += candidateReport.ticksAlive;
  stats.totalCpuNanos += candidateReport.cpuNanosTotal;
  if (candidateReport.cpuNanosMax > stats.maxCpuNanosPerTick) {
    stats.maxCpuNanosPerTick = candidateReport.cpuNanosMax;
  }
  stats.crashes += candidateReport.histogram.invalid;
  stats.aggressionSum += aggressionScore(candidateReport.histogram);
  stats.economySum += economyScore(candidateReport.histogram);
  return true;
}

// ---------------------------------------------------------------------------
// Match-level helpers
// ---------------------------------------------------------------------------

/** Single-match outcome for the candidate. */
type Outcome = 'W' | 'L' | 'D';

/**
 * N-way outcome rule.
 *
 *   W: strictly the highest score, OR sole survivor (and there was a fight)
 *   L: score strictly below the median across all participants
 *   D: otherwise (mid-pack)
 *
 * Survival breaks score ties: tying on score but outliving the others is a W;
 * tying and dying is an L.
 */
export function outcomeForNWay(
  candidateReport: ShipReport | undefined,
  allReports: ShipReport[],
): Outcome {
  if (!candidateReport || allReports.length === 0) return 'L';
  if (allReports.length === 1) return 'W'; // sole participant (degenerate)

  const candScore = candidateReport.score;
  const scoresDesc = allReports.map((r) => r.score).sort((a, b) => b - a);
  const topScore = scoresDesc[0];
  const secondScore = scoresDesc[1];
  const median = scoresDesc[Math.floor(scoresDesc.length / 2)];

  const aliveSet = allReports.filter((r) => r.survived);
  const candAlive = candidateReport.survived;

  // Strict top score → W.
  if (candScore === topScore && candScore > secondScore) return 'W';
  // Sole survivor → W (even if score-tied).
  if (aliveSet.length === 1 && candAlive) return 'W';
  // Score-tied at top + alive while another tied is dead → W on survival.
  if (candScore === topScore && candAlive && !aliveSet.every((r) => r.score === candScore)) {
    // No-op — fall through to draw/median check.
  }

  if (candScore < median) return 'L';
  // Dead and didn't outscore the median? Penalize.
  if (!candAlive && candScore <= median) return 'L';
  return 'D';
}

interface FFAOpts {
  arena: ArenaPlugin;
  pool: IsolatePool;
  candidate: CompiledBot;
  /** Opponents in deterministic slot order (ship-1..ship-N). */
  opponents: CompiledBot[];
  config: GameConfig;
  maxTicks: number;
}

interface FFAResult {
  candidate: ShipReport | undefined;
  outcome: Outcome;
  /** 1-based rank by score (1 = best). */
  rank: number;
  /** Total ships in the match. */
  size: number;
}

/**
 * Wire one free-for-all match: candidate on ship-0, opponents on
 * ship-1..ship-N. `playMatch` is already ship-count agnostic.
 */
function runFreeForAllMatch(opts: FFAOpts): FFAResult {
  const shipBots = new Map<string, CompiledBot>();
  shipBots.set('ship-0', opts.candidate);
  for (let i = 0; i < opts.opponents.length; i++) {
    shipBots.set(`ship-${i + 1}`, opts.opponents[i]);
  }

  const report = playMatch(
    opts.arena,
    opts.pool,
    shipBots,
    opts.config,
    opts.maxTicks,
    TICK_CPU_BUDGET_MS,
  );

  const candidate = report.ships.find((r) => r.shipId === 'ship-0');
  const sortedDesc = [...report.ships].sort((a, b) => b.score - a.score);
  const rankIdx = sortedDesc.findIndex((r) => r.shipId === 'ship-0');
  const rank = rankIdx < 0 ? report.ships.length : rankIdx + 1;
  return {
    candidate,
    outcome: outcomeForNWay(candidate, report.ships),
    rank,
    size: report.ships.length,
  };
}

/** Convenience: 1v1 wrapper for the smoke-test stage. */
function runOneMatch(opts: {
  arena: ArenaPlugin;
  pool: IsolatePool;
  candidate: CompiledBot;
  opponent: CompiledBot;
  config: GameConfig;
  maxTicks: number;
}): FFAResult {
  return runFreeForAllMatch({
    arena: opts.arena,
    pool: opts.pool,
    candidate: opts.candidate,
    opponents: [opts.opponent],
    config: opts.config,
    maxTicks: opts.maxTicks,
  });
}

// ---------------------------------------------------------------------------
// Top-level evaluate()
// ---------------------------------------------------------------------------

/**
 * Run a candidate bot through the evaluation cascade and return a
 * full EvaluationResult.
 *
 * The caller may share an IsolatePool across many `evaluate` calls; the
 * pool will accumulate compiled isolates for each candidate. The reference
 * roster is recompiled into the pool on every call (it's cheap; worth
 * optimizing later if it shows up in profiling).
 *
 * On any compile failure the function short-circuits to a stage-0 result.
 * On per-match crashes the candidate accumulates `crashes` count but the
 * cascade continues so we still see partial-credit fitness.
 */
export async function evaluate(
  bot: ArchivedBot,
  arenaName: string,
  config: HarnessConfig,
  opts: {
    pool?: IsolatePool;
    ownPool?: boolean;
    /**
     * Compiled FFA opponents for this evaluation. Sampled from the live
     * population by the caller (typically top-K + the candidate's own
     * generation cohort). When empty, FFA stages are skipped.
     */
    opponentPool?: CompiledBot[];
    /**
     * @deprecated old shape: a Map keyed by hand-coded reference id. New
     * callers pass `opponentPool` directly. The values of this map are
     * concatenated into `opponentPool` as a back-compat shim.
     */
    referenceRoster?: Map<string, CompiledBot>;
    /**
     * Top-K elites from the current population for the self-play stage.
     * Empty (or absent) means "no self-play this evaluation". Each entry
     * gets compiled into the pool and disposed after the cascade.
     */
    selfPlayPool?: ArchivedBot[];
  } = {},
): Promise<EvaluationResult> {
  const arena = getArena(arenaName);
  if (!arena) {
    return {
      source: bot.source,
      shipId: bot.shipId,
      stage: 0,
      fitness: buildFitnessFromStats(emptyStats(bot.shipId), config.mode, config),
      error: `Arena "${arenaName}" not registered`,
      timestamp: Date.now(),
    };
  }

  const pool = opts.pool ?? new IsolatePool();
  const ownPool = opts.ownPool ?? !opts.pool;
  let candidateBot: CompiledBot | null = null;
  // Smoke-only filler bot: a wait bot that exists purely as a "live"
  // opponent for the crash gate. Disposed at end of evaluation.
  let smokeFiller: CompiledBot | null = null;

  // Build the FFA opponent list. New callers pass `opponentPool`; legacy
  // callers (tests, old wiring) may still pass `referenceRoster` and we
  // concatenate the values.
  const opponentPool: CompiledBot[] = [];
  if (opts.opponentPool) opponentPool.push(...opts.opponentPool);
  if (opts.referenceRoster) opponentPool.push(...opts.referenceRoster.values());

  try {
    // ---- Stage 0: compile gate -------------------------------------------
    const compileResult = tryCompile(pool, bot.source);
    if (!compileResult.bot) {
      return {
        source: bot.source,
        shipId: bot.shipId,
        stage: 0,
        fitness: buildFitnessFromStats(emptyStats(bot.shipId), config.mode, config),
        error: compileResult.error,
        timestamp: Date.now(),
      };
    }

    const candidate = compileResult.bot;
    candidateBot = candidate;

    const stats = emptyStats(bot.shipId, 0);

    // ---- Stage 1: smoke 1v1 crash gate -----------------------------------
    // Uses the first opponent in the pool if available; otherwise compiles
    // an inline wait bot so the gate still fires even when seedMode='blank'.
    if (config.stages.quickRollout.enabled) {
      let smokeOpp: CompiledBot | null = opponentPool[0] ?? null;
      if (!smokeOpp) {
        const filler = tryCompile(pool, `function tick(s) { return { type: 'wait' }; }`);
        if (filler.bot) {
          smokeFiller = filler.bot;
          smokeOpp = filler.bot;
        }
      }
      if (smokeOpp) {
        const smokeMatch = runOneMatch({
          arena,
          pool,
          candidate,
          opponent: smokeOpp,
          config: makeMatchConfig(11, 2, config.arenaConfig),
          maxTicks: SMOKE_MATCH_TICKS,
        });
        if (mergeMatchIntoStats(stats, smokeMatch.candidate, smokeMatch.outcome)) {
          stats.signature.push(`smoke:${smokeMatch.outcome}`);
        }
      }
    }

    // ---- Stage 2: FFA against sampled population opponents ---------------
    if (
      (config.stages.quickGames.enabled || config.stages.fullTournament.enabled) &&
      opponentPool.length > 0
    ) {
      const seeds: number[] = [];
      for (let i = 0; i < SEEDS_PER_FFA; i++) seeds.push(101 + i * 17);

      // Use up to 7 opponents (FFA_MATCH_SIZE - 1). If the pool is smaller,
      // the FFA just runs with fewer ships — playMatch is N-agnostic.
      const ffaOpponents = opponentPool.slice(0, FFA_MATCH_SIZE - 1);

      for (const seed of seeds) {
        const m = runFreeForAllMatch({
          arena,
          pool,
          candidate,
          opponents: ffaOpponents,
          config: makeMatchConfig(seed, ffaOpponents.length + 1, config.arenaConfig),
          maxTicks: DEFAULT_MATCH_TICKS,
        });
        if (mergeMatchIntoStats(stats, m.candidate, m.outcome)) {
          stats.signature.push(`ffa:${seed}:${m.outcome}:rank${m.rank}/${m.size}`);
        }
      }
    }

    // ---- Stage 3: self-play vs top-K population elites ------------------
    // The opponent pool already came from the population, so "self-play" is
    // now mostly a redundant stage. Keep it as a focused match against the
    // top-K elites specifically (no pool dilution), which still gives a
    // meaningful "can you beat the best?" signal.
    const selfPlayCompiled: CompiledBot[] = [];
    try {
      if (
        config.stages.selfPlay?.enabled &&
        opts.selfPlayPool &&
        opts.selfPlayPool.length > 0
      ) {
        const topK = opts.selfPlayPool
          .slice(0, config.stages.selfPlay.topK)
          .filter((e) => e.shipId !== bot.shipId);
        const eliteCompiled: CompiledBot[] = [];
        for (const elite of topK) {
          const tc = tryCompile(pool, elite.source);
          if (!tc.bot) continue;
          selfPlayCompiled.push(tc.bot);
          eliteCompiled.push(tc.bot);
        }
        if (eliteCompiled.length > 0) {
          // Pad to 7 opponents with picks from the broader opponentPool.
          const opponents: CompiledBot[] = [...eliteCompiled];
          for (const opp of opponentPool) {
            if (opponents.length >= FFA_MATCH_SIZE - 1) break;
            if (!opponents.includes(opp)) opponents.push(opp);
          }
          const m = runFreeForAllMatch({
            arena,
            pool,
            candidate,
            opponents,
            config: makeMatchConfig(901, opponents.length + 1, config.arenaConfig),
            maxTicks: DEFAULT_MATCH_TICKS,
          });
          if (mergeMatchIntoStats(stats, m.candidate, m.outcome)) {
            const eliteIds = topK.map((e) => e.shipId).join(',');
            stats.signature.push(`selfplay:[${eliteIds}]:${m.outcome}:rank${m.rank}/${m.size}`);
          }
        }
      }
    } finally {
      for (const c of selfPlayCompiled) pool.destroy(c);
    }

    const fitness = buildFitnessFromStats(stats, config.mode, config);
    logger.debug(
      {
        shipId: bot.shipId,
        matches: stats.matches,
        winRate: fitness.winRate,
        avgFuelPerTick: fitness.avgFuelPerTick,
        signature: stats.signature,
      },
      'Evaluation complete',
    );

    return {
      source: bot.source,
      shipId: bot.shipId,
      stage: 2,
      fitness,
      timestamp: Date.now(),
    };
  } finally {
    if (ownPool) {
      pool.cleanup();
    } else {
      // Shared pool: only dispose what *this* evaluation compiled (the
      // candidate + any smoke filler). Leave the caller-owned opponentPool
      // and other candidates intact.
      if (candidateBot) pool.destroy(candidateBot);
      if (smokeFiller) pool.destroy(smokeFiller);
    }
  }
}

