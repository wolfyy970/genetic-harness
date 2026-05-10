/**
 * @module population
 */

/**
 * Island-based MAP-Elites population management.
 *
 * Manages multiple islands of candidates, each maintaining a grid
 * indexed by behavioral axes (strategic style, compute efficiency).
 * Periodic migration swaps candidates between islands to maintain diversity.
 */

import { logger } from '../shared/logger.js';
import type {
  ArchivedBot,
  FitnessResult,
  HarnessConfig,
} from '../shared/types.js';

/** A cell in the MAP-Elites grid */
interface EliteCell {
  bot: ArchivedBot;
}

/**
 * An island of candidates with its own MAP-Elites grid.
 *
 * Each island maintains a grid indexed by behavioral axes (strategy bucket,
 * fuel efficiency bucket). Bots are added to the grid only if they are the
 * elite for their cell. Islands support getting top-K bots, migration, and
 * next-generation extraction.
 *
 * @internal — used by the public Population class
 */
class Island {
  readonly islandId: number;
  readonly grid: Map<string, EliteCell> = new Map();
  readonly candidates: ArchivedBot[] = [];

  constructor(islandId: number) {
    this.islandId = islandId;
  }

  /**
   * Compute the grid cell key for a bot based on its fitness.
   *
   * Strategy bucket: floor(winRate * 4), clamped to [0, 3].
   * Fuel bucket: floor(log2(avgFuelPerTick + 1) / 2), clamped to [0, 7].
   *
   * @param fitness - Fitness result of the bot
   * @returns A string key like "2-4" representing the grid cell
   */
  cellKey(fitness: FitnessResult): string {
    // Bucket strategic style (win rate) into 4 tiers
    const strategyBucket = Math.min(3, Math.floor(fitness.winRate * 4));
    // Bucket fuel efficiency into logarithmic buckets
    const fuel = fitness.avgFuelPerTick;
    const fuelBucket = fuel <= 0 ? 0 : Math.min(7, Math.floor(Math.log2(fuel + 1) / 2));
    return `${strategyBucket}-${fuelBucket}`;
  }

  /**
   * Add or replace a bot in the grid if it's the elite for its cell.
   *
   * @param bot - The ArchivedBot to add
   * @returns true if the bot was added/replaced, false if existing elite is better
   */
  add(bot: ArchivedBot): boolean {
    const key = this.cellKey(bot.fitness);

    const existing = this.grid.get(key);
    if (existing && existing.bot.fitness.fitnessScore >= bot.fitness.fitnessScore) {
      return false;
    }

    this.grid.set(key, { bot });
    this.candidates.push(bot);
    return true;
  }

  /**
   * Get the best bot in this island (highest fitness score).
   *
   * @returns The elite ArchivedBot or null if the grid is empty
   */
  getElite(): ArchivedBot | null {
    if (this.grid.size === 0) return null;
    let best: EliteCell | null = null;
    for (const cell of Array.from(this.grid.values())) {
      if (!best || cell.bot.fitness.fitnessScore > best.bot.fitness.fitnessScore) {
        best = cell;
      }
    }
    return best?.bot ?? null;
  }

  /**
   * Get the top-K bots in this island sorted by fitness score descending.
   *
   * @param k - Number of bots to return
   * @returns Array of ArchivedBots sorted by fitness score (descending)
   */
  getTopK(k: number): ArchivedBot[] {
    const all = Array.from(this.grid.values())
      .map((c) => c.bot)
      .sort((a, b) => b.fitness.fitnessScore - a.fitness.fitnessScore);
    return all.slice(0, k);
  }

  /**
   * Get the worst bot in this island (lowest fitness score).
   *
   * Used for migration — the weakest bot from one island may be replaced
   * by a stronger bot from a neighbor.
   *
   * @returns The weakest ArchivedBot or null if the grid is empty
   */
  getWorst(): ArchivedBot | null {
    if (this.grid.size === 0) return null;
    let worst: EliteCell | null = null;
    for (const cell of Array.from(this.grid.values())) {
      if (!worst || cell.bot.fitness.fitnessScore < worst.bot.fitness.fitnessScore) {
        worst = cell;
      }
    }
    return worst?.bot ?? null;
  }

  /**
   * Number of elite cells in this island's grid.
   *
   * @returns Count of occupied cells
   */
  size(): number {
    return this.grid.size;
  }
}

/**
 * Population manages multiple islands with migration.
 */
export class Population {
  private islands: Island[];
  private migrationInterval: number;
  private totalGenerations: number;

  constructor(config: Pick<HarnessConfig, 'islandCount' | 'migrationInterval'>) {
    this.islands = [];
    for (let i = 0; i < config.islandCount; i++) {
      this.islands.push(new Island(i));
    }
    this.migrationInterval = config.migrationInterval;
    this.totalGenerations = 0;
  }

  /** Add a candidate to the population */
  addCandidate(bot: ArchivedBot): void {
    // Find the island with the fewest candidates
    let bestIsland = this.islands[0];
    let minSize = Infinity;
    for (const island of this.islands) {
      if (island.size() < minSize) {
        minSize = island.size();
        bestIsland = island;
      }
    }
    bestIsland.add(bot);
  }

  /** Get the global best bot across all islands */
  getBest(): ArchivedBot | null {
    let best: ArchivedBot | null = null;
    for (const island of this.islands) {
      const elite = island.getElite();
      if (elite && (!best || elite.fitness.fitnessScore > best.fitness.fitnessScore)) {
        best = elite;
      }
    }
    return best;
  }

  /** Get top-K across all islands */
  getTopK(k: number): ArchivedBot[] {
    const all: ArchivedBot[] = [];
    for (const island of this.islands) {
      const elite = island.getElite();
      if (elite) all.push(elite);
    }
    all.sort((a, b) => b.fitness.fitnessScore - a.fitness.fitnessScore);
    return all.slice(0, k);
  }

  /** Perform migration between islands */
  migrate(): void {
    this.totalGenerations++;
    if (this.totalGenerations % this.migrationInterval !== 0) return;

    logger.info({ generation: this.totalGenerations }, 'Migration event');

    for (let i = 0; i < this.islands.length; i++) {
      const island = this.islands[i];
      const worst = island.getWorst();
      if (!worst) continue;

      const targetIdx = (i + 1) % this.islands.length;
      const target = this.islands[targetIdx];
      const targetElite = target.getElite();

      if (targetElite && worst.fitness.fitnessScore < targetElite.fitness.fitnessScore) {
        const key = island.cellKey(worst.fitness);
        if (!target.grid.has(key)) {
          target.add(worst);
          island.grid.delete(key);
          logger.debug({ from: i, to: targetIdx }, 'Migrated candidate');
        }
      }
    }
  }

  /** Get the next generation: elites from each island */
  getNextGeneration(): ArchivedBot[] {
    const generation: ArchivedBot[] = [];
    for (const island of this.islands) {
      const elite = island.getElite();
      if (elite) generation.push(elite);
    }
    return generation;
  }

  /** Get the full archive (all elites across islands) */
  getArchive(): ArchivedBot[] {
    const archive: ArchivedBot[] = [];
    for (const island of this.islands) {
      for (const cell of Array.from(island.grid.values())) {
        archive.push(cell.bot);
      }
    }
    return archive;
  }

  /** Population summary stats */
  summary(): { totalIslands: number; totalElites: number; gridSize: number } {
    let totalGridSize = 0;
    for (const island of this.islands) {
      totalGridSize += island.grid.size;
    }
    return {
      totalIslands: this.islands.length,
      totalElites: totalGridSize,
      gridSize: totalGridSize,
    };
  }
}
