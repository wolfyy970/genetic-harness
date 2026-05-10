# genetic-harness

LLM-driven evolutionary loop that mutates JavaScript bot controllers, plays them against a frozen reference roster in a multiplayer Asteroids arena, and ranks them under one of four fitness modes (pure / Pareto / capped / weighted). MAP-Elites within islands; per-tick CPU is a first-class fitness axis.

## Status

**v1 working end-to-end.** Full vitest suite passes in under 2s; mock-LLM smoke run completes 3 generations in about a second; isolated-vm + esbuild substrate. Phase 2 (AssemblyScript-on-Wasmtime substrate for cross-machine deterministic compute metering) is planned but not implemented.

## Quick start

```bash
npm install              # native isolated-vm build, ~1 min first time
npm test                 # full vitest suite
npm run smoke            # 3 generations, mock LLM, no network
```

To run with a real LLM (any OpenAI-compatible chat-completions endpoint):

```bash
npx tsx src/orchestrator/run.ts '{"llmBaseUrl":"http://localhost:8000/v1","llmModel":"Qwen3.6-35B-A3B-8bit","llmApiKey":"omlx-local","maxGenerations":5}'
```

## Documentation

- [PRODUCT.md](./PRODUCT.md) — what this is, who it's for, design principles
- [ARCHITECTURE.md](./ARCHITECTURE.md) — module map, data flow, runtime substrate, Phase 2 plan
- [USER_GUIDE.md](./USER_GUIDE.md) — install, run, configure, write a bot, extend
- [DOCUMENTATION.md](./DOCUMENTATION.md) — documentation philosophy (canonical, do not edit)
