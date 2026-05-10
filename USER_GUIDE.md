# USER_GUIDE

## Install

Requires Node ≥22 and a working C++ toolchain (for the native `isolated-vm` build).

```bash
npm install              # ~1 min on first install
npm test                 # full vitest suite, under 2s
```

## Scripts

| Script | What it does |
|---|---|
| `npm test` | Run vitest once. |
| `npm run test:watch` | Run vitest in watch mode. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run build` | `tsc` — emits compiled JS into `tsconfig.outDir`. |
| `npm run smoke` | 3-generation mock-LLM evolution; completes in ~1s. |
| `npm run run -- '<json-config>'` | Run with custom JSON-overrides. |
| `npm run serve` | Start the read-only HTTP server (see below). |

The HTTP server in [src/server.ts](src/server.ts) is a stub: routes `GET /api/leaderboard`, `GET /api/state`, `GET /`. The leaderboard is exposed via an exported `setLeaderboard(data)` but **`runEvolution` does not currently call it**, so the served leaderboard is always empty until that wiring lands. `PORT` env var picks the listen port (default 3000).

## Configuration

Configuration is a JSON object passed as the first CLI argument (or to `runEvolution(overrides)` programmatically). Defaults live in `DEFAULT_CONFIG` in [src/shared/types.ts](src/shared/types.ts).

Key fields:

| Field | Default | Notes |
|---|---|---|
| `populationSize` | 100 | Total bots across islands. |
| `islandCount` | 2 | One seed bot per island at startup. |
| `migrationInterval` | 50 | Generations between island migrations. |
| `mode` | `pure` | One of `pure / pareto / capped / weighted`. |
| `fuelCeiling` | — | ns/tick ceiling. Required for `capped`. |
| `λ` | — | weighted-mode penalty. |
| `arena` | `asteroids` | Arena name registered via `registerArena`. |
| `arenaConfig` | `{}` | Partial `GameConfig` merged into evaluation matches. |
| `llmBaseUrl` | `http://localhost:8000/v1` | Set to `mock` to bypass the network. |
| `llmModel` | `Qwen3.6-35B-A3B-8bit` | Any chat-completions-compatible model name. |
| `llmApiKey` | `omlx-local` | Sent as `Bearer <key>`. |
| `maxGenerations` | 50 | Loop terminates after this many generations. |
| `evalTimeoutMs` | 60_000 | Per-evaluation timeout. |
| `maxIdleMs` | 30_000 | Heartbeat stall threshold. |
| `stages` | (full cascade) | Toggle per stage; see below. |

The cascade currently has three stages:

| Stage | Runs when | What it does |
|---|---|---|
| 0 | always | Bundle + isolate boot. A bot that fails compile or never defines `globalThis.tick` is rejected here. |
| 1 | `quickRollout.enabled` | Single short match (80 ticks) against the Null reference bot. |
| 2 | `quickGames.enabled \|\| fullTournament.enabled` | Round-robin 1v1 against the rest of the roster, 3 seeds each. |

The `stages.syntax` field is currently a no-op — the compile gate is unconditional. `quickRollout.steps`, `quickGames.games`, and `fullTournament.games` are configurable but the cascade does not yet vary the seed count or match length per the `games` value; those will become meaningful when stage 2 is split.

## Environment variables

| Variable | Effect |
|---|---|
| `LLM_MOCK=1` | Force mock-LLM mode regardless of `llmBaseUrl`. |
| `DEBUG` | Any truthy value enables `logger.debug(...)` output. |

## LLM modes

**Mock mode** (no network): set `llmBaseUrl: 'mock'` or `LLM_MOCK=1`. The mock mutator applies one of three deterministic source-level perturbations — extends an engagement range, inserts a low-fuel-wait guard, or flips a rotate direction. Useful for offline tests and CI.

**Live mode** (default): any OpenAI-compatible chat-completions endpoint. The harness sends a system + user prompt, expects SEARCH/REPLACE blocks in the response, applies them to the source, and feeds bundle errors back into the prompt for up to 2 retries (`generateMutationWithRetry` in [src/orchestrator/mutation.ts](src/orchestrator/mutation.ts)).

## Writing a bot

Bots are vanilla TypeScript with a single function:

```ts
function tick(s: BotState): BotAction {
  return { type: 'wait' };
}
```

`BotState` (full definition in [src/shared/types.ts](src/shared/types.ts)) includes `s.ship`, `s.opponents`, `s.asteroids` (full world awareness), `s.bullets`, `s.tick`. The function must be a top-level declaration named `tick`; the bundler appends `globalThis.tick = tick` so the host can capture it.

`BotAction` is one of:

```ts
{ type: 'thrust'; angle: number }     // angle in radians
{ type: 'rotate'; direction: -1 | 1 } // unit step
{ type: 'fire' }                      // spawn a bullet
{ type: 'wait' }                      // no-op
```

The bot runs inside an isolated-vm context with deterministic globals. **Available**: `Math`, `Date.now()` (returns `tick * tickMs`), `performance.now()` (same). **Not available**: `setTimeout`, `setInterval`, `fetch`, `XMLHttpRequest`, `require`, `process`, `console`, network. The whole context is a fresh isolate per candidate.

Reference bots in [src/orchestrator/reference.ts](src/orchestrator/reference.ts) (Null / Random / Aggressive / Evasive) are the canonical examples.

## Extending

### Add an arena

1. Implement the `ArenaPlugin` interface from [src/shared/types.ts](src/shared/types.ts): `init / tick / score / renderer`.
2. Register it: `registerArena('myarena', myPlugin)`. Side-effect import the file from your entry point.
3. Set `arena: 'myarena'` in the config.

The Asteroids arena ([src/arena/asteroids.ts](src/arena/asteroids.ts)) is the working example.

### Add a fitness mode

Edit the `switch (mode)` in `buildFitnessFromStats` in [src/orchestrator/evaluator.ts](src/orchestrator/evaluator.ts). Add the mode literal to `HarnessConfig['mode']` in [src/shared/types.ts](src/shared/types.ts) so the type union covers it. The MAP-Elites grid does not change.

### Add a runtime backend

The current substrate is `IsolatePool` in [src/runtime/isolate.ts](src/runtime/isolate.ts). Phase 2 introduces a `ControllerRuntime` interface (`compile / tick / fuelUsed / destroy`) so a Wasmtime backend can implement the same surface. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the Phase 2 plan.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `ivm.Isolate is not a constructor` | Use `import ivm from 'isolated-vm'` (default), not namespace import. |
| `Bot did not define a callable globalThis.tick` | Source needs a top-level `function tick(s) { ... }`. The bundler appends the globalThis assignment automatically. |
| `Reference bot "ref-null" failed to compile` | Usually downstream of the `ivm.Isolate` issue above. |
| Mutations always rejected | Check the LLM endpoint is reachable, and that the response actually contains `<SEARCH>...</SEARCH><REPLACE>...</REPLACE>` blocks. Mock mode is the easy fallback. |
| Tests pass but CLI fails | Almost always an ESM-vs-CJS interop diff between vitest and raw Node. Reproduce in raw `tsx` first. |
