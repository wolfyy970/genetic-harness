/**
 * @module replay/elite-replays
 *
 * After each generation `runEvolution` calls `recordEliteReplays` to
 * (re-)play the top-N elites against each non-null reference opponent
 * with a `JsonReplayRecorder` attached. Each match becomes one JSON file
 * under `archiveDir/generations/gen-NNNN/`. The function returns a
 * `ReplayManifestEntry` describing what got written.
 *
 * Re-running matches (rather than recording during evaluation) keeps the
 * eval cascade unchanged and bounds storage to `replayCount * 3` files
 * per generation. The tradeoff is a few hundred ms of extra compute per
 * generation, paid only when `recordReplays: true`.
 */

import type {
  ArchivedBot,
  ArenaPlugin,
  GameConfig,
  HarnessConfig,
} from '../shared/types.js';
import { IsolatePool, type CompiledBot } from '../runtime/isolate.js';
import { bundle, BUNDLE_ERROR_PREFIX } from '../runtime/bundler.js';
import { playMatch } from '../orchestrator/match.js';
import { REFERENCE_ROSTER } from '../orchestrator/reference.js';
import { JsonReplayRecorder } from './recorder.js';
import { writeReplay } from './store.js';
import type { ReplayManifestEntry, ReplayParticipant } from './types.js';
import { logger } from '../shared/logger.js';

/** Per-tick CPU timeout used for replay matches; matches the evaluator's value. */
const TICK_CPU_BUDGET_MS = 50;
const REPLAY_MATCH_TICKS = 400;
const REPLAY_SEED = 9001;

interface RecordOpts {
  arena: ArenaPlugin;
  arenaName: string;
  pool: IsolatePool;
  referenceRoster: Map<string, CompiledBot>;
  elites: ArchivedBot[];
  generation: number;
  archiveDir: string;
  config: HarnessConfig;
}

/**
 * Build a deterministic GameConfig for replay matches. We keep this stable
 * across generations so the user sees apples-to-apples evolution, not
 * different starting conditions per generation.
 */
function makeReplayConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    worldWidth: 800,
    worldHeight: 600,
    seed: REPLAY_SEED,
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
 * Record top-N elites against each non-null reference opponent. Returns
 * the manifest entry for this generation. Writes happen synchronously;
 * any per-match failure is logged and skipped (other matches still go).
 */
export function recordEliteReplays(opts: RecordOpts): ReplayManifestEntry {
  const replayConfig = makeReplayConfig(opts.config.arenaConfig);
  const opponents = REFERENCE_ROSTER.filter((r) => r.id !== 'ref-null');
  const replays: ReplayManifestEntry['replays'] = [];

  let bestFitness = -Infinity;
  let bestShipId = '';
  for (const elite of opts.elites) {
    if (elite.fitness.fitnessScore > bestFitness) {
      bestFitness = elite.fitness.fitnessScore;
      bestShipId = elite.shipId;
    }
  }

  for (const elite of opts.elites) {
    const bundled = bundle(elite.source);
    if (bundled.startsWith(BUNDLE_ERROR_PREFIX)) {
      logger.warn(
        { eliteId: elite.id, error: bundled.slice(0, 200) },
        'Elite source failed to compile for replay',
      );
      continue;
    }
    let candidate: CompiledBot;
    try {
      candidate = opts.pool.compileBot(bundled);
    } catch (err) {
      logger.warn({ eliteId: elite.id, err }, 'Elite isolate boot failed for replay');
      continue;
    }

    try {
      for (const opp of opponents) {
        const compiledOpp = opts.referenceRoster.get(opp.id);
        if (!compiledOpp) continue;

        const matchId = `gen${String(opts.generation).padStart(4, '0')}-${elite.shipId}-vs-${opp.id}`;
        const participants: ReplayParticipant[] = [
          { shipId: 'ship-0', role: 'candidate', refId: elite.shipId },
          { shipId: 'ship-1', role: 'reference', refId: opp.id },
        ];
        const recorder = new JsonReplayRecorder({
          arena: opts.arena,
          arenaName: opts.arenaName,
          generation: opts.generation,
          matchId,
          participants,
          config: replayConfig,
          maxFrames: opts.config.replayMaxFrames,
          sampleEvery: opts.config.replaySampleEvery,
        });

        const shipBots = new Map<string, CompiledBot>([
          ['ship-0', candidate],
          ['ship-1', compiledOpp],
        ]);

        try {
          const report = playMatch(
            opts.arena,
            opts.pool,
            shipBots,
            replayConfig,
            REPLAY_MATCH_TICKS,
            TICK_CPU_BUDGET_MS,
            recorder,
          );
          const file = recorder.finalize(report);
          const relPath = writeReplay(opts.archiveDir, file);
          replays.push({
            path: relPath,
            shipId: elite.shipId,
            opponent: opp.id,
            fitness: elite.fitness.fitnessScore,
            durationTicks: report.durationTicks,
          });
        } catch (err) {
          logger.warn(
            { eliteId: elite.id, opponent: opp.id, err },
            'Replay match failed; continuing',
          );
        }
      }
    } finally {
      opts.pool.destroy(candidate);
    }
  }

  return {
    generation: opts.generation,
    bestFitness: bestFitness === -Infinity ? 0 : bestFitness,
    bestShipId,
    replays,
  };
}

/** Strip secrets from HarnessConfig before persisting. */
export function sanitizeConfig(config: HarnessConfig): Omit<HarnessConfig, 'llmApiKey'> {
  const { llmApiKey: _omit, ...rest } = config;
  return rest;
}
