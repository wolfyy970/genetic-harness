/**
 * @module replay/types
 *
 * On-disk replay schema. Files at v1 are plain JSON; the `schema` field
 * lets us evolve the format without breaking existing archives.
 */

import type {
  ArchivedBot,
  GameConfig,
  HarnessConfig,
  ReplayFrame,
} from '../shared/types.js';
import type { GridCellSnapshot } from '../orchestrator/population.js';
import type { ShipReport } from '../orchestrator/match.js';

/** Schema version for individual replay files. Bump when shape changes. */
export const REPLAY_SCHEMA = 1;

/** Schema version for `manifest.json`. */
export const MANIFEST_SCHEMA = 1;

export interface ReplayParticipant {
  shipId: string;
  role: 'candidate' | 'reference';
  /** Reference-bot id (e.g. 'ref-aggressive') or evolved candidate id. */
  refId?: string;
}

/**
 * One persisted match. Lives at
 * `<archiveDir>/generations/gen-<NNNN>/<matchId>.json`.
 *
 * `frames` may be sampled (every N ticks) and capped (max-frames). Both
 * are recorded so a viewer can reconstruct the playback rate honestly.
 */
export interface ReplayFile {
  schema: typeof REPLAY_SCHEMA;
  arena: string;
  generation: number;
  matchId: string;
  participants: ReplayParticipant[];
  config: GameConfig;
  durationTicks: number;
  endedByElimination: boolean;
  /** ShipReport with bigints stringified for JSON. */
  shipReports: Array<Omit<ShipReport, 'cpuNanosTotal' | 'cpuNanosMax'> & {
    cpuNanosTotal: string;
    cpuNanosMax: string;
  }>;
  frames: ReplayFrame[];
  sampleEvery: number;
  /** ISO 8601. */
  createdAt: string;
}

export interface ReplayManifestEntry {
  generation: number;
  bestFitness: number;
  bestShipId: string;
  /**
   * Replay files written for this generation, relative to `archiveDir`,
   * e.g. `generations/gen-0001/match-cand-1-vs-ref-aggressive-seed101.json`.
   */
  replays: Array<{
    path: string;
    shipId: string;
    opponent: string;
    fitness: number;
    durationTicks: number;
  }>;
}

/** Per-generation rollup for charts (line + scatter). */
export interface GenerationStats {
  generation: number;
  bestFitness: number;
  bestWinRate: number;
  meanFitness: number;
  /** Mean ns / tick across all elites in the population. */
  meanFuel: number;
  /** Population size at the end of this generation. */
  archiveSize: number;
}

/**
 * Top-level run metadata. Lives at `<archiveDir>/manifest.json` and is
 * the first thing the dashboard fetches — it owns the index of replays
 * + per-generation stats + the MAP-Elites grid snapshot.
 */
export interface ReplayManifest {
  schema: typeof MANIFEST_SCHEMA;
  /** Stable identifier for this evolutionary run (timestamp-based by default). */
  runId: string;
  arena: string;
  /** Sanitized config (no API keys). */
  config: Omit<HarnessConfig, 'llmApiKey'>;
  generations: ReplayManifestEntry[];
  /** Mirror of leaderboard.json so a single fetch warms the dashboard. */
  leaderboard: ArchivedBot[];
  /** MAP-Elites grid as of `updatedAt`. Empty until first generation finishes. */
  mapElitesGrid: GridCellSnapshot[];
  /** Per-generation stats for line/scatter charts; one entry per generation. */
  generationStats: GenerationStats[];
  updatedAt: string;
}
