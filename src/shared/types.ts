/**
 * Core type definitions for the genetic harness.
 *
 * These define the contract between the arena, runtime, and orchestrator.
 * All inter-module communication flows through these types.
 *
 * @module types
 */

// =============================================================================
// Arena Entity Types
// =============================================================================

/** A 2D position/velocity vector with x and y coordinates */
export interface Vector2D {
  x: number;
  y: number;
}

/**
 * State of a ship in the arena.
 *
 * Tracks position, velocity, orientation, fuel, shields, health, and score.
 * Mutated in-place during game ticks.
 */
export interface ShipState {
  id: string;
  type: 'ship';
  pos: Vector2D;
  vel: Vector2D;
  angle: number;          // radians, 0 = pointing right
  angularVel: number;     // radians per tick
  thrust: boolean;
  thrustAngle: number;    // radians, local to ship angle
  fuel: number;           // remaining fuel
  shields: number;        // current shield strength
  health: number;         // current hull health (0 = destroyed)
  score: number;
}

/**
 * An asteroid entity in the arena.
 *
 * Has mass-based physics, health, and splits into fragments when destroyed.
 */
export interface Asteroid {
  id: string;
  type: 'asteroid';
  pos: Vector2D;
  vel: Vector2D;
  radius: number;
  health: number;
  mass: number;
}

/**
 * A bullet entity fired by a ship.
 *
 * Has a limited lifetime (maxAge ticks), owner tracking, and damage value.
 */
export interface Bullet {
  id: string;
  type: 'bullet';
  pos: Vector2D;
  vel: Vector2D;
  damage: number;
  owner: string;           // ship ID
  age: number;             // ticks alive
  maxAge: number;          // ticks before disappearing
}

/** A union of all entity types in the arena */
export type Entity = ShipState | Asteroid | Bullet;

// =============================================================================
// Collision Events
// =============================================================================

/** All possible collision event types in the arena */
export type CollisionEventType =
  | 'asteroid_ship'
  | 'asteroid_asteroid'
  | 'bullet_ship'
  | 'bullet_asteroid'
  | 'asteroid_destroyed'
  | 'ship_destroyed';

/**
 * A collision event between two arena entities.
 *
 * The `type` field identifies the collision category, and optional
 * fields indicate which entities were involved.
 */
export interface CollisionEvent {
  type: CollisionEventType;
  /** Present when asteroid and ship collide */
  asteroid?: Asteroid;
  /** Present when asteroid and ship collide */
  ship?: ShipState;
  /** Present when asteroid-asteroid collision */
  asteroidA?: Asteroid;
  /** Present when asteroid-asteroid collision */
  asteroidB?: Asteroid;
  /** Present when bullet hits something */
  bullet?: Bullet;
  /** Relative speed at collision */
  velocity?: number;
}

// =============================================================================
// Game State
// =============================================================================

/**
 * Configuration parameters for a game instance.
 *
 * Controls world dimensions, seed, asteroid count, physics parameters,
 * and bullet behavior.
 */
export interface GameConfig {
  worldWidth: number;
  worldHeight: number;
  seed: number;
  asteroidCount: number;
  tickMs: number;           // target tick duration in ms
  maxBulletsPerShip: number;
  bulletSpeed: number;
  shipThrust: number;
  shipRotationSpeed: number;
  shipMaxFuel: number;
  asteroidBaseRadius: number;
  asteroidSpeed: number;
}

/**
 * The complete state of a game at a given tick.
 *
 * Contains all entities (ships, asteroids, bullets), world dimensions,
 * and the configuration used to initialize this game.
 */
export interface GameState {
  tick: number;
  worldWidth: number;
  worldHeight: number;
  seed: number;
  ships: ShipState[];
  asteroids: Asteroid[];
  bullets: Bullet[];
  config: GameConfig;
}

// =============================================================================
// Bot API - what the bot sees and can do
// =============================================================================

/**
 * The view of the game world exposed to a bot's tick function.
 *
 * Provides the bot's own ship state, nearby entities (within sensor range),
 * all asteroids (full world awareness), opponents, active bullets, score,
 * and current tick number.
 */
export interface BotState {
  ship: ShipState;
  nearbyEntities: Entity[];  // entities within sensor range
  asteroids: Asteroid[];     // all asteroids (full world awareness)
  opponents: ShipState[];    // other ships in the arena
  bullets: Bullet[];         // all active bullets
  score: number;
  tick: number;
}

/**
 * A bot action that controls a ship's behavior.
 *
 * Actions are mutually exclusive — a bot can only perform one action per tick.
 */
export type BotAction =
  | { type: 'thrust'; angle: number }
  | { type: 'rotate'; direction: -1 | 1 }
  | { type: 'fire' }
  | { type: 'wait' };

// =============================================================================
// Fitness & Evaluation
// =============================================================================

/**
 * Results of evaluating a bot through the fitness cascade.
 *
 * Tracks win rate, scores, fuel efficiency, survival time, CPU usage,
 * and a combined fitness score used for ranking.
 */
export interface FitnessResult {
  shipId: string;
  winRate: number;          // 0.0 - 1.0
  avgScore: number;
  avgFuelPerTick: number;   // isolated-vm cpuTime nanoseconds
  avgTicksAlive: number;
  totalMatches: number;
  totalTicksAlive: number;
  cpuTimeTotal: bigint;     // isolated-vm cpuTime
  memoryUsed: number;       // isolate memory
  crashes: number;          // count of evaluation failures
  fitnessScore: number;     // combined fitness for ranking
}

/**
 * Result of a single evaluation attempt for a candidate bot.
 *
 * Contains the bot's source, ship ID, evaluation stage, fitness result,
 * and optional error message if evaluation failed.
 */
export interface EvaluationResult {
  source: string;           // bot source code
  shipId: string;
  stage: number;            // 1=syntax, 2=quick, 3=full
  fitness: FitnessResult;
  error?: string;           // if eval failed
  timestamp: number;
}

// =============================================================================
// Arena Plugin Interface
// =============================================================================

export interface ArenaPlugin {
  /** Initialize a new game instance */
  init(config: GameConfig): GameState;

  /**
   * Advance the game by one tick.
   * The arena collects actions from all agents, applies them to the state,
   * then runs physics, collision, and scoring.
   * Returns the new state.
   */
  tick(state: GameState, agentActions: Map<string, BotAction>): GameState;

  /** Score a specific agent at the end of a match */
  score(state: GameState, agentId: string): number;

  /** Generate a replay frame for visualization */
  renderer(state: GameState): ReplayFrame;
}

export interface ReplayFrame {
  type: 'asteroids';
  entities: Array<{
    type: 'ship' | 'asteroid' | 'bullet';
    id: string;
    pos: Vector2D;
    angle?: number;
    radius?: number;
    health?: number;
    shield?: number;
  }>;
  tick: number;
}

/**
 * Data for a bot that has completed evaluation.
 *
 * Stores the bot's source code, ship ID, fitness results, evaluation stage,
 * timestamp, and metadata including generation, island, behavioral signature,
 * complexity estimate, and novelty score.
 */
export interface ArchivedBot {
  id: string;
  source: string;           // the actual bot source code
  shipId: string;
  fitness: FitnessResult;
  stage: number;
  timestamp: number;
  metadata: {
    generation: number;
    island: number;
    behavioralSignature: string[];  // win/loss/draw vs reference roster
    complexity: number;             // cyclomatic complexity estimate
    noveltyScore: number;           // embedding-based novelty
  };
}

/**
 * Context passed to the mutation prompt builder.
 *
 * Contains the best exemplar bots, evaluation history, reward reflection
 * data, mutation mode, optional fuel budget, and the λ weight for weighted mode.
 */
export interface MutationContext {
  bestK: ArchivedBot[];           // top-k exemplars for prompt
  evaluationHistory: string;      // failure traces from recent mutations
  rewardReflection: RewardReflection;
  mode: 'pure' | 'pareto' | 'capped' | 'weighted';
  fuelBudget?: number;            // for capped/weighted modes
  λ: number;                      // for weighted mode
}

/**
 * Reward reflection data summarizing the population's performance.
 *
 * Tracks win rate, scores, fuel efficiency, survival time, per-source
 * fuel breakdown, and top behavioral axes (aggression, economic, defensive).
 */
export interface RewardReflection {
  winRate: number;
  avgScore: number;
  avgFuelPerTick: number;
  avgTicksAlive: number;
  fuelBreakdownBySource: Array<{
    lines: string;     // e.g. "47-83"
    fuelUsed: number;
    description: string;
  }>;
  topBehavioralAxes: {
    aggression: number;
    economic: number;
    defensive: number;
  };
}

// =============================================================================
// Mutation Output (for the orchestrator)
// =============================================================================

/**
 * Output of an LLM mutation generation attempt.
 *
 * Contains the mutated source, improvement flag, reason string,
 * and the search/replace diff blocks applied.
 */
export interface MutationPlan {
  shipId: string;
  source: string;           // the mutated bot source
  isImprovement: boolean;
  reason: string;
  searchReplaceDiff: SearchReplaceBlock[];
}

/**
 * A single SEARCH/REPLACE block from an LLM mutation plan.
 *
 * Specifies the line range and text to find/replace in the bot source.
 */
export interface SearchReplaceBlock {
  startLine: number;
  endLine: number;
  oldText: string;
  newText: string;
}

// =============================================================================
// Population & Island State
// =============================================================================

/**
 * State for a single island in the MAP-Elites population.
 *
 * Tracks the island's ID, candidates, migration interval, last migration tick,
 * and behavioral axes for diversity analysis.
 */
export interface IslandState {
  islandId: number;
  candidates: ArchivedBot[];
  migrationInterval: number;  // ticks between migrations
  lastMigration: number;
  behaviorAxes: {
    complexity: number[];
    behavioralDiversity: number[];
  };
}

// =============================================================================
// Orchestrator Configuration
// =============================================================================

/**
 * Full configuration for the genetic harness.
 *
 * Controls population size, island count, evaluation stages, LLM settings,
 * fitness computation, arena selection, timeouts, and archive management.
 */
export interface HarnessConfig {
  // Population
  populationSize: number;
  islandCount: number;
  migrationInterval: number;

  // Evaluation
  quickGamesPerEval: number;
  fullTournamentGames: number;
  referenceOpponents: number;
  stages: EvaluationCascade;

  // LLM
  llmBaseUrl: string;
  llmModel: string;
  llmApiKey: string;
  mutationPrompt: string;
  ensembleModels: string[];  // cheap model for bulk, expensive for inspiration

  // Fitness
  mode: 'pure' | 'pareto' | 'capped' | 'weighted';
  fuelCeiling?: number;
  λ?: number;
  includeComputeFitness: boolean;

  // Arena
  arena: string;             // arena name to load
  arenaConfig: Partial<GameConfig>;

  // Timeout / Heartbeat
  tickTimeoutMs: number;
  maxIdleMs: number;         // heartbeat stall timeout
  evalTimeoutMs: number;

  // Archive
  archiveDir: string;
  leaderboardSize: number;
}

/**
 * Configuration for the evaluation cascade stages.
 *
 * Each stage has an enabled flag and parameters (steps or games).
 * Stages run in order: syntax check → quick rollout → quick games → full tournament.
 */
export interface EvaluationCascade {
  syntax: boolean;
  quickRollout: {
    enabled: boolean;
    steps: number;
  };
  quickGames: {
    enabled: boolean;
    games: number;
  };
  fullTournament: {
    enabled: boolean;
    games: number;
  };
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default configuration for the genetic harness.
 *
 * All fields have sensible defaults; override via `loadConfig()` at startup.
 */
export const DEFAULT_CONFIG: HarnessConfig = {
  populationSize: 100,
  islandCount: 2,
  migrationInterval: 50,
  quickGamesPerEval: 10,
  fullTournamentGames: 50,
  referenceOpponents: 3,
  stages: {
    syntax: true,
    quickRollout: { enabled: true, steps: 50 },
    quickGames: { enabled: true, games: 10 },
    fullTournament: { enabled: true, games: 50 },
  },
  llmBaseUrl: 'http://localhost:8000/v1',
  llmModel: 'Qwen3.6-35B-A3B-8bit',
  llmApiKey: 'omlx-local',
  mutationPrompt: '',
  ensembleModels: ['gpt-5.1-mini', 'claude-sonnet-4-20250514'],
  mode: 'pure',
  includeComputeFitness: true,
  arena: 'asteroids',
  arenaConfig: {},
  tickTimeoutMs: 500,
  maxIdleMs: 30_000,
  evalTimeoutMs: 60_000,
  archiveDir: './data/archive',
  leaderboardSize: 50,
};
