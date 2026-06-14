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

/**
 * Schema version for individual replay files. Bump when shape changes.
 *
 * History:
 *   1 — initial circular asteroids; ship/bullet/asteroid entities
 *   2 — asteroids gain `vertices` + `rotation` for jagged polygonal rendering
 *   3 — asteroids gain `tier: 'LARGE'|'MEDIUM'|'SMALL'`; arcade-style sizes
 *   4 — 8-ship FFA topology: `participants` carries 8 entries, `shipReports`
 *       has 8 entries, new `archived-elite` participant role for self-play
 */
export const REPLAY_SCHEMA = 4;

/** Schema version for `manifest.json`. */
export const MANIFEST_SCHEMA = 1;

export interface ReplayParticipant {
  shipId: string;
  /**
   * `candidate` — the bot being evaluated (always ship-0).
   * `reference` — a scripted bot from the frozen reference roster.
   * `archived-elite` — another evolved bot from the population (self-play).
   */
  role: 'candidate' | 'reference' | 'archived-elite';
  /** Reference-bot id (e.g. 'ref-aggressive') or evolved candidate id. */
  refId?: string;
}

/** Topology of a recorded match — drives dashboard filtering + labelling. */
export type ReplayTopology = 'ffa' | 'selfplay' | '1v1';

/**
 * Per-ship outcome summary for a replay match. Lets the dashboard render
 * rank + survival in the dropdown without re-fetching the replay JSON.
 */
export interface ReplayRank {
  shipId: string;
  refId: string;
  score: number;
  rank: number;
  survived: boolean;
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
   * e.g. `generations/gen-0001/match-cand-1-ffa-seed101.json`.
   *
   * `seed` + `topology` + `ranks` (schema 4) are optional so older
   * manifests still parse; new code falls back gracefully.
   */
  replays: Array<{
    path: string;
    shipId: string;
    /**
     * Pre-schema-4: opponent shipId (1v1). Post-schema-4: kept for
     * backward-compat — the dashboard prefers `ranks[]` when present.
     */
    opponent: string;
    fitness: number;
    durationTicks: number;
    /** Match seed (deterministic) — schema 4+. */
    seed?: number;
    /** Topology of the match — schema 4+. */
    topology?: ReplayTopology;
    /** Per-ship rank + survival summary — schema 4+. */
    ranks?: ReplayRank[];
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
