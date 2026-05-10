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
  FitnessResult,
  MutationContext,
} from '../shared/types.js';
import { loadConfig } from '../shared/config.js';
import { Population } from './population.js';
import { generateMutationWithRetry } from './mutation.js';
import { evaluate, compileReferenceRoster } from './evaluator.js';
import { IsolatePool, type CompiledBot } from '../runtime/isolate.js';
import { HeartbeatMonitor } from './heartbeat.js';
import { getArena } from '../arena/interface.js';
import '../arena/asteroids.js';
import {
  writeLeaderboard,
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
    source: `// Seed bot: basic avoidance behavior
function tick(botState) {
  const ship = botState.ship;
  const asteroids = botState.asteroids;
  const opponents = botState.opponents;

  // Simple approach: rotate toward nearest threat, avoid large asteroids
  let nearestThreat = null;
  let nearestDist = Infinity;

  for (const a of asteroids) {
    const dx = a.pos.x - ship.pos.x;
    const dy = a.pos.y - ship.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < nearestDist && d < 200) {
      nearestDist = d;
      nearestThreat = a;
    }
  }

  if (nearestThreat) {
    // Rotate away from threat
    const angleToThreat = Math.atan2(
      nearestThreat.pos.y - ship.pos.y,
      nearestThreat.pos.x - ship.pos.x
    );
    let diff = angleToThreat - ship.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    return { type: 'rotate', direction: diff > 0 ? -1 : 1 };
  }

  // Check for opponents
  for (const opp of opponents) {
    const dx = opp.pos.x - ship.pos.x;
    const dy = opp.pos.y - ship.pos.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 150) {
      return { type: 'fire' };
    }
  }

  return { type: 'wait' };
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

  logger.info({ populationSize: config.populationSize, islandCount: config.islandCount }, 'Starting evolution');

  // Initialize population
  const population = new Population({
    islandCount: config.islandCount,
    migrationInterval: config.migrationInterval,
  });

  const monitor = new HeartbeatMonitor(config.maxIdleMs, config.evalTimeoutMs);
  const monitorTimer = monitor.start(5000);

  // Single shared isolate pool + pre-compiled reference roster for the
  // entire run. Evaluator compiles the candidate, runs matches against the
  // roster, then disposes only the candidate. This avoids ~25-50ms of
  // wasted reference-roster recompilation per evaluation.
  const pool = new IsolatePool();
  let referenceRoster: Map<string, CompiledBot>;
  try {
    referenceRoster = compileReferenceRoster(pool);
  } catch (err) {
    logger.error({ err }, 'Failed to compile reference roster — aborting evolution');
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

  const evalOpts = { pool, referenceRoster, ownPool: false };
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  // Seed each island with one basic bot, evaluated up front so MAP-Elites
  // placement is meaningful from generation 0.
  const seedCount = config.islandCount;
  for (let i = 0; i < seedCount; i++) {
    const seedBot = makeSeedBot(`seed-${i}`, i, 0);
    try {
      const result = await evaluate(seedBot, config.arena, config, evalOpts);
      if (!result.error) {
        seedBot.fitness = result.fitness;
        seedBot.stage = result.stage;
      }
    } catch (err) {
      logger.warn({ err, seed: seedBot.id }, 'Seed bot evaluation failed');
    }
    population.addCandidate(seedBot);
    logger.info({ seed: seedBot.shipId, fitness: seedBot.fitness.fitnessScore }, 'Seeded island');
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
        monitor.tick(id, `mutation error: ${err}`);
        return null;
      }
    });

    const newBots = (await Promise.all(mutationPromises)).filter(Boolean) as ArchivedBot[];

    // Evaluate mutations
    const evalPromises = newBots.map(async (bot) => {
      monitor.tick(bot.id, 'evaluating');
      try {
        const result = await evaluate(bot, config.arena, config, evalOpts);
        monitor.tick(bot.id, `evaluated stage ${result.stage}`);

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
        return result;
      } catch (err: unknown) {
        logger.error({ err }, 'Evaluation failed');
        return null;
      }
    });

    await Promise.all(evalPromises);

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

    // Replay recording (opt-in): re-run top-N elites against each non-null
    // reference opponent with frame capture, persist to disk, append to
    // manifest. Adds ~few hundred ms / generation; disabled by default.
    if (config.recordReplays) {
      try {
        const elites = population.getTopK(config.replayCount);
        const entry = recordEliteReplays({
          arena,
          arenaName: config.arena,
          pool,
          referenceRoster,
          elites,
          generation: generation - 1,
          archiveDir: config.archiveDir,
          config,
        });

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
