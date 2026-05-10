/**
 * @module replay/recorder
 *
 * MatchRecorder is the participation contract `playMatch` knows about.
 * It receives one `onTick(state)` per arena tick. The recorder owns
 * sampling, frame-cap, and the build-the-final-ReplayFile logic, so
 * playMatch stays oblivious to replay storage.
 *
 * A null/missing recorder means "don't record" — playMatch's hot path
 * pays only an `if (recorder)` branch.
 */

import type {
  ArenaPlugin,
  GameConfig,
  GameState,
  ReplayFrame,
} from '../shared/types.js';
import type { MatchReport } from '../orchestrator/match.js';
import type {
  ReplayFile,
  ReplayParticipant,
} from './types.js';
import { REPLAY_SCHEMA } from './types.js';

/** Minimal contract `playMatch` sees. */
export interface MatchRecorder {
  onTick(state: GameState): void;
}

export interface JsonRecorderOptions {
  arena: ArenaPlugin;
  arenaName: string;
  generation: number;
  matchId: string;
  participants: ReplayParticipant[];
  config: GameConfig;
  /** Sample every Nth tick (default 1 = every tick). */
  sampleEvery?: number;
  /** Cap on frames stored (default 1500). */
  maxFrames?: number;
}

/**
 * Recorder that buffers `ReplayFrame[]` in memory and produces a
 * fully-populated `ReplayFile` from a `MatchReport` at finalize time.
 *
 * Storage cost is bounded by `maxFrames * (entities * ~80 bytes)`. With
 * defaults that's ~1.2 MB per match.
 */
export class JsonReplayRecorder implements MatchRecorder {
  private readonly arena: ArenaPlugin;
  private readonly arenaName: string;
  private readonly generation: number;
  private readonly matchId: string;
  private readonly participants: ReplayParticipant[];
  private readonly config: GameConfig;
  private readonly sampleEvery: number;
  private readonly maxFrames: number;
  private readonly frames: ReplayFrame[] = [];
  private tickCounter = 0;

  constructor(opts: JsonRecorderOptions) {
    this.arena = opts.arena;
    this.arenaName = opts.arenaName;
    this.generation = opts.generation;
    this.matchId = opts.matchId;
    this.participants = opts.participants;
    this.config = opts.config;
    this.sampleEvery = Math.max(1, opts.sampleEvery ?? 1);
    this.maxFrames = Math.max(1, opts.maxFrames ?? 1500);
  }

  onTick(state: GameState): void {
    this.tickCounter += 1;
    if (this.tickCounter % this.sampleEvery !== 0) return;
    if (this.frames.length >= this.maxFrames) return;
    this.frames.push(this.arena.renderer(state));
  }

  /**
   * Build the persistable `ReplayFile` from the in-memory frames + the
   * caller-supplied match report. Stringifies bigints for JSON.
   */
  finalize(report: MatchReport): ReplayFile {
    return {
      schema: REPLAY_SCHEMA,
      arena: this.arenaName,
      generation: this.generation,
      matchId: this.matchId,
      participants: this.participants,
      config: this.config,
      durationTicks: report.durationTicks,
      endedByElimination: report.endedByElimination,
      shipReports: report.ships.map((s) => ({
        shipId: s.shipId,
        score: s.score,
        ticksAlive: s.ticksAlive,
        histogram: s.histogram,
        survived: s.survived,
        cpuNanosTotal: s.cpuNanosTotal.toString(),
        cpuNanosMax: s.cpuNanosMax.toString(),
      })),
      frames: this.frames,
      sampleEvery: this.sampleEvery,
      createdAt: new Date().toISOString(),
    };
  }

  /** How many frames have been buffered so far. Useful for tests. */
  frameCount(): number {
    return this.frames.length;
  }
}
