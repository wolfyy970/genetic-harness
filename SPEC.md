# Genetic Harness — Implementation Spec

## Context
- Node.js + TypeScript project at `/Users/kcwolff/Projects/genetic-harness/`
- LLM: Qwen3.6-35B-A3B-8bit via oMLX at `http://localhost:8000/v1`, API key `omlx-local`
- Purpose: Evolve AI game controllers (bots) in a multiplayer Asteroids arena using genetic algorithms
- Architecture: isolated-vm sandboxing, esbuild compilation, LLM-driven mutation, MAP-Elites + islands population

## Project Structure

```
src/
├── shared/
│   ├── types.ts        ✅ EXISTS — all type definitions
│   ├── logger.ts       ⚠️  EXISTS — has import issue (see Known Issues)
│   └── config.ts       ✅ EXISTS — config loading
├── engine/
│   ├── utils.ts        ✅ EXISTS — RNG, vector math, collision helpers
│   ├── actions.ts      ✅ EXISTS — bot action parsing/application
│   ├── world.ts        ✅ EXISTS — game state, physics, spawn
│   ├── collision.ts    ✅ EXISTS — collision detection/resolution
│   └── renderer.ts     ✅ EXISTS — replay frame generation
├── runtime/
│   ├── isolate.ts      ✅ EXISTS — isolated-vm pool, compile, tick
│   ├── deterministic.ts ✅ EXISTS — deterministic globals setup
│   └── bundler.ts      ✅ EXISTS — esbuild compilation
├── arena/
│   ├── interface.ts    ✅ EXISTS — plugin registry
│   └── asteroids.ts    ✅ EXISTS — multiplayer Asteroids arena
├── orchestrator/       🔨 NEEDS TO BE CREATED
│   ├── population.ts   — Island management, MAP-Elites grid, migration
│   ├── mutation.ts     — LLM prompt generation, diff application
│   ├── evaluator.ts    — Evaluation cascade, fitness scoring
│   ├── heartbeat.ts    — Stall detection, progress tracking
│   └── run.ts          — Main evolutionary loop
├── server.ts           🔨 NEEDS TO BE CREATED
└── test/               🔨 NEEDS TO BE CREATED
    ├── engine.test.ts
    ├── arena.test.ts
    └── runtime.test.ts
```

## Known Issues to Fix Before Proceeding
1. `src/shared/logger.ts` — pino import doesn't compile with ESM. Replace with a simple built-in logger using `console` with structured output (timestamp, level, message, meta). OR switch to a package with ESM support. Just make `npx tsc --noEmit` pass.
2. `src/runtime/isolate.ts` — Has some type assertions (`as ivm.Reference`) that were added as workarounds for isolated-vm typing. They should work at runtime but clean up if possible.

## What Needs to Be Built

### 1. `src/orchestrator/population.ts`
**Island-based MAP-Elites population management.**

Key responsibilities:
- Manage 2-5 islands, each with 20-50 candidates
- MAP-Elites grid keyed on `[strategic_style, fuel_per_tick]` axes
- Evaluate which cell each candidate belongs to based on its behavioral signature (win/loss/draw vectors against reference opponents)
- Periodic migration: when a candidate improves on an island, migrate the worst candidate to another island
- Maintain the best-K exemplars for mutation prompts

Types from shared/types.ts:
```typescript
export interface IslandState {
  islandId: number;
  candidates: ArchivedBot[];
  migrationInterval: number;
  lastMigration: number;
  behaviorAxes: {
    complexity: number[];
    behavioralDiversity: number[];
  };
}
```

Export:
```typescript
export class Population {
  constructor(config: HarnessConfig);
  addCandidate(bot: ArchivedBot): void;
  getBestK(k: number): ArchivedBot[];
  getElite(): ArchivedBot | null;
  migrate(): void;
  getNextGeneration(): ArchivedBot[];
}
```

### 2. `src/orchestrator/mutation.ts`
**LLM-driven mutation pipeline.**

Key responsibilities:
- Build the mutation prompt using MutationContext
- Use SEARCH/REPLACE diff format (AlphaEvolve style)
- k=2 versioned exemplars sorted ascending with scores
- Reward reflection: per-component statistics from last evaluation
- Apply diffs to source code
- Validate output compiles

Export:
```typescript
export function buildMutationPrompt(context: MutationContext): string;
export function applyMutation(source: string, diff: SearchReplaceBlock[]): string;
export function generateMutation(source: string, context: MutationContext, model?: string): Promise<MutationPlan>;
```

The LLM call pattern:
```
POST http://localhost:8000/v1/chat/completions
{
  "model": "Qwen3.6-35B-A3B-8bit",
  "messages": [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
  "temperature": 0.7
}
```

### 3. `src/orchestrator/evaluator.ts`
**Multi-stage evaluation with fitness scoring.**

Key responsibilities:
- Stage 1: syntax check (compile the bot, reject if errors)
- Stage 2: quick rollout (50 steps vs scripted opponents)
- Stage 3: quick games (10 matches)
- Stage 4: full tournament (50 matches vs full roster)
- Fitness scoring combining win rate and compute per tick
- Heartbeat tracking per evaluation

Export:
```typescript
export interface Evaluator {
  evaluate(bot: ArchivedBot, arena: ArenaPlugin): Promise<EvaluationResult>;
  getFitness(result: EvaluationResult): FitnessResult;
  computeParetoFrontier(results: EvaluationResult[]): EvaluationResult[];
}
```

### 4. `src/orchestrator/heartbeat.ts`
**Stall detection and progress tracking.**

Key responsibilities:
- Track last activity per worker/task
- Kill tasks that exceed maxIdleMs without progress
- Report progress (generations completed, best fitness, mutation acceptance rate)
- Emit heartbeat events

Export:
```typescript
export class HeartbeatMonitor {
  constructor(config: Pick<HarnessConfig, 'maxIdleMs' | 'evalTimeoutMs'>);
  register(id: string): void;
  tick(id: string): void;
  checkStalls(): string[]; // returns stalled task IDs
  start(intervalMs: number): NodeJS.Timer;
}
```

### 5. `src/orchestrator/run.ts`
**Main evolutionary loop.**

Key responsibilities:
- Initialize population with seed bots
- Run the evolution loop:
  1. Generate mutations for top candidates
  2. Evaluate mutations
  3. Update MAP-Elites grid
  4. Migrate between islands
  5. Check convergence / max iterations
- Output leaderboard and archive
- Handle graceful shutdown

Export:
```typescript
export async function runEvolution(config: HarnessConfig): Promise<void>;
```

The loop structure:
```typescript
let generation = 0;
const monitor = new HeartbeatMonitor(config);

while (!converged && generation < maxGenerations) {
  const candidates = population.getNextGeneration();
  const results = await Promise.all(
    candidates.map(bot => evaluator.evaluate(bot, arena))
  );
  
  for (const result of results) {
    population.addCandidate(result);
    monitor.tick(result.shipId);
  }
  
  population.migrate();
  generation++;
  
  logger.info({ generation, bestFitness }, 'Generation complete');
}
```

### 6. `src/server.ts`
**HTTP server for the running game.**

Key responsibilities:
- Serve a simple HTML page showing game state
- WebSocket endpoint for live game state streaming
- REST endpoint for leaderboard

Minimal viable: just a REST endpoint returning leaderboard JSON and game state.

### 7. Tests
Basic smoke tests:
- `engine.test.ts` — test world creation, tick, collision
- `arena.test.ts` — test arena init, tick, score
- `runtime.test.ts` — test bundler compiles, isolate runs

## Design Decisions (from the research documents)
1. **Population**: 2 islands × 50 candidates = 100 total. MAP-Elites grid on `[strategic_style, fuel_per_tick]`.
2. **Fitness modes**: pure (win rate), Pareto (strength + fuel), capped (strength subject to fuel ceiling), weighted (strength - λ·fuel).
3. **Bot API**: `function tick(botState: BotState): BotAction`
4. **Arena API**: `tick(state: GameState, agentActions: Map<string, BotAction>): GameState`
5. **Mutation**: SEARCH/REPLACE diffs, k=2 versioned exemplars with scores + failure traces
6. **Evaluation cascade**: syntax → 50-step rollout → 10 quick games → full tournament
7. **Runtime**: isolated-vm + esbuild + deterministic globals
8. **Compute as fitness**: track isolated-vm cpuTime per tick for every bot
9. **Heartbeat**: each evaluation has a timeout; stalled tasks are killed

## Deliverables
- All files above must compile with `npx tsc --noEmit`
- No `any` types unless absolutely necessary
- Comprehensive JSDoc for all public APIs
- Logger should output structured JSON with timestamp, level, and message
- Use `pino` or equivalent — if pino won't compile, use a simple built-in logger
