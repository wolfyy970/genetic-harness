/**
 * @module match
 *
 * Run one match between compiled bots inside an isolate pool.
 *
 * Each ship in the world is bound to one CompiledBot (or to a no-op default
 * if no binding is supplied). On every tick we build the per-ship BotState,
 * call the bot through the IsolatePool, and feed the resulting action map
 * back into the arena's tick. We track:
 *   - per-ship score, ticks-alive, CPU nanos consumed
 *   - per-ship action histogram (used to compute aggression / opening style)
 *
 * The function is synchronous despite operating on the IsolatePool: the
 * pool's runTick uses ivm.applySync, so per-tick latency is bounded by the
 * `cpuBudgetMs` timeout the caller passes in.
 */

import type {
  ArenaPlugin,
  BotAction,
  GameConfig,
  GameState,
} from '../shared/types.js';
import { buildBotState } from '../engine/world.js';
import type { CompiledBot, IsolatePool } from '../runtime/isolate.js';
import type { MatchRecorder } from '../replay/recorder.js';

/** Counts of each action type emitted by a single ship over a match. */
export interface ActionHistogram {
  thrust: number;
  rotate: number;
  fire: number;
  wait: number;
  /** Times the bot crashed, timed out, or returned a malformed action. */
  invalid: number;
}

/** Per-ship telemetry collected over the duration of a match. */
export interface ShipReport {
  shipId: string;
  score: number;
  ticksAlive: number;
  cpuNanosTotal: bigint;
  cpuNanosMax: bigint;
  histogram: ActionHistogram;
  /** True when the ship was alive at match end. */
  survived: boolean;
}

/** Result of running one match. */
export interface MatchReport {
  ships: ShipReport[];
  /** Tick number the match terminated on. */
  durationTicks: number;
  /** True when the match ended because <=1 ship was alive. */
  endedByElimination: boolean;
}

/** Action returned when a bot is missing or crashed. */
const FALLBACK_ACTION: BotAction = { type: 'wait' };

const ACTION_TYPES: ReadonlyArray<BotAction['type']> = [
  'thrust',
  'rotate',
  'fire',
  'wait',
];

function isValidAction(a: unknown): a is BotAction {
  if (!a || typeof a !== 'object') return false;
  const t = (a as { type?: unknown }).type;
  return typeof t === 'string' && (ACTION_TYPES as readonly string[]).includes(t);
}

function emptyHistogram(): ActionHistogram {
  return { thrust: 0, rotate: 0, fire: 0, wait: 0, invalid: 0 };
}

function recordAction(h: ActionHistogram, action: BotAction | null): void {
  if (action === null || !isValidAction(action)) {
    h.invalid += 1;
    return;
  }
  h[action.type] += 1;
}

/**
 * Play one match.
 *
 * @param arena       The arena plugin (e.g. Asteroids).
 * @param pool        The isolate pool that owns every CompiledBot.
 * @param shipBots    Map from ship id to its CompiledBot. Ships without a
 *                    binding emit FALLBACK_ACTION.
 * @param config      Concrete GameConfig the arena should init with.
 * @param maxTicks    Hard cap on match duration.
 * @param cpuBudgetMs Per-tick CPU timeout for each bot's runTick call.
 * @param recorder    Optional. Receives `onTick(state)` after each
 *                    `arena.tick`. Hot-path cost is one branch per tick
 *                    when absent.
 */
export function playMatch(
  arena: ArenaPlugin,
  pool: IsolatePool,
  shipBots: Map<string, CompiledBot>,
  config: GameConfig,
  maxTicks: number,
  cpuBudgetMs: number,
  recorder?: MatchRecorder,
): MatchReport {
  let state: GameState = arena.init(config);

  const reports = new Map<string, ShipReport>();
  for (const ship of state.ships) {
    reports.set(ship.id, {
      shipId: ship.id,
      score: ship.score,
      ticksAlive: 0,
      cpuNanosTotal: 0n,
      cpuNanosMax: 0n,
      histogram: emptyHistogram(),
      survived: false,
    });
  }

  // Hoisted scratch buffers to avoid per-tick allocation.
  const actions = new Map<string, BotAction>();
  let aliveCount = 0;

  let endedByElimination = false;
  let tick = 0;
  for (; tick < maxTicks; tick++) {
    actions.clear();
    aliveCount = 0;
    for (const sh of state.ships) {
      if (sh.health > 0) aliveCount += 1;
    }
    if (aliveCount <= 1) {
      endedByElimination = true;
      break;
    }

    for (const ship of state.ships) {
      if (ship.health <= 0) continue;
      const report = reports.get(ship.id);
      if (report) report.ticksAlive += 1;

      const bot = shipBots.get(ship.id);
      const botState = bot ? buildBotState(state, ship.id) : null;
      if (!bot || !botState) {
        actions.set(ship.id, FALLBACK_ACTION);
        if (report) recordAction(report.histogram, FALLBACK_ACTION);
        continue;
      }

      const tickResult = pool.runTick(bot, botState, cpuBudgetMs, tick);
      const validated = isValidAction(tickResult.action) ? tickResult.action : null;
      actions.set(ship.id, validated ?? FALLBACK_ACTION);

      if (report) {
        recordAction(report.histogram, validated);
        report.cpuNanosTotal += tickResult.cpuNanos;
        if (tickResult.cpuNanos > report.cpuNanosMax) {
          report.cpuNanosMax = tickResult.cpuNanos;
        }
      }
    }

    state = arena.tick(state, actions);
    if (recorder) recorder.onTick(state);
  }

  // Final scoring + survival snapshot.
  for (const ship of state.ships) {
    const r = reports.get(ship.id);
    if (!r) continue;
    r.score = ship.score;
    r.survived = ship.health > 0;
  }

  return {
    ships: Array.from(reports.values()),
    durationTicks: tick,
    endedByElimination,
  };
}

/**
 * Compute aggression: fire actions / total valid actions.
 *
 * Returns 0 when the bot took no valid actions (so missing data doesn't
 * inflate the score).
 */
export function aggressionScore(h: ActionHistogram): number {
  const total = h.thrust + h.rotate + h.fire + h.wait;
  if (total === 0) return 0;
  return h.fire / total;
}

/**
 * Compute economy score: thrust+wait fraction. High values indicate a bot
 * that conserves bullets and either positions or stalls.
 */
export function economyScore(h: ActionHistogram): number {
  const total = h.thrust + h.rotate + h.fire + h.wait;
  if (total === 0) return 0;
  return (h.thrust + h.wait) / total;
}
