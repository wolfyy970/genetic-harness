# ARCHITECTURE

## Module map

```
src/
├── shared/
│   ├── types.ts         Core types: GameConfig, GameState, BotState, BotAction,
│   │                    FitnessResult, ArchivedBot, HarnessConfig, MutationContext.
│   ├── config.ts        loadConfig() merges DEFAULT_CONFIG with overrides.
│   └── logger.ts        Structured logger (timestamp, level, message, meta).
│                        Serializes Errors and bigints.
├── engine/              Pure-function arena physics — no isolate, no LLM.
│   ├── world.ts         createWorld, worldTick, spawnBullet, buildBotState.
│   ├── collision.ts     detectCollisions (mutates state in place).
│   ├── actions.ts       applyActionToShip — dispatches BotAction → ship state.
│   ├── renderer.ts      toReplayFrame.
│   └── utils.ts         SeededRNG, vector math, wrapPosition, dist, clamp.
├── arena/
│   ├── interface.ts     registerArena / getArena registry; default 'asteroids'.
│   └── asteroids.ts     The v1 arena. Registers itself on import.
├── runtime/             ControllerRuntime layer — currently isolated-vm only.
│   ├── isolate.ts       IsolatePool: compileBot + runTick (sync, CPU-budget timeout,
│   │                    cpuNanos sampling).
│   ├── deterministic.ts JS snippet that strips Math.random / Date.now / timers /
│   │                    network. Eval'd inside the bot's context.
│   └── bundler.ts       esbuild → IIFE that assigns globalThis.tick.
└── orchestrator/        Evolutionary loop and everything around it.
    ├── reference.ts     Frozen reference roster (Null, Random, Aggressive, Evasive).
    ├── match.ts         playMatch: runs N bots through the IsolatePool tick by tick;
    │                    tracks per-ship CPU + action histogram + score + survival.
    ├── evaluator.ts     Cascade: compile gate → smoke vs Null → round-robin against
    │                    reference roster (3 seeds each). Mode (pure/pareto/capped/
    │                    weighted) selects fitnessScore in buildFitnessFromStats.
    ├── mutation.ts      generateMutation (live LLM or mock) +
    │                    generateMutationWithRetry (Self-Debugging compile-retry).
    ├── population.ts    Island MAP-Elites; cell key = (aggression × log fuel/tick).
    ├── heartbeat.ts     Per-task stall detector with progress messages.
    └── run.ts           runEvolution: seed → mutate → evaluate → migrate → repeat.
                         CLI entry. Returns EvolutionSummary; no process.exit
                         outside the CLI guard.
```

## Data flow per generation

```
seed bot ──► [evaluator: compile → smoke vs Null → round-robin vs roster]
                                                       │
                                                       ▼
                                               FitnessResult
                                                       │
                                                       ▼
                                          [population.addCandidate]
                                                       │
                                                       ▼
                                       [population.getNextGeneration]
                                                       │
                                                       ▼
              [mutation: build prompt → LLM (or mock) → SEARCH/REPLACE diff
                                  → bundle.compile → on fail, retry up to 2x]
                                                       │
                                                       ▼
                              new ArchivedBot with mutation.source
                                                       │
                                                       ▼
                                  [evaluator] (loops back to top)
```

The shared `IsolatePool` and pre-compiled reference roster live for the lifetime of one `runEvolution` call. The candidate's isolate is created on each evaluate, disposed at the end; the reference roster is recompiled once and reused.

## Bot execution model

The bot exports a single function: `function tick(s: BotState): BotAction`.

The bundler ([src/runtime/bundler.ts](src/runtime/bundler.ts)) appends `globalThis.tick = tick` to the source before esbuild bundles to an IIFE; this is what makes `tick` reachable from the host. The deterministic-globals snippet ([src/runtime/deterministic.ts](src/runtime/deterministic.ts)) is eval'd inside the bot's context first, replacing `Math.random` with a Mulberry32 PRNG and stripping every async / network / module / process API. The bundle is then run in the same context, defining `globalThis.tick`. The pool captures `tick` as an `ivm.Reference`. Per-tick execution is `tickRef.applySync(undefined, [state], { arguments: { copy: true }, result: { copy: true }, timeout: cpuBudgetMs })`; cpuNanos is the delta of `isolate.cpuTime` across the call.

`Math.random` and the engine's `SeededRNG.next()` use the same Mulberry32 algorithm; keep them in sync.

## Fitness modes

All four modes route through `buildFitnessFromStats(stats, mode, config)` in [evaluator.ts](src/orchestrator/evaluator.ts). The MAP-Elites grid keys on `(aggression bucket, log fuel bucket)` regardless of mode; mode only changes the scalar `fitnessScore` used for ranking.

| Mode | fitnessScore |
|---|---|
| `pure` | `winRate + 0.25 * drawRate` |
| `pareto` | `winRate + 0.25 * drawRate` (same scalar; Pareto front computed externally) |
| `capped` | `-1` if `avgFuelPerTick > fuelCeiling`, else `winRate + 0.25 * drawRate` |
| `weighted` | `winRate - λ * (avgFuelPerTick / 1e6)` |

`avgFuelPerTick` is in nanoseconds. λ = 1 means "1 ms/tick of CPU costs you 1 unit of win-rate."

## Key design decisions

1. **Bundler appends an explicit globalThis assignment.** esbuild's IIFE format scopes top-level functions; `globalName` only exposes the bundle's exports, so plain `function tick` would be invisible to the host. We append `globalThis.tick = tick` to the source before bundling.

2. **Single shared isolate pool per `runEvolution` call.** Each evaluate creates a new candidate isolate but shares the pool (and pre-compiled reference roster) across evals. Saves ~25–50ms of redundant roster compilation per evaluation.

3. **Compile-and-retry around the LLM.** `generateMutationWithRetry` calls the LLM, tries to bundle the result, and on failure feeds the bundler error back into `evaluationHistory` for the next attempt (up to N retries). Falls back to the original source if the budget is spent.

4. **Mode is a fitness concern, not a population concern.** The MAP-Elites grid keys on `(aggression, log fuel)` always. Mode reshapes ranking without reshaping search topology.

5. **`isolated-vm` default-imported.** Use `import ivm from 'isolated-vm'` (default), not `import * as ivm`. Under raw Node ESM, the namespace import exposes the constructor at `ivm.default.Isolate`; vitest's CJS interop is more forgiving and masks the bug.

## Phase 2: AssemblyScript-on-Wasmtime substrate

The current substrate (isolated-vm + esbuild + JS bot source) works but `cpuTime` is wall-clock-derived and not reproducible across machines. Phase 2 swaps the runtime for AssemblyScript compiled to WebAssembly, executed in Wasmtime with fuel-based instruction metering — the only deterministic instruction-counted budget available in JS-adjacent ecosystems.

Steps:

1. **`ControllerRuntime` interface** — promote IsolatePool's surface to `compile / instantiate / tick / fuelUsed / reset / destroy`. Existing IsolatePool implements it; Wasmtime backend implements the same shape.
2. **Wasmtime Node binding** — no first-party npm package exposes the full `Config` API (`consume_fuel` + `cranelift_nan_canonicalization` + `relaxed_simd_deterministic`). Likely path: a Rust subprocess pool over JSON-over-stdio.
3. **AssemblyScript toolchain** — compile bot source via `asc` programmatically (~100ms per mutation), use the `stub` runtime to avoid GC-induced timing variation.
4. **State-buffer schema codegen** — define arena state as a TypeScript schema; generate (a) a `.d.ts` for the LLM prompt and (b) an `@unmanaged` AssemblyScript class for the bot. Boundary contract becomes one fat call per tick: `tick(stateBuf: usize) → action: i32`.
5. **Determinism flags** — `consume_fuel`, `cranelift_nan_canonicalization`, `relaxed_simd_deterministic`, `min=max` memory, reject `memory.grow`, per-tick state checksum.
6. **AssemblyScript-aware mutation prompts** — update the prompt to emit AssemblyScript; the compile-retry wrapper now consumes `asc` errors instead of esbuild's.
7. **Version-pinned fuel cost table** — per-operator weights in a versioned config so populations from two harness releases are commensurable.

isolated-vm doesn't disappear in Phase 2 — it stays available behind the same `ControllerRuntime` interface for prototype-stage arenas where compute determinism doesn't matter.
