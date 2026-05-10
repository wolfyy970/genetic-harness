# USER_GUIDE

## Install

Requires Node ≥22.7 (for `--env-file-if-exists`) and a working C++ toolchain (for the native `isolated-vm` build).

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
| `npm run serve` | Start the dashboard (HTTP server). |

`runEvolution` calls `setLeaderboard()` after every generation, so the dashboard reflects live progress when `npm run serve` and a run share the same Node process. When the run is in a separate process (e.g. spawned via `POST /api/runs`), the server falls back to reading `<archiveDir>/leaderboard.json` from disk. `PORT` env var picks the listen port (default 3000).

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
| `archiveDir` | `./data/archive` | Where leaderboard, manifest, and replays live. |
| `leaderboardSize` | 50 | Top-N persisted to `leaderboard.json`. |
| `llmBaseUrl` | `http://localhost:8000/v1` | Set to `mock` to bypass the network. |
| `llmModel` | `Qwen3.6-35B-A3B-8bit` | Any chat-completions-compatible model name. |
| `llmApiKey` | `omlx-local` | Sent as `Bearer <key>`. |
| `maxGenerations` | 50 | Loop terminates after this many generations. |
| `evalTimeoutMs` | 60_000 | Per-evaluation timeout. |
| `maxIdleMs` | 30_000 | Heartbeat stall threshold. |
| `stages` | (full cascade) | Toggle per stage; see below. |
| `recordReplays` | `false` | Master toggle for replay capture. Smoke unchanged when off. |
| `replayCount` | 2 | Top-N elites per generation that get a recorded match against each non-null reference opponent. |
| `replayMaxFrames` | 1500 | Hard cap on stored frames per match (~75s @ 50ms tick). |
| `replaySampleEvery` | 1 | Sample every Nth tick. |
| `replayKeepGenerations` | 20 | Rolling window; older `gen-NNNN/` directories are pruned. |

The cascade currently has three stages:

| Stage | Runs when | What it does |
|---|---|---|
| 0 | always | Bundle + isolate boot. A bot that fails compile or never defines `globalThis.tick` is rejected here. |
| 1 | `quickRollout.enabled` | Single short match (80 ticks) against the Null reference bot. |
| 2 | `quickGames.enabled \|\| fullTournament.enabled` | Round-robin 1v1 against the rest of the roster, 3 seeds each. |

The `stages.syntax` field is currently a no-op — the compile gate is unconditional. `quickRollout.steps`, `quickGames.games`, and `fullTournament.games` are configurable but the cascade does not yet vary the seed count or match length per the `games` value; those will become meaningful when stage 2 is split.

## Environment variables

`npm run serve` and `npm run run` are wrapped with `node --env-file-if-exists=.env`, so values placed in a project-root `.env` file are picked up automatically. A starter is checked in at [.env.example](.env.example) — copy to `.env` and edit. `.env` is gitignored.

| Variable | Effect |
|---|---|
| `LLM_MOCK=1` | Force mock-LLM mode regardless of `llmBaseUrl`. |
| `DEBUG` | Any truthy value enables `logger.debug(...)` output. |
| `HARNESS_PORT` | Server listen port. Default `3000`. |
| `HARNESS_HOST` | Server bind host. Default `127.0.0.1`. Setting to a non-loopback host requires `HARNESS_TOKEN`. |
| `HARNESS_TOKEN` | Bearer token gating `/api/*`. When unset, no auth (loopback only). |
| `HARNESS_ARCHIVE_DIR` | Override the archive root. Default `./data/archive`. Applies to both server and orchestrator. |
| `HARNESS_LLM_BASE_URL` | Default `llmBaseUrl` for new runs. Overridden by per-run JSON. |
| `HARNESS_LLM_MODEL` | Default `llmModel` for new runs. |
| `HARNESS_LLM_API_KEY` | Default `llmApiKey` for new runs. Stripped from persisted manifests. |

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

## Replay UI

Enable replay recording with `recordReplays: true` in your config (or via the dashboard's run-control form). After each generation the orchestrator:

1. Picks the top-`replayCount` elites.
2. Re-runs each elite against every non-null reference opponent with a `JsonReplayRecorder` attached.
3. Writes each match as JSON under `<archiveDir>/generations/gen-NNNN/<matchId>.json`.
4. Appends an entry to `<archiveDir>/manifest.json` (which also tracks `mapElitesGrid` and `generationStats`).
5. Prunes generation directories beyond `replayKeepGenerations`.

Open `npm run serve` in one shell, your run in another (or via the dashboard's run-control form), and visit `http://localhost:3000`. The dashboard polls `/api/manifest` + `/api/leaderboard` every 2s; replays appear in the dropdown as they land.

The replay player exposes the canonical `BotState` view via the per-tick `arena.renderer(state) → ReplayFrame` boundary — it shows positions and orientations, not internal velocities or fuel. Click a leaderboard row to filter the replay dropdown to that bot's matches; click a MAP-Elites cell to load the elite of that cell.

## Remote control

The dashboard ships with a small run-control surface so the heavy machine running evolution doesn't have to be the same machine you're looking at the UI on:

- `POST /api/runs` (body: HarnessConfig overrides) spawns the orchestrator as a child process. One active run at a time; subsequent calls return HTTP 409.
- `GET /api/runs` lists active and recent runs.
- `GET /api/runs/:id/status` returns the current state (`running` / `exited` / `error`) and process exit code.
- `GET /api/runs/:id/log` returns the tail of stdout/stderr.
- `DELETE /api/runs/:id` sends SIGINT.

Recommended setup for a workstation + remote box:

```bash
# On the heavy box (e.g. Mac Studio):
HARNESS_HOST=0.0.0.0 HARNESS_TOKEN=$(openssl rand -hex 16) npm run serve

# On the laptop:
open http://<heavy-box>:3000
# Browser prompts once for the token; it's stored in localStorage.
```

The server refuses to start when bound to a non-loopback host without a `>=16-char` `HARNESS_TOKEN`. Token comparison is constant-time. There's no multi-user notion — this is a single-operator dashboard.

## Extending

### Add an arena

Adding a new arena is two files:

1. **Server side**: implement the `ArenaPlugin` interface from [src/shared/types.ts](src/shared/types.ts): `init / tick / score / renderer`. Register it: `registerArena('myarena', myPlugin)`. Side-effect import the file from your entry point. Set `arena: 'myarena'` in the config.
2. **Client side**: drop a viewer module at `public/viewers/myarena.js` exporting `paint(ctx, frame, meta)`, `dimensions: { width, height }`, and `legend()`. The dashboard loads it dynamically based on `manifest.arena`.

The Asteroids arena pair ([src/arena/asteroids.ts](src/arena/asteroids.ts) + [public/viewers/asteroids.js](public/viewers/asteroids.js)) is the working example.

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
