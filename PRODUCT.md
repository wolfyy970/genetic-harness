# PRODUCT

## What this is

A **genetic harness** — a research substrate that uses an LLM as the variation operator inside an asynchronous evolutionary loop. The LLM proposes edits to a JavaScript bot controller; a sandboxed evaluator scores it by playing matches against a frozen reference roster; survivors enter a MAP-Elites archive and seed the next generation. The harness is the surrounding plumbing: sandbox, fitness function, archive, scheduler, and CLI. The LLM is the only mutation source.

## Who it's for

- **AI researchers** investigating LLM-as-evolutionary-operator patterns (FunSearch / AlphaEvolve / OpenEvolve lineage) in a competitive game-bot setting that the existing literature only barely covers (CodeClash, Nov 2025; LLM Skirmish, Dec 2025).
- **Game-AI tinkerers** who want to evolve a controller for an arena game and watch a Pareto frontier of strength-vs-compute emerge.
- **Anyone building a CodeClash-style benchmark** who needs a reusable harness with proper fitness modes and a deterministic-replay path.

## Why it exists

Three observations in the literature converge on this design:

1. **LLM-as-mutation outperforms LLM-as-agent at scale.** FunSearch, AlphaEvolve, and OpenEvolve run thousands to millions of single-shot mutations with structured diffs and reward reflection — orders of magnitude more sample-efficient than spinning up a coding agent per candidate (CodeClash, LLM Skirmish). The harness commits to the mutation pattern.
2. **Per-tick controller compute is a strategic resource.** AT Robots, RoboWar, and Battlecode all treat compute as a budget on equal footing with sensors and weapons. The modern web-arena generation (Halite, Battlesnake, Lux) dropped this because subprocess sandboxes can't meter compute deterministically. The harness recovers it by treating CPU-per-tick as a first-class fitness dimension and (in Phase 2) committing to Wasmtime fuel as a deterministic substrate.
3. **Quality-diversity finds higher-quality optima than targeted search.** MAP-Elites + islands is the AlphaEvolve / OpenEvolve operating point. The harness uses the same shape, with the grid keyed on (aggression × log fuel-per-tick) so lean-but-weak and bloated-but-strong controllers occupy distinct cells.

## Design principles

| Principle | Manifestation |
|---|---|
| LLM proposes, deterministic evaluator scores, archive curates | `mutation.ts` → `evaluator.ts` → `population.ts` |
| Compute is a first-class fitness axis | `cpuNanos` sampled per tick; one of MAP-Elites' two axes |
| Locked evaluator the agent cannot modify | Evaluator + reference roster live outside the bot's sandbox |
| Atomic accept/reject per candidate | Each evaluation produces a self-contained `EvaluationResult` |
| Fresh state per iteration | One isolate per candidate; disposed after eval (shared roster) |
| Mode is a knob, not a fork | `pure / pareto / capped / weighted` flow through one fitness function |

## What this is *not*

- **Not a Claude-Code-style coding agent.** The harness uses one-shot LLM mutations; Self-Debugging compile-retry is the only feedback loop. Agentic per-bot authoring (CodeClash's pattern) is the opposite shape and not in scope.
- **Not a tournament platform.** No public leaderboard, no submission API, no anti-cheat. The reference roster is for fitness signal, not competition.
- **Not a substitute for live human play.** Per CodeClash's headline finding, frontier LLMs lose every round against expert humans; the harness produces interesting controllers within a fixed compute regime, not strong general agents.

## Where this fits in the literature

The closest documented analogs are **CodeClash** (Princeton/Stanford, Nov 2025) and **LLM Skirmish** (Dec 2025). Both spin up a coding agent per round, which inverts the harness's design (one-shot mutations at scale). The closest evolutionary analogs are **AlphaEvolve** (DeepMind, 2025) and **OpenEvolve** (open-source faithful reimplementation, 2025); the harness inherits their MAP-Elites + islands + SEARCH/REPLACE diff format, applied to game controllers instead of math heuristics.

The Phase 2 substrate pivot (AssemblyScript on Wasmtime with fuel metering) is what would make this a *novel* benchmark — no existing LLM-game-bot harness scores compute as a first-class metric.
