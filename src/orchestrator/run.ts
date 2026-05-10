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
import type { HarnessConfig, ArchivedBot } from '../shared/types.js';
import { loadConfig } from '../shared/config.js';
import { Population } from './population.js';
import { generateMutation } from './mutation.js';
import { evaluate, buildFitness } from './evaluator.js';
import { HeartbeatMonitor } from './heartbeat.js';
import { getArena } from '../arena/interface.js';
import '../arena/asteroids.js';
import { createWorld } from '../engine/world.js';
import { bundle } from '../runtime/bundler.js';

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
    fitness: buildFitness(id, 0, 0, 0, 0, 0, 0, 0, 0, 0),
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

/**
 * Run the evolutionary loop for the genetic harness.
 *
 * Orchestrates the full generational cycle:
 *   1. Load configuration (merge defaults with overrides)
 *   2. Initialize MAP-Elites population (one seed bot per island)
 *   3. For each generation:
 *      a. Extract elites from each island
 *      b. Generate LLM-driven mutations
 *      c. Evaluate mutations through the cascade
 *      d. Add successful mutations to the population
 *      e. Run island migration
 *   4. Output leaderboard and archive on completion
 *
 * This is the CLI entry point — call `runEvolution()` directly or
 * invoke via `node run.ts <JSON_CONFIG>`.
 *
 * @param overrides - Partial config to merge with defaults
 */
export async function runEvolution(overrides: Partial<HarnessConfig> = {}): Promise<void> {
  const config = loadConfig(overrides);
  const arena = getArena(config.arena);

  if (!arena) {
    logger.error({ arena: config.arena }, 'Arena not found — cannot start evolution');
    return;
  }

  logger.info({ populationSize: config.populationSize, islandCount: config.islandCount }, 'Starting evolution');

  // Initialize population
  const population = new Population({
    islandCount: config.islandCount,
    migrationInterval: config.migrationInterval,
  });

  const monitor = new HeartbeatMonitor(config.maxIdleMs, config.evalTimeoutMs);
  const monitorTimer = monitor.start(5000);

  // Seed each island with one basic bot
  const seedCount = config.islandCount;
  for (let i = 0; i < seedCount; i++) {
    const seedBot = makeSeedBot(`seed-${i}`, i, 0);
    population.addCandidate(seedBot);
    logger.info({ seedBot: seedBot.shipId }, 'Seeded island');
  }

  const maxGenerations = (overrides as any).maxGenerations ?? 50;
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
        const context: any = {
          bestK: population.getTopK(2),
          evaluationHistory: '',
          rewardReflection: {
            winRate: bot.fitness.winRate,
            avgScore: bot.fitness.avgScore,
            avgFuelPerTick: bot.fitness.avgFuelPerTick,
            avgTicksAlive: bot.fitness.avgTicksAlive,
            fuelBreakdownBySource: [],
            topBehavioralAxes: { aggression: 0, economic: 0, defensive: 0 },
          },
          mode: config.mode,
          fuelBudget: config.fuelCeiling,
          λ: config.λ ?? 0,
        };

        const mutation = await generateMutation(bot.source, context, config);
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
        const result = await evaluate(bot, config.arena, config, 0);
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
  console.log('\nEvolution complete. Exiting.');
  process.exit(0);
}

// CLI entry point
runEvolution((process.argv[2] ? JSON.parse(process.argv[2]) : {})).catch((err) => {
  logger.error({ err }, 'Fatal error during evolution');
  process.exit(1);
});
