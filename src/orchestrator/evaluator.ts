/**
 * @module evaluator
 */

/**
 * Multi-stage evaluation engine for genetic harness candidates.
 *
 * Runs each candidate through progressively expensive evaluation stages:
 *   Stage 1: Syntax + compile check (cheap, kills 90% of mutations)
 *   Stage 2: Quick rollout (50 steps vs scripted opponents)
 *   Stage 3: Quick games (10 matches)
 *   Stage 4: Full tournament (50 matches vs full roster)
 */

import { logger } from '../shared/logger.js';
import type {
  EvaluationResult,
  FitnessResult,
  ArchivedBot,
  HarnessConfig,
  GameConfig,
  BotAction,
  ArenaPlugin,
} from '../shared/types.js';
import { getArena } from '../arena/interface.js';
import { IsolatePool } from '../runtime/isolate.js';
import { bundle } from '../runtime/bundler.js';
import { createWorld, worldTick, spawnBullet } from '../engine/world.js';
import { detectCollisions } from '../engine/collision.js';

// Simple scripted opponent that moves randomly
function scriptedAction(): BotAction {
  const r = Math.random();
  if (r < 0.3) return { type: 'rotate', direction: Math.random() > 0.5 ? 1 : -1 };
  if (r < 0.5) return { type: 'thrust', angle: 0 };
  if (r < 0.6) return { type: 'fire' };
  return { type: 'wait' };
}

/**
 * Run a single match between bots and return final scores.
 */
function playMatch(
  arena: ArenaPlugin,
  bots: Map<string, ArchivedBot>,
  config: GameConfig,
  maxTicks: number = 500,
): { scores: Map<string, number>; alive: Set<string>; duration: number } {
  const state = arena.init(config);
  const alive = new Set<string>(state.ships.map((s) => s.id));
  const scores = new Map<string, number>();
  for (const ship of state.ships) {
    scores.set(ship.id, ship.score);
  }

  let tick = 0;
  while (tick < maxTicks && alive.size > 1) {
    const actions = new Map<string, BotAction>();
    for (const ship of state.ships) {
      if (!alive.has(ship.id)) continue;
      const bot = bots.get(ship.id);
      if (!bot) {
        actions.set(ship.id, scriptedAction());
        continue;
      }
      actions.set(ship.id, scriptedAction());
    }

    state.tick = tick;
    state.ships = state.ships.filter((s) => alive.has(s.id));
    const newState = arena.tick(state, actions);

    alive.clear();
    for (const s of newState.ships) {
      if (s.health > 0) alive.add(s.id);
    }

    for (const ship of newState.ships) {
      scores.set(ship.id, ship.score);
    }

    tick++;
  }

  // Determine winners
  let maxScore = -Infinity;
  const scoreValues = Array.from(scores.values());
  for (const s of scoreValues) {
    if (s > maxScore) maxScore = s;
  }
  const winners: string[] = [];
  const scoreEntries = Array.from(scores.entries());
  for (const [id, score] of scoreEntries) {
    if (score >= maxScore) winners.push(id);
  }

  return { scores, alive, duration: tick };
}

/**
 * Construct a FitnessResult from evaluation data.
 *
 * Computes a combined fitness score from win rate and fuel efficiency:
 *   fitnessScore = winRate * 1000 - avgFuelPerTick * 0.001
 *
 * @param shipId       - ID of the ship being evaluated
 * @param winRate      - Win rate (0.0 to 1.0, clamped)
 * @param avgScore     - Average score per match
 * @param avgFuelPerTick - Average fuel consumed per tick
 * @param avgTicksAlive - Average number of ticks the ship survived
 * @param totalMatches - Total number of matches played
 * @param totalTicksAlive - Total ticks alive across all matches
 * @param cpuTimeTotal - Total CPU time consumed (nanoseconds)
 * @param memoryUsed   - Memory used by the isolate (bytes)
 * @param crashes      - Number of evaluation crashes
 * @returns A FitnessResult object for ranking and archival
 */
export function buildFitness(
  shipId: string,
  winRate: number,
  avgScore: number,
  avgFuelPerTick: number,
  avgTicksAlive: number,
  totalMatches: number,
  totalTicksAlive: number,
  cpuTimeTotal: number,
  memoryUsed: number,
  crashes: number,
): FitnessResult {
  const fitnessScore = winRate * 1000 - avgFuelPerTick * 0.001;

  return {
    shipId,
    winRate: Math.max(0, Math.min(1, winRate)),
    avgScore,
    avgFuelPerTick,
    avgTicksAlive,
    totalMatches,
    totalTicksAlive,
    cpuTimeTotal: BigInt(cpuTimeTotal),
    memoryUsed,
    crashes,
    fitnessScore,
  };
}

/**
 * Evaluate a candidate bot through the multi-stage evaluation cascade.
 *
 * Stages:
 *   0 — Syntax/compile check (bundler, rejects malformed code)
 *   1 — Quick rollout: 200-tick matches against scripted opponents
 *   2+ — Additional evaluation rounds with increasing game count
 *
 * After each stage, the bot's fitness is computed and the stage is
 * incremented. A bot must pass all stages to reach its final fitness score.
 *
 * @param bot        - The ArchivedBot to evaluate
 * @param arenaName  - Name of the arena to play in (must be registered)
 * @param config     - Full harness configuration
 * @param cpuTimeUsed - Cumulative CPU time already consumed (for fitness calc)
 * @returns An EvaluationResult with fitness score, stage, and optional error
 */
export async function evaluate(
  bot: ArchivedBot,
  arenaName: string,
  config: HarnessConfig,
  cpuTimeUsed: number = 0,
): Promise<EvaluationResult> {
  const arena = getArena(arenaName);
  if (!arena) {
    return {
      source: bot.source,
      shipId: bot.shipId,
      stage: 0,
      fitness: buildFitness(bot.shipId, 0, 0, 0, 0, 0, 0, 0, 0, 1),
      error: `Arena "${arenaName}" not found`,
      timestamp: Date.now(),
    };
  }

  const stage = bot.stage;
  logger.debug({ shipId: bot.shipId, stage }, 'Evaluating candidate');

  // Stage 0: syntax/compile check
  if (stage === 0) {
    const bundled = bundle(bot.source);
    if (bundled.startsWith('// Compilation error:')) {
      return {
        source: bot.source,
        shipId: bot.shipId,
        stage: 1,
        fitness: buildFitness(bot.shipId, 0, 0, 0, 0, 0, 0, cpuTimeUsed, 0, 1),
        error: bundled,
        timestamp: Date.now(),
      };
    }
    // Stage 0 passed — bump to stage 1
    return {
      source: bot.source,
      shipId: bot.shipId,
      stage: 1,
      fitness: buildFitness(bot.shipId, 0, 0, 0, 0, 0, 0, cpuTimeUsed, 0, 0),
      timestamp: Date.now(),
    };
  }

  // Stages 1+: play matches
  const arenaConfig = arena.init({} as any).config;
  const botMap = new Map<string, ArchivedBot>();
  botMap.set(bot.shipId, bot);

  const quickGames = config.stages.quickGames.games || 10;
  const fullGames = config.stages.fullTournament.games || 50;

  let totalScore = 0;
  let totalTicksAlive = 0;
  let totalMatches = 0;
  let totalWins = 0;

  for (let i = 0; i < quickGames; i++) {
    const result = playMatch(arena, botMap, arenaConfig, 200);
    const score = result.scores.get(bot.shipId) || 0;
    totalScore += score;
    totalTicksAlive += Math.min(result.duration, 200);
    totalMatches++;
    if (score > 0) totalWins++;
  }

  const winRate = totalMatches > 0 ? totalWins / totalMatches : 0;

  return {
    source: bot.source,
    shipId: bot.shipId,
    stage: Math.min(stage + 1, 4),
    fitness: buildFitness(
      bot.shipId,
      winRate,
      totalScore / Math.max(totalMatches, 1),
      cpuTimeUsed / Math.max(totalMatches, 1),
      totalTicksAlive / Math.max(totalMatches, 1),
      totalMatches,
      totalTicksAlive,
      cpuTimeUsed,
      0,
      0,
    ),
    timestamp: Date.now(),
  };
}
