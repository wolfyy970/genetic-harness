/**
 * @module replay/elite-replays
 *
 * After each generation `runEvolution` calls `recordEliteReplays` to
 * (re-)play the top-N elites in the same 8-ship free-for-all topology the
 * evaluator uses. Each match becomes one JSON file under
 * `archiveDir/generations/gen-NNNN/`. The function returns a
 * `ReplayManifestEntry` describing what got written.
 *
 * Two topologies are recorded:
 *   • FFA      — candidate + 7 non-Null reference roster opponents.
 *                One match per seed (default 3 seeds).
 *   • self-play — candidate + top-K population elites + roster fill to 8.
 *                One match per elite (only when a non-empty `selfPlayPool`
 *                is supplied).
 *
 * Re-running matches (rather than recording during evaluation) keeps the
 * eval cascade unchanged and bounds storage to a small known set per
 * generation.
 */

import type {
  ArchivedBot,
  ArenaPlugin,
  GameConfig,
  HarnessConfig,
} from '../shared/types.js';
import { IsolatePool, type CompiledBot } from '../runtime/isolate.js';
import { bundle, BUNDLE_ERROR_PREFIX } from '../runtime/bundler.js';
import { playMatch, type ShipReport } from '../orchestrator/match.js';
// REFERENCE_ROSTER no longer imported — opponents come from the live population.
import { outcomeForNWay, FFA_MATCH_SIZE } from '../orchestrator/evaluator.js';
import { JsonReplayRecorder } from './recorder.js';
import { writeReplay } from './store.js';
import type {
  ReplayManifestEntry,
  ReplayParticipant,
  ReplayTopology,
  ReplayRank,
} from './types.js';
import { logger } from '../shared/logger.js';

/** Per-tick CPU timeout used for replay matches; matches the evaluator's value. */
const TICK_CPU_BUDGET_MS = 50;
/**
 * Per-match cap for *recorded* matches (in ticks). Matches the evaluator's
 * `DEFAULT_MATCH_TICKS` so what the user sees mirrors what bots evolved
 * against. Early exit via `aliveCount <= 1` typically lands well below
 * this cap.
 */
const REPLAY_MATCH_TICKS = 2000;
/** Three deterministic seeds — same shape the evaluator uses. */
const REPLAY_SEEDS = [9001, 9018, 9035];

interface RecordOpts {
  arena: ArenaPlugin;
  arenaName: string;
  pool: IsolatePool;
  /**
   * Compiled FFA opponents for the recorded matches. Caller is responsible
   * for compiling these from the population each generation; replay
   * recording does not own their lifecycle.
   */
  opponentPool: CompiledBot[];
  /** Archive ids of the opponents (parallel to `opponentPool`), for participant labelling. */
  opponentIds: string[];
  elites: ArchivedBot[];
  generation: number;
  archiveDir: string;
  config: HarnessConfig;
  /**
   * Top-K archived elites in the population at the moment this generation
   * snapshotted — drives self-play recording. Empty / undefined means
   * "skip self-play recording this generation."
   */
  selfPlayPool?: ArchivedBot[];
}

/**
 * Build a deterministic 8-ship GameConfig for replay matches. Same
 * defaults as the evaluator so what the user sees matches what the bot
 * actually evolved against.
 */
function makeReplayConfig(
  seed: number,
  shipCount: number,
  overrides: Partial<GameConfig> = {},
): GameConfig {
  // Mirrors `makeMatchConfig` in the evaluator so recorded matches match
  // the world the bot actually evolved in (12× area, 24 asteroids).
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

/** Compute per-ship ranks from a finished match report. */
function computeRanks(
  reports: ShipReport[],
  participants: ReplayParticipant[],
): ReplayRank[] {
  const sortedDesc = [...reports].sort((a, b) => b.score - a.score);
  const refIdByShip = new Map(participants.map((p) => [p.shipId, p.refId ?? p.shipId]));
  return reports.map((r) => ({
    shipId: r.shipId,
    refId: refIdByShip.get(r.shipId) ?? r.shipId,
    score: r.score,
    rank: sortedDesc.findIndex((s) => s.shipId === r.shipId) + 1,
    survived: r.survived,
  }));
}

/**
 * Record a single match (FFA or self-play) and return a manifest replay
 * entry, or `null` on any error along the way (compile, isolate boot, or
 * runtime exception).
 */
function recordOneMatch(opts: {
  arena: ArenaPlugin;
  arenaName: string;
  pool: IsolatePool;
  candidate: CompiledBot;
  candidateShipId: string;
  candidateRefId: string;
  opponents: Array<{ shipId: string; bot: CompiledBot; refId: string; role: ReplayParticipant['role'] }>;
  generation: number;
  archiveDir: string;
  config: HarnessConfig;
  seed: number;
  topology: ReplayTopology;
  matchIdSuffix: string;
}): ReplayManifestEntry['replays'][number] | null {
  const participants: ReplayParticipant[] = [
    { shipId: 'ship-0', role: 'candidate', refId: opts.candidateRefId },
    ...opts.opponents.map((o) => ({
      shipId: o.shipId,
      role: o.role,
      refId: o.refId,
    })),
  ];

  const shipCount = participants.length;
  const replayConfig = makeReplayConfig(
    opts.seed,
    shipCount,
    opts.config.arenaConfig,
  );

  const matchId = `gen${String(opts.generation).padStart(4, '0')}-${opts.candidateRefId}-${opts.matchIdSuffix}`;
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

  const shipBots = new Map<string, CompiledBot>();
  shipBots.set('ship-0', opts.candidate);
  for (const o of opts.opponents) shipBots.set(o.shipId, o.bot);

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

    const ranks = computeRanks(report.ships, participants);
    const candidateReport = report.ships.find((r) => r.shipId === 'ship-0');
    const otherReports = report.ships.filter((r) => r.shipId !== 'ship-0');
    const outcome = outcomeForNWay(candidateReport, report.ships);
    // For backward compat: `opponent` field gets a topology-aware label.
    const opponent =
      opts.topology === '1v1'
        ? opts.opponents[0]?.refId ?? 'unknown'
        : opts.topology === 'ffa'
          ? `ffa-7 (outcome ${outcome})`
          : `selfplay-${otherReports.length} (outcome ${outcome})`;

    return {
      path: relPath,
      shipId: opts.candidateRefId,
      opponent,
      fitness: opts.config.mode === 'capped' ? 0 : 0, // legacy; manifest carries real fitness via leaderboard
      durationTicks: report.durationTicks,
      seed: opts.seed,
      topology: opts.topology,
      ranks,
    };
  } catch (err) {
    logger.warn(
      { matchId, topology: opts.topology, err },
      'Replay match failed; continuing',
    );
    return null;
  }
}

/**
 * Record top-N elites in FFA and (optionally) self-play. Returns the
 * manifest entry for this generation. Writes happen synchronously; any
 * per-match failure is logged and skipped (other matches still go).
 */
export function recordEliteReplays(opts: RecordOpts): ReplayManifestEntry {
  const replays: ReplayManifestEntry['replays'] = [];

  // FFA opponents come from the live population (compiled by the caller).
  // Roles default to 'archived-elite' since they're all evolving population
  // members now — there's no hand-coded "reference" tier anymore.
  const ffaOpponents: Array<{ shipId: string; bot: CompiledBot; refId: string; role: ReplayParticipant['role'] }> = [];
  for (let i = 0; i < opts.opponentPool.length && i < FFA_MATCH_SIZE - 1; i++) {
    ffaOpponents.push({
      shipId: `ship-${i + 1}`,
      bot: opts.opponentPool[i],
      refId: opts.opponentIds[i] ?? `opp-${i}`,
      role: 'archived-elite',
    });
  }

  let bestFitness = -Infinity;
  let bestShipId = '';
  for (const elite of opts.elites) {
    if (elite.fitness.fitnessScore > bestFitness) {
      bestFitness = elite.fitness.fitnessScore;
      bestShipId = elite.shipId;
    }
  }

  // Compile every elite's source once, reuse across FFA seeds + self-play.
  const eliteCompiled = new Map<string, CompiledBot>();
  const elitesToDestroy: CompiledBot[] = [];
  for (const elite of opts.elites) {
    const bundled = bundle(elite.source);
    if (bundled.startsWith(BUNDLE_ERROR_PREFIX)) {
      logger.warn(
        { eliteId: elite.id, error: bundled.slice(0, 200) },
        'Elite source failed to compile for replay',
      );
      continue;
    }
    try {
      const compiled = opts.pool.compileBot(bundled);
      eliteCompiled.set(elite.shipId, compiled);
      elitesToDestroy.push(compiled);
    } catch (err) {
      logger.warn({ eliteId: elite.id, err }, 'Elite isolate boot failed for replay');
    }
  }

  // Self-play opponent compilation (separate from FFA reference roster).
  // Only compile what we'll actually use.
  const selfPlayPool = opts.selfPlayPool ?? [];
  const selfPlayCompiled = new Map<string, CompiledBot>();
  const selfPlayToDestroy: CompiledBot[] = [];
  if (selfPlayPool.length > 0) {
    for (const peer of selfPlayPool) {
      if (eliteCompiled.has(peer.shipId)) continue; // already compiled as an elite
      const bundled = bundle(peer.source);
      if (bundled.startsWith(BUNDLE_ERROR_PREFIX)) continue;
      try {
        const compiled = opts.pool.compileBot(bundled);
        selfPlayCompiled.set(peer.shipId, compiled);
        selfPlayToDestroy.push(compiled);
      } catch {
        /* drop silently */
      }
    }
  }

  try {
    for (const elite of opts.elites) {
      const candidate = eliteCompiled.get(elite.shipId);
      if (!candidate) continue;

      // FFA matches: one per seed.
      for (const seed of REPLAY_SEEDS) {
        const entry = recordOneMatch({
          arena: opts.arena,
          arenaName: opts.arenaName,
          pool: opts.pool,
          candidate,
          candidateShipId: 'ship-0',
          candidateRefId: elite.shipId,
          opponents: ffaOpponents,
          generation: opts.generation,
          archiveDir: opts.archiveDir,
          config: opts.config,
          seed,
          topology: 'ffa',
          matchIdSuffix: `ffa-seed${seed}`,
        });
        if (entry) {
          entry.fitness = elite.fitness.fitnessScore;
          replays.push(entry);
        }
      }

      // Self-play match: candidate + top-K archived elites + roster fill to 8.
      if (selfPlayPool.length > 0) {
        const peers = selfPlayPool
          .filter((p) => p.shipId !== elite.shipId)
          .slice(0, FFA_MATCH_SIZE - 1);
        const selfPlayOpponents: typeof ffaOpponents = [];
        let slot = 1;
        for (const peer of peers) {
          const bot = eliteCompiled.get(peer.shipId) ?? selfPlayCompiled.get(peer.shipId);
          if (!bot) continue;
          selfPlayOpponents.push({
            shipId: `ship-${slot++}`,
            bot,
            refId: peer.shipId,
            role: 'archived-elite',
          });
        }
        // Pad with roster picks (deterministic order) to reach 7 opponents.
        for (const r of ffaOpponents) {
          if (selfPlayOpponents.length >= FFA_MATCH_SIZE - 1) break;
          selfPlayOpponents.push({
            ...r,
            shipId: `ship-${slot++}`,
          });
        }
        if (selfPlayOpponents.length > 0) {
          const entry = recordOneMatch({
            arena: opts.arena,
            arenaName: opts.arenaName,
            pool: opts.pool,
            candidate,
            candidateShipId: 'ship-0',
            candidateRefId: elite.shipId,
            opponents: selfPlayOpponents,
            generation: opts.generation,
            archiveDir: opts.archiveDir,
            config: opts.config,
            seed: 9100 + opts.generation,
            topology: 'selfplay',
            matchIdSuffix: 'selfplay',
          });
          if (entry) {
            entry.fitness = elite.fitness.fitnessScore;
            replays.push(entry);
          }
        }
      }
    }
  } finally {
    // Dispose only the bots we compiled here. Shared reference roster
    // bots in opts.pool are owned by the caller.
    for (const c of elitesToDestroy) opts.pool.destroy(c);
    for (const c of selfPlayToDestroy) opts.pool.destroy(c);
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
