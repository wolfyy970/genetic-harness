/**
 * @module evaluator
 *
 * Multi-stage evaluation of a candidate bot.
 *
 * Cascade:
 *   stage 0  Compile gate                — esbuild bundle must succeed,
 *                                          isolate must boot with a callable
 *                                          globalThis.tick.
 *   stage 1  Smoke roll-out              — N short matches against the null
 *                                          opponent. Kills crashy / silent /
 *                                          runaway-CPU bots cheaply.
 *   stage 2  Reference-roster tournament — round-robin 1v1 against the
 *                                          frozen reference roster, multiple
 *                                          seeds per opponent.
 *
 * Output is a FitnessResult with the ranking score selected by mode
 * (pure / pareto / capped / weighted) and a behavioral signature derived
 * from per-opponent win/loss/draw outcomes.
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

const DEFAULT_MATCH_TICKS = 400;
const SMOKE_MATCH_TICKS = 80;
const TICK_CPU_BUDGET_MS = 50;
const SEEDS_PER_OPPONENT = 3;

/**
 * Concrete arena config for evaluation matches.
 *
 * Fixed at 2 ships so each match is a clean 1v1 against one reference
 * opponent. Asteroid count is small to keep computational cost stable
 * across the population.
 */
function makeMatchConfig(seed: number, overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    worldWidth: 800,
    worldHeight: 600,
    seed,
    asteroidCount: 4,
    tickMs: 50,
    maxBulletsPerShip: 3,
    bulletSpeed: 8,
    shipThrust: 0.15,
    shipRotationSpeed: 0.08,
    shipMaxFuel: 10000,
    asteroidBaseRadius: 25,
    asteroidSpeed: 1.0,
    shipCount: 2,
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
 * Compile every bot in the reference roster into the pool. The returned
 * map is keyed by reference-bot id so the caller can look up an opponent
 * by name when assembling a match.
 */
export function compileReferenceRoster(
  pool: IsolatePool,
  roster: ScriptedBot[] = REFERENCE_ROSTER,
): Map<string, CompiledBot> {
  const out = new Map<string, CompiledBot>();
  for (const bot of roster) {
    const { bot: compiled, error } = tryCompile(pool, bot.source);
    if (!compiled) {
      throw new Error(`Reference bot "${bot.id}" failed to compile: ${error}`);
    }
    out.set(bot.id, compiled);
  }
  return out;
}

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

/** Determine the outcome for a candidate vs one opponent in a single match. */
type Outcome = 'W' | 'L' | 'D';

function outcomeFor(
  candidateReport: ShipReport | undefined,
  opponentReport: ShipReport | undefined,
): Outcome {
  if (!candidateReport) return 'L';
  if (!opponentReport) return 'W';
  if (candidateReport.score > opponentReport.score) return 'W';
  if (candidateReport.score < opponentReport.score) return 'L';
  // Equal scores: survival breaks the tie, then draw.
  if (candidateReport.survived && !opponentReport.survived) return 'W';
  if (!candidateReport.survived && opponentReport.survived) return 'L';
  return 'D';
}

interface RunMatchOpts {
  arena: ArenaPlugin;
  pool: IsolatePool;
  candidate: CompiledBot;
  opponent: CompiledBot;
  config: GameConfig;
  maxTicks: number;
}

interface SingleMatchResult {
  candidate: ShipReport | undefined;
  outcome: Outcome;
}

/** Wire one match: candidate on ship-0, opponent on ship-1. */
function runOneMatch(opts: RunMatchOpts): SingleMatchResult {
  const shipBots = new Map<string, CompiledBot>();
  shipBots.set('ship-0', opts.candidate);
  shipBots.set('ship-1', opts.opponent);

  const report = playMatch(
    opts.arena,
    opts.pool,
    shipBots,
    opts.config,
    opts.maxTicks,
    TICK_CPU_BUDGET_MS,
  );

  const candidate = report.ships.find((r) => r.shipId === 'ship-0');
  const opponent = report.ships.find((r) => r.shipId === 'ship-1');
  return { candidate, outcome: outcomeFor(candidate, opponent) };
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
    /** Pre-compiled reference roster, keyed by reference-bot id. */
    referenceRoster?: Map<string, CompiledBot>;
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
    const referenceRoster = opts.referenceRoster ?? compileReferenceRoster(pool);

    // ---- Stage 1: smoke roll-out vs null opponent ------------------------
    const nullOpponent = referenceRoster.get('ref-null');
    if (!nullOpponent) {
      throw new Error('Reference roster is missing ref-null');
    }

    const stats = emptyStats(bot.shipId, 0);

    if (config.stages.quickRollout.enabled) {
      const smokeMatch = runOneMatch({
        arena,
        pool,
        candidate,
        opponent: nullOpponent,
        config: makeMatchConfig(11, config.arenaConfig),
        maxTicks: SMOKE_MATCH_TICKS,
      });
      if (mergeMatchIntoStats(stats, smokeMatch.candidate, smokeMatch.outcome)) {
        stats.signature.push(`ref-null:${smokeMatch.outcome}`);
      }
    }

    if (config.stages.quickGames.enabled || config.stages.fullTournament.enabled) {
      const opponents = REFERENCE_ROSTER.filter((r) => r.id !== 'ref-null');
      const seeds: number[] = [];
      for (let i = 0; i < SEEDS_PER_OPPONENT; i++) seeds.push(101 + i * 17);

      for (const opp of opponents) {
        const compiledOpp = referenceRoster.get(opp.id);
        if (!compiledOpp) continue;
        const outcomes: Outcome[] = [];

        for (const seed of seeds) {
          const m = runOneMatch({
            arena,
            pool,
            candidate,
            opponent: compiledOpp,
            config: makeMatchConfig(seed, config.arenaConfig),
            maxTicks: DEFAULT_MATCH_TICKS,
          });
          if (mergeMatchIntoStats(stats, m.candidate, m.outcome)) {
            outcomes.push(m.outcome);
          } else {
            stats.signature.push(`${opp.id}:E`);
          }
        }

        if (outcomes.length) {
          stats.signature.push(`${opp.id}:${outcomes.join('')}`);
        }
      }
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
    } else if (candidateBot) {
      // Shared pool: only dispose this candidate, leave the reference
      // roster (and other candidates) intact.
      pool.destroy(candidateBot);
    }
  }
}

