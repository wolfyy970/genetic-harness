/**
 * @module mutation
 */

/**
 * LLM-driven mutation pipeline.
 *
 * Generates SEARCH/REPLACE diffs for bot code mutations using
 * k=2 versioned exemplars with scores and failure traces.
 */

import { logger } from '../shared/logger.js';
import type {
  ArchivedBot,
  FitnessResult,
  MutationContext,
  MutationPlan,
  SearchReplaceBlock,
  HarnessConfig,
} from '../shared/types.js';
import { bundle, BUNDLE_ERROR_PREFIX } from '../runtime/bundler.js';
import { BOT_AUTHOR_MANUAL } from './prompts/bot-author-manual.js';
import {
  BotSubmissionSchema,
  DiverseSeedBatchSchema,
  BotSubmissionResponseFormat,
  parseSchemaResponse,
} from './prompts/schemas.js';
import { getOrProbeCapabilities, type LLMCapabilities } from './llm-capabilities.js';

/**
 * Build the mutation prompt for the LLM.
 * Uses k=2 versioned exemplars sorted ascending with scores,
 * plus reward-reflection and failure traces.
 */
export function buildMutationPrompt(context: MutationContext): { system: string; user: string } {
  const { bestK, evaluationHistory, rewardReflection, mode, fuelBudget, λ } = context;

  // The system prompt is the canonical bot-author manual — byte-identical
  // across every call. KV-cache hits on the LLM server skip re-encoding
  // it. The task-specific content lives in the user prompt below.
  const systemPrompt = BOT_AUTHOR_MANUAL;

  // Per-call task: just the exemplars + reflection + instructions.
  // No BotState contract, no DON'T list, no output-format rules —
  // those all live in the manual now. The schema (Slice E wiring)
  // enforces the response shape; here we just describe the task.
  const userPrompt = `== Task ==
Improve on the parent exemplar shown below. Pick ONE concrete deficit and fix it. Return ONE JSON object matching the response schema: \`{ "source": "function tick(s) { ... }", "strategy": "<one-sentence summary>" }\`.

Mode: ${mode}${fuelBudget ? ` (fuel ceiling: ${fuelBudget}/tick)` : ''}${λ ? ` (weight: λ=${λ})` : ''}

== Parent exemplar ==
Score: ${bestK[0]?.fitness.fitnessScore?.toFixed(2) ?? 'N/A'}, Win rate: ${((bestK[0]?.fitness.winRate ?? 0) * 100).toFixed(0)}%, Avg fuel/tick: ${bestK[0]?.fitness.avgFuelPerTick?.toFixed(0) ?? 'N/A'}
\`\`\`js
${bestK[0]?.source ?? 'N/A'}
\`\`\`

${bestK[1] ? `== Second exemplar (for context) ==
Score: ${bestK[1].fitness.fitnessScore?.toFixed(2) ?? 'N/A'}, Win rate: ${((bestK[1].fitness.winRate ?? 0) * 100).toFixed(0)}%
\`\`\`js
${bestK[1].source}
\`\`\`

` : ''}== Recent reflection ==
Pop. win rate: ${((rewardReflection?.winRate ?? 0) * 100).toFixed(0)}%, avg score: ${(rewardReflection?.avgScore ?? 0).toFixed(0)}, avg fuel/tick: ${(rewardReflection?.avgFuelPerTick ?? 0).toFixed(0)}

${evaluationHistory ? `== Recent failure traces ==
${evaluationHistory}

` : ''}Pick ONE specific deficit in the parent and fix it concretely (don't bundle five vague tweaks). Refer to §6 of the manual for worked-example idioms if you need them. The strategy field should be a one-sentence summary of WHAT you changed and WHY.`;

  return { system: systemPrompt, user: userPrompt };
}

/**
 * Legacy free-text mutation prompt — kept ONLY for the `'none'` capability
 * fallback path where structured output is unavailable. The user portion
 * still references the manual but explicitly asks for fenced output.
 */
function buildMutationPromptFreeText(context: MutationContext): { system: string; user: string } {
  const built = buildMutationPrompt(context);
  return {
    system: built.system,
    user: `${built.user}

Return your bot as exactly ONE fenced JavaScript code block:

\`\`\`js
function tick(s) {
  // your implementation
}
\`\`\``,
  };
}

// Legacy free-text-format prompt body — preserved verbatim for one slice
// just in case any consumer ever wants to compare. Not actively used.
function _LEGACY_buildMutationPromptText(context: MutationContext): { system: string; user: string } {
  const { bestK, evaluationHistory, rewardReflection, mode, fuelBudget, λ } = context;

  const systemPrompt = `You are an expert JavaScript programmer specialising in competitive game AI.
You will be shown the source of a game controller (bot) that plays an 8-player free-for-all Asteroids-like arena. Your job is to write a NEW, IMPROVED version of the bot — same function signature, different (better) body.

Game mechanics (real Asteroids parity):
- Toroidal world (2800×2100 px): ships, asteroids, bullets wrap around edges.
- Zero linear friction — momentum is preserved. Reverse thrust is the only way to slow down.
- Ship-relative thrust: \`{type:'thrust', direction: 1}\` = forward along ship.angle; \`{type:'thrust', direction:-1}\` = retrograde.
- Rotation: \`{type:'rotate', direction: 1|-1}\` is an angular impulse with natural damping.
- \`{type:'fire'}\` shoots forward. Bullets travel ~1600 px before despawn. 3 bullets per ship max in flight.
- Asteroids come in 3 tiers: LARGE → splits into 2 MEDIUM → 2 SMALL → destroyed.
  Asteroid collisions are tier-lethal: LARGE = instant kill from full HP.
- 7 opponents in every match.

BotState shape — THIS IS THE EXACT OBJECT YOU RECEIVE AS \`s\`. Memorise it. Every field name here is real; anything else is wrong:
\`\`\`ts
type BotState = {
  tick: number,            // current tick number
  ship: {
    pos:   { x: number, y: number },   // ABSOLUTE wrapped position. NOT s.ship.x !
    vel:   { x: number, y: number },   // current velocity
    angle: number,                      // heading in radians
    health: number,                     // 0..100
    fuel:   number,                     // remaining fuel budget
    score:  number
  },
  opponents:  Array<{ id: string, pos: {x,y}, vel: {x,y}, angle: number, health: number }>,
  asteroids:  Array<{ id: string, pos: {x,y}, vel: {x,y}, radius: number, tier: 'LARGE'|'MEDIUM'|'SMALL' }>,
  bullets:    Array<{ id: string, pos: {x,y}, vel: {x,y}, ownerId: string }>
};
\`\`\`

Bot view conventions (CRITICAL — different from naïve coordinates):
- \`s.ship.pos.x\` and \`s.ship.pos.y\` — ALWAYS through \`.pos\`. There is NO \`s.ship.x\`.
- \`s.opponents[i].pos\`, \`s.asteroids[i].pos\`, \`s.bullets[i].pos\` are
  **already shifted into your local frame for shortest-path math**. So
  \`dx = o.pos.x - s.ship.pos.x\` is the toroidal-shortest signed delta
  even when the opponent is across the screen wrap. These coords may be
  negative or > W/H — that's intentional and correct.
- \`Math.atan2(o.pos.y - s.ship.pos.y, o.pos.x - s.ship.pos.x)\` gives the
  correct heading toward the opponent regardless of wrap.
- Sensor range: 600 px. Anything farther isn't in the lists.
- Dead opponents are filtered out of \`s.opponents\` — you only see live ships.

Worked example of the toroidal local frame (use this exact idiom):
\`\`\`js
// Closest opponent — pos is already in your local frame, so plain
// subtraction yields the shortest-path delta even across the wrap.
let best = null, bestDist = Infinity;
for (const o of s.opponents) {
  const dx = o.pos.x - s.ship.pos.x;
  const dy = o.pos.y - s.ship.pos.y;
  const d2 = dx*dx + dy*dy;
  if (d2 < bestDist) { bestDist = d2; best = { o, dx, dy }; }
}
if (best) {
  const desired = Math.atan2(best.dy, best.dx);          // heading toward target
  const err = ((desired - s.ship.angle + Math.PI*3) % (Math.PI*2)) - Math.PI;
  if (Math.abs(err) > 0.05) return { type: 'rotate', direction: err > 0 ? 1 : -1 };
  if (bestDist < 200*200) return { type: 'fire' };
  return { type: 'thrust', direction: 1 };
}
\`\`\`

BotAction type:
\`\`\`ts
type BotAction =
  | { type: 'thrust'; direction: 1 | -1 }
  | { type: 'rotate'; direction: 1 | -1 }
  | { type: 'fire' }
  | { type: 'wait' };
\`\`\`

Output format — exactly one fenced JavaScript code block, containing exactly one complete \`function tick(s) { ... }\`. No prose outside the fence, no diff syntax, no multiple variants. The function body is your entire mutation.

Rules:
- Function signature MUST be \`function tick(s) { ... }\`.
- Plain JavaScript only (no imports, no TypeScript types, no \`const x: T\` syntax).
- No \`console.log\`, \`setTimeout\`, \`fetch\`, or non-deterministic APIs other than \`Math.random()\`.
- Use ONLY the action shapes above. Old \`{type:'thrust', angle: number}\` is invalid.
- Keep the body under ~80 lines so the LLM call stays fast.

DON'T (these are common LLM hallucinations — every one is INVALID, every one we've actually seen):
- ❌ \`s.ship.x\`, \`s.ship.y\` — WRONG. Position is nested: \`s.ship.pos.x\`, \`s.ship.pos.y\`.
- ❌ \`s.ship.vx\`, \`s.ship.vy\` — WRONG. Velocity is nested: \`s.ship.vel.x\`, \`s.ship.vel.y\`.
- ❌ \`s.opponents[i].x\`, \`s.asteroids[i].x\`, \`s.bullets[i].x\` — WRONG. Always \`.pos.x\` / \`.pos.y\` on every entity.
- ❌ \`s.me\`, \`s.self\`, \`s.player\`, \`s.enemies\`, \`s.foes\`, \`s.rocks\` — none exist. Only \`s.ship\`, \`s.opponents\`, \`s.asteroids\`, \`s.bullets\`, \`s.tick\`.
- ❌ \`s.ship.heading\`, \`s.ship.rotation\`, \`s.ship.theta\` — the field is named \`angle\` (radians).
- ❌ \`s.ship.hp\` — the field is named \`health\`.
- ❌ \`{type:'thrust', angle: 1.2}\` — no \`angle\` field; thrust is ship-relative via \`direction\`.
- ❌ \`{type:'thrust', power: 0.5}\` or \`{type:'thrust', magnitude: 1}\` — no power/magnitude; thrust is a fixed impulse.
- ❌ \`{type:'rotate', angle: 0.1}\` or \`{type:'rotate', target: 0.5}\` — rotate takes \`direction: 1 | -1\`, not an angle.
- ❌ \`{type:'fire', target: ...}\` or \`{type:'fire', angle: ...}\` — fire shoots forward; aim by rotating first.
- ❌ \`{type:'move', ...}\`, \`{type:'turn', ...}\`, \`{type:'shoot'}\`, \`{type:'accelerate'}\`, \`{type:'brake'}\` — only the four BotAction types exist.
- ❌ Returning an array \`[{...}, {...}]\` or multiple actions per tick — return exactly ONE \`BotAction\` object.
- ❌ Returning \`null\`, \`undefined\`, or \`{}\` — use \`{type:'wait'}\` for a no-op.
- ❌ Reading \`s.world.width\` / \`s.world.height\` or hard-coding 2800/2100 to compute wrap manually — the local-frame deltas already handle the wrap.
- ❌ \`s.opponents.find(o => o.health > 0)\` — dead opponents are already filtered out.
- ❌ Arrow form \`const tick = (s) => {...}\` or renamed param \`function tick(state) {...}\` — signature MUST be exactly \`function tick(s) { ... }\`.`;

  const userPrompt = `Current mode: ${mode}${fuelBudget ? ` (fuel ceiling: ${fuelBudget}/tick)` : ''}${λ ? ` (weight: λ=${λ})` : ''}

== Best exemplar (priority_v0) ==
Score: ${bestK[0]?.fitness.fitnessScore?.toFixed(2) ?? 'N/A'}
Win rate: ${(bestK[0]?.fitness.winRate ?? 0) * 100}%
Avg fuel/tick: ${bestK[0]?.fitness.avgFuelPerTick?.toFixed(0) ?? 'N/A'}
Code:
\`\`\`js
${bestK[0]?.source ?? 'N/A'}
\`\`\`

== Second best exemplar (priority_v1) ==
Score: ${bestK[1]?.fitness.fitnessScore?.toFixed(2) ?? 'N/A'}
Win rate: ${(bestK[1]?.fitness.winRate ?? 0) * 100}%
Code:
\`\`\`js
${bestK[1]?.source ?? 'N/A'}
\`\`\`

== Reward Reflection ==
Win rate: ${(rewardReflection?.winRate ?? 0) * 100}%
Avg score: ${rewardReflection?.avgScore ?? 0}
Avg fuel/tick: ${rewardReflection?.avgFuelPerTick?.toFixed(0) ?? 0}

== Recent Failure Traces ==
${evaluationHistory || 'No failures in recent history'}

== Instructions ==
Write a NEW tick function that improves on the best exemplar. Pick ONE specific deficit in the exemplar and fix it concretely; don't bundle five vague ideas. Examples of concrete moves:
- The exemplar fires every tick → switch to fire-only-when-aim-error < 0.1 rad AND target within bullet range.
- The exemplar drifts off into a wall of asteroids → add a 150 px asteroid-radius repulsion vector mixed into desired heading.
- The exemplar never brakes → when speed > X and no enemy in front cone, rotate to retrograde and burn -1 thrust until speed drops.
- The exemplar gets ambushed at low HP → if health < 30, retreat away from the densest opponent cluster instead of engaging.
- The exemplar splits LARGE asteroids next to itself → keep ≥180 px stand-off from LARGE before firing.

DO NOT return code that is byte-identical or only cosmetically different from the exemplar (whitespace, comment, variable rename) — those mutations are discarded. The mutation must change observable behavior.

Return exactly one fenced code block, no other text:

\`\`\`js
function tick(s) {
  // your full implementation here
}
\`\`\``;

  return { system: systemPrompt, user: userPrompt };
}

/**
 * Mock mutator: deterministic source-level perturbations for offline runs.
 *
 * Activated by `LLM_MOCK=1` env var or `config.llmBaseUrl === 'mock'`.
 * Useful for:
 *   - integration tests (no live LLM)
 *   - smoke runs when the user's local oMLX server isn't up
 *   - benchmarking the harness loop without LLM latency
 *
 * The mutations are intentionally trivial (numeric tweaks, conditional
 * flips, comment additions) — they exercise the SEARCH/REPLACE pipeline
 * without trying to be smart.
 */
function mockMutate(source: string): { source: string; reason: string; blocks: SearchReplaceBlock[] } {
  const variants: Array<(s: string) => { newSource: string; reason: string; old?: string; nw?: string }> = [
    (s) => {
      const m = /< 200/.exec(s);
      if (m) {
        const idx = m.index;
        const newSource = s.slice(0, idx) + '< 250' + s.slice(idx + m[0].length);
        return { newSource, reason: 'extend engagement range from 200 to 250', old: '< 200', nw: '< 250' };
      }
      return { newSource: s, reason: 'no-op (no engagement-range pattern found)' };
    },
    (s) => {
      // Insert an early-exit when fuel is low.
      const m = /function tick\([^)]*\)\s*\{/.exec(s);
      if (!m) return { newSource: s, reason: 'no-op (no tick function found)' };
      const idx = m.index + m[0].length;
      const guard = `\n  if (s.ship && s.ship.fuel < 100) return { type: 'wait' };`;
      if (s.includes('s.ship.fuel < 100')) {
        return { newSource: s, reason: 'no-op (fuel guard already present)' };
      }
      const newSource = s.slice(0, idx) + guard + s.slice(idx);
      return { newSource, reason: 'add low-fuel-wait guard', old: m[0], nw: m[0] + guard };
    },
    (s) => {
      const m = /direction:\s*1/.exec(s);
      if (m) {
        const idx = m.index;
        const newSource = s.slice(0, idx) + 'direction: -1' + s.slice(idx + m[0].length);
        return { newSource, reason: 'flip rotation direction', old: 'direction: 1', nw: 'direction: -1' };
      }
      return { newSource: s, reason: 'no-op (no rotate-direction pattern found)' };
    },
  ];

  // Pseudo-random variant choice driven by source hash for determinism.
  let h = 0;
  for (let i = 0; i < source.length; i++) h = ((h << 5) - h + source.charCodeAt(i)) | 0;
  const variant = variants[Math.abs(h) % variants.length];
  const r = variant(source);

  const blocks: SearchReplaceBlock[] =
    r.old && r.nw
      ? [{ startLine: 0, endLine: 0, oldText: r.old, newText: r.nw }]
      : [];
  return { source: r.newSource, reason: `[mock] ${r.reason}`, blocks };
}

/** True when the harness should bypass live LLM and use the mock mutator. */
function isMockMode(config: HarnessConfig): boolean {
  if (process.env.LLM_MOCK === '1') return true;
  if (config.llmBaseUrl === 'mock') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Validation + threaded self-debug retry
//
// The LLM regularly emits "almost right" bot source: correct shape, but
// with hallucinated state fields (`s.ship.x` instead of `s.ship.pos.x`),
// wrong action shapes (`{type:'shoot'}`), arrow-function signatures, etc.
// Compiling-and-running such a bot fails *at evaluation time* (often
// silently — the bot just throws every tick), wasting eval time and
// producing zero-score garbage.
//
// `validateBotSource` runs cheap static checks (regex sniff + bundle) on
// every extracted function BEFORE it leaves the mutation pipeline. When
// it fails, the threaded mutation loop pushes the assistant turn + a
// correction request into the same conversation and asks the model to
// fix it. Threaded — not a fresh call — because LLMs repair their own
// output much more reliably when they can see what they actually wrote.
// ---------------------------------------------------------------------------

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

interface ValidationIssue {
  code: string;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; severity: 'parse' | 'shape' | 'compile'; issues: ValidationIssue[] };

/**
 * Regex sniffs for the hallucinations we have actually observed in
 * Qwen3.6-distill output. Each entry maps a pattern → a correction
 * message the LLM gets back. Order matters slightly: signature first
 * (everything else is moot if there's no function), then field shape,
 * then action shape.
 */
const HALLUCINATION_PATTERNS: Array<{ re: RegExp; code: string; message: string }> = [
  { re: /\bs\.ship\.x\b/,        code: 'flat-ship-x',  message: 'You wrote `s.ship.x` — that field does not exist. Use `s.ship.pos.x`.' },
  { re: /\bs\.ship\.y\b/,        code: 'flat-ship-y',  message: 'You wrote `s.ship.y` — use `s.ship.pos.y`.' },
  { re: /\bs\.ship\.vx\b/,       code: 'flat-ship-vx', message: 'You wrote `s.ship.vx` — use `s.ship.vel.x`.' },
  { re: /\bs\.ship\.vy\b/,       code: 'flat-ship-vy', message: 'You wrote `s.ship.vy` — use `s.ship.vel.y`.' },
  { re: /\bs\.ship\.hp\b/,       code: 'wrong-hp',     message: 'You wrote `s.ship.hp` — the field is `s.ship.health`.' },
  { re: /\bs\.ship\.heading\b/,  code: 'wrong-heading',message: 'You wrote `s.ship.heading` — the field is `s.ship.angle`.' },
  { re: /\bs\.ship\.rotation\b/, code: 'wrong-rotation', message: 'You wrote `s.ship.rotation` — the field is `s.ship.angle`.' },
  { re: /\bs\.me\b/,             code: 'fake-me',      message: 'You used `s.me` — only `s.ship` is your bot.' },
  { re: /\bs\.self\b/,           code: 'fake-self',    message: 'You used `s.self` — only `s.ship` is your bot.' },
  { re: /\bs\.enemies\b/,        code: 'fake-enemies', message: 'You used `s.enemies` — the field is `s.opponents`.' },
  { re: /\bs\.foes\b/,           code: 'fake-foes',    message: 'You used `s.foes` — the field is `s.opponents`.' },
  { re: /\bs\.rocks\b/,          code: 'fake-rocks',   message: 'You used `s.rocks` — the field is `s.asteroids`.' },
  { re: /\bs\.world\b/,          code: 'fake-world',   message: 'You referenced `s.world` — no such field. The local-frame deltas already handle wrap; do not recompute it.' },
  { re: /type\s*:\s*['"]move['"]/,        code: 'fake-move',  message: 'You returned `{type:"move"}` — that action does not exist. Use `{type:"thrust", direction: 1}`.' },
  { re: /type\s*:\s*['"]shoot['"]/,       code: 'fake-shoot', message: 'You returned `{type:"shoot"}` — the action is `{type:"fire"}`.' },
  { re: /type\s*:\s*['"]accelerate['"]/,  code: 'fake-accel', message: 'You returned `{type:"accelerate"}` — use `{type:"thrust", direction: 1}`.' },
  { re: /type\s*:\s*['"]brake['"]/,       code: 'fake-brake', message: 'You returned `{type:"brake"}` — use `{type:"thrust", direction: -1}`.' },
  { re: /type\s*:\s*['"]turn['"]/,        code: 'fake-turn',  message: 'You returned `{type:"turn"}` — the action is `{type:"rotate", direction: 1|-1}`.' },
  { re: /type\s*:\s*['"]thrust['"][\s\S]{0,80}?\bangle\s*:/m, code: 'thrust-angle', message: '`{type:"thrust", angle:...}` is invalid — thrust takes `direction: 1 | -1`, not angle. Aim by rotating first.' },
  { re: /type\s*:\s*['"]rotate['"][\s\S]{0,80}?\bangle\s*:/m, code: 'rotate-angle', message: '`{type:"rotate", angle:...}` is invalid — rotate takes `direction: 1 | -1`.' },
  { re: /type\s*:\s*['"]thrust['"][\s\S]{0,80}?\bpower\s*:/m, code: 'thrust-power', message: '`{type:"thrust", power:...}` is invalid — thrust has no power/magnitude field.' },
  { re: /type\s*:\s*['"]fire['"][\s\S]{0,80}?\btarget\s*:/m,  code: 'fire-target',  message: '`{type:"fire", target:...}` is invalid — fire shoots forward along `s.ship.angle`. Aim by rotating first.' },
];

/**
 * Validate an extracted bot source. Returns `{ok: true}` if it's safe to
 * feed to the evaluator, or `{ok: false}` with structured issues that can
 * be turned into a follow-up user message for the LLM.
 */
export function validateBotSource(source: string): ValidationResult {
  // 1. Function signature — must be exactly `function tick(s) {`. Arrow
  //    form, renamed param, etc. all break the contract.
  if (!/function\s+tick\s*\(\s*s\s*\)\s*\{/.test(source)) {
    return {
      ok: false,
      severity: 'parse',
      issues: [{
        code: 'no-signature',
        message: 'Your response had no parseable `function tick(s) { ... }` block. Re-emit your bot as exactly ONE fenced JavaScript code block (```js ... ```) containing exactly ONE complete `function tick(s) { ... }`. No prose outside the fence, no arrow form, no renamed parameter.',
      }],
    };
  }

  // 2. Hallucination sniff. Fast regex pass; collects ALL violations so
  //    the LLM gets a complete punch list, not a whack-a-mole.
  const issues: ValidationIssue[] = [];
  for (const p of HALLUCINATION_PATTERNS) {
    if (p.re.test(source)) issues.push({ code: p.code, message: p.message });
  }
  if (issues.length > 0) {
    return { ok: false, severity: 'shape', issues };
  }

  // 3. Compile. esbuild errors usually point at a line — quote enough
  //    for the model to locate the issue without flooding context.
  const bundled = bundle(source);
  if (bundled.startsWith(BUNDLE_ERROR_PREFIX)) {
    const err = bundled.slice(BUNDLE_ERROR_PREFIX.length).trim();
    return {
      ok: false,
      severity: 'compile',
      issues: [{
        code: 'compile-error',
        message: `Your bot does not compile. The bundler reported:\n${err.slice(0, 400)}\n\nPlease re-emit a syntactically-valid \`function tick(s) { ... }\`.`,
      }],
    };
  }

  return { ok: true };
}

/**
 * Stateless wrapper around the chat-completions endpoint. Threaded
 * conversations build the `messages` array progressively and call this
 * function for each turn; the LLM server itself is stateless, so the
 * conversation state lives only in our messages[].
 */
async function callLLMChat(
  messages: ChatMessage[],
  config: HarnessConfig,
  opts: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    /**
     * Optional `response_format` body field. When provided, sent to the
     * server alongside the messages so that JSON-shape enforcement kicks
     * in. Slice E callers compute this from the capability probe.
     */
    responseFormat?: unknown;
  } = {},
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
  try {
    const body: Record<string, unknown> = {
      model: config.llmModel,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 2000,
    };
    if (opts.responseFormat !== undefined) body.response_format = opts.responseFormat;
    const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`LLM call failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Pick a `response_format` for the structured-output mode the server
 * actually honors. Falls back to undefined (free-text) for `'none'`.
 *
 * Pass the schema envelope (e.g. `BotSubmissionResponseFormat`) directly;
 * the `'object'` path strips it down to `{type: 'json_object'}` because
 * the server can't enforce the schema itself but at least produces JSON.
 */
function responseFormatFor(
  caps: LLMCapabilities | null,
  schemaEnvelope: { type: 'json_schema'; json_schema: unknown },
): unknown | undefined {
  if (!caps) return undefined;
  switch (caps.structuredOutput) {
    case 'schema':
      return schemaEnvelope;
    case 'object':
      return { type: 'json_object' };
    case 'none':
    default:
      return undefined;
  }
}

/** Truncate a long LLM response for safe inclusion in a follow-up prompt. */
function snippetForFeedback(content: string, max: number = 600): string {
  if (content.length <= max) return content;
  const head = content.slice(0, Math.floor(max / 2));
  const tail = content.slice(-Math.floor(max / 2));
  return `${head}\n... [${content.length - max} bytes elided] ...\n${tail}`;
}

/**
 * Call the LLM (or mock mutator) to generate a mutation plan for a bot.
 *
 * In live mode, sends the prompt to the configured chat-completions
 * endpoint and parses SEARCH/REPLACE blocks from the response.
 * In mock mode (LLM_MOCK=1 or llmBaseUrl='mock'), produces a deterministic
 * source-level perturbation without any network call.
 *
 * Live calls have a 60-second hard timeout via AbortController.
 */
export async function generateMutation(
  source: string,
  context: MutationContext,
  config: HarnessConfig,
): Promise<MutationPlan> {
  if (isMockMode(config)) {
    const m = mockMutate(source);
    return {
      shipId: '',
      source: m.source,
      isImprovement: m.blocks.length > 0,
      reason: m.reason,
      searchReplaceDiff: m.blocks,
    };
  }

  const promptText = buildMutationPrompt(context);
  // promptText is now an object { system, user } — unwrap it
  const promptObj = typeof promptText === 'string' ? { system: '', user: promptText } : promptText;

  // 180-second timeout for the local LLM. Qwen distill models are slow
  // (~30-90s per generation typical, longer when warm-up is needed). The
  // earlier 60s was killing slow-but-successful responses.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180_000);

  const started = Date.now();
  logger.info(
    {
      bestShipId: context.bestK[0]?.shipId,
      mode: context.mode,
      sourceBytes: source.length,
    },
    'mutation: LLM call started',
  );

  try {
    const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: config.llmModel,
        messages: [
          { role: 'system', content: promptObj.system },
          { role: 'user', content: promptObj.user },
        ],
        temperature: 0.7,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`LLM call failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content ?? '';
    const elapsedMs = Date.now() - started;

    if (!content) {
      logger.warn({ elapsedMs }, 'mutation: LLM returned empty content');
      return {
        shipId: '',
        source,
        isImprovement: false,
        reason: 'LLM returned empty response',
        searchReplaceDiff: [],
      };
    }

    // Whole-function mutation: extract a complete `function tick(s) {...}`
    // body from the response. The model may wrap it in markdown fences,
    // emit prose around it, or return multiple variants — we take the
    // first valid one. Search/replace diff format was retired because
    // (Qwen3.6-distill style) models don't reliably emit the literal
    // tags we used to look for.
    const functions = extractTickFunctions(content);
    const newSource = functions.length > 0 ? functions[0] : source;
    const applied = newSource !== source;

    // When the parser finds 0 functions in a non-trivial response, log a
    // head+tail snippet so we can see what shape the model actually emitted
    // (arrow form? wrong signature? prose with no code? truncation?).
    const diagnostic = functions.length === 0 && content.length > 100
      ? {
          head: content.slice(0, 240),
          tail: content.slice(-160),
        }
      : undefined;

    logger.info(
      {
        elapsedMs,
        functionsFound: functions.length,
        contentBytes: content.length,
        newBytes: newSource.length,
        applied,
        ...(diagnostic ? { responseSnippet: diagnostic } : {}),
      },
      'mutation: LLM call complete',
    );

    return {
      shipId: '',
      source: newSource,
      isImprovement: applied,
      reason: applied
        ? `whole-function rewrite (${newSource.length} bytes)`
        : functions.length === 0
          ? 'LLM response contained no tick(s) function'
          : 'LLM returned identical source',
      // No more SEARCH/REPLACE blocks — kept as empty array for callers
      // that still consume the field shape.
      searchReplaceDiff: [],
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Generate a mutation with threaded self-debug retries.
 *
 * In live mode, this maintains a single chat conversation with the LLM:
 * each call appends the assistant's response to `messages[]` and, on
 * validation failure, appends a structured correction request so the
 * model can fix its own broken output rather than starting from scratch.
 *
 * The conversation isolation is enforced: cross-mutation calls never share
 * messages[]; each bot gets its own fresh thread. The threading only
 * matters *within* a single mutation attempt's debug loop.
 *
 * In mock mode (LLM_MOCK=1 or llmBaseUrl='mock'), uses the legacy
 * single-shot mock mutator + compile-retry path so tests stay
 * deterministic.
 */
export async function generateMutationWithRetry(
  source: string,
  context: MutationContext,
  config: HarnessConfig,
  maxRetries: number = 3,
): Promise<MutationPlan> {
  if (isMockMode(config)) {
    return generateMutationWithRetryMock(source, context, config, maxRetries);
  }

  // Probe the server's structured-output capabilities once; subsequent
  // calls reuse the cached result. Determines whether we send
  // `response_format: json_schema`, `json_object`, or nothing.
  const caps = await getOrProbeCapabilities(config);
  const responseFormat = responseFormatFor(caps, BotSubmissionResponseFormat);

  // Build prompts. For the 'none' capability path we still want the
  // user prompt to ask for fenced output explicitly (the schema isn't
  // there to coerce the model toward JSON).
  const prompts = caps.structuredOutput === 'none'
    ? buildMutationPromptFreeText(context)
    : buildMutationPrompt(context);
  const messages: ChatMessage[] = [
    { role: 'system', content: prompts.system },
    { role: 'user', content: prompts.user },
  ];

  let lastReason = 'no LLM response';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Network retry with exponential backoff. The LLM box drops
    // connections under load — we re-establish without resetting the
    // conversation, so the model never knows there was a network blip.
    let content = '';
    let networkErr: Error | null = null;
    for (let netTry = 0; netTry < 3; netTry++) {
      try {
        const started = Date.now();
        logger.info(
          {
            attempt: attempt + 1,
            maxAttempts: maxRetries + 1,
            msgCount: messages.length,
            sourceBytes: source.length,
            structuredMode: caps.structuredOutput,
          },
          'mutation: LLM call started',
        );
        content = await callLLMChat(messages, config, {
          temperature: 0.7,
          maxTokens: 2000,
          timeoutMs: 180_000,
          responseFormat,
        });
        logger.info(
          {
            attempt: attempt + 1,
            elapsedMs: Date.now() - started,
            contentBytes: content.length,
          },
          'mutation: LLM call complete',
        );
        networkErr = null;
        break;
      } catch (err) {
        networkErr = err as Error;
        const backoffMs = 500 * Math.pow(2, netTry);
        logger.warn(
          { netTry: netTry + 1, err: networkErr.message, backoffMs },
          'mutation: network error — retrying',
        );
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    if (networkErr) {
      logger.warn(
        { err: networkErr.message },
        'mutation: LLM unreachable after retries — returning original source',
      );
      return {
        shipId: '',
        source,
        isImprovement: false,
        reason: `LLM unreachable: ${networkErr.message}`,
        searchReplaceDiff: [],
      };
    }

    if (!content) {
      lastReason = 'empty response';
      messages.push({ role: 'assistant', content: '' });
      messages.push({
        role: 'user',
        content: 'You returned an empty response. Please emit your bot as exactly one fenced JavaScript code block containing exactly one complete `function tick(s) { ... }`.',
      });
      continue;
    }

    // Record the assistant's turn so the next correction request lands
    // in a threaded conversation, not a fresh call.
    messages.push({ role: 'assistant', content });

    // Extract the bot source. With structured output on, the response is
    // JSON matching `BotSubmissionSchema` — read `.source` directly. The
    // schema-pattern check already enforced the function signature at
    // decode time, so this path almost never falls through to extraction.
    // The 'none' fallback path uses the regex extractor.
    let newSource: string | null = null;
    let strategyNote: string | undefined = undefined;
    if (caps.structuredOutput !== 'none') {
      const parsed = parseSchemaResponse(BotSubmissionSchema, content);
      if (parsed.ok && parsed.data) {
        newSource = parsed.data.source;
        strategyNote = parsed.data.strategy;
      } else {
        lastReason = `schema validation failed: ${parsed.issues.slice(0, 3).join('; ')}`;
        logger.warn(
          {
            attempt: attempt + 1,
            contentBytes: content.length,
            issues: parsed.issues,
            head: content.slice(0, 240),
          },
          'mutation: schema parse failed — requesting fix',
        );
        messages.push({
          role: 'user',
          content: `Your previous response did not match the response schema. Issues:\n\n${parsed.issues.map((i) => `- ${i}`).join('\n')}\n\nReturn ONE JSON object exactly matching: \`{ "source": "function tick(s) { ... }", "strategy": "<one sentence>" }\`. No prose outside the JSON.`,
        });
        continue;
      }
    } else {
      const functions = extractTickFunctions(content);
      if (functions.length === 0) {
        lastReason = 'no function block in response';
        logger.warn(
          {
            attempt: attempt + 1,
            contentBytes: content.length,
            head: content.slice(0, 240),
            tail: content.slice(-160),
          },
          'mutation: parser found no tick(s) function — requesting re-emit',
        );
        messages.push({
          role: 'user',
          content: `Your previous response contained no parseable \`function tick(s) { ... }\` block. Here is what you returned:\n\n${snippetForFeedback(content)}\n\nPlease re-emit your bot as exactly ONE fenced JavaScript code block (\`\`\`js ... \`\`\`) containing exactly ONE complete \`function tick(s) { ... }\`. No prose outside the fence.`,
        });
        continue;
      }
      newSource = functions[0];
    }

    // Defensive — should always have newSource at this point, but the
    // type system can't quite see that.
    if (newSource === null) {
      lastReason = 'newSource was null (unexpected)';
      continue;
    }

    // Identical source means the model returned a copy — legitimate
    // no-op mutation, but not a retry candidate. Accept and move on.
    if (newSource === source) {
      logger.info(
        { attempt: attempt + 1 },
        'mutation: identical source returned — accepting as no-op',
      );
      return {
        shipId: '',
        source,
        isImprovement: false,
        reason: 'LLM returned identical source',
        searchReplaceDiff: [],
      };
    }

    const validation = validateBotSource(newSource);
    if (validation.ok) {
      logger.info(
        {
          attempt: attempt + 1,
          newBytes: newSource.length,
          strategy: strategyNote,
        },
        'mutation: validation passed',
      );
      const sizeNote = `${newSource.length} bytes${attempt > 0 ? `, repaired after ${attempt} retry${attempt > 1 ? 'ies' : 'y'}` : ''}`;
      const reason = strategyNote
        ? `${strategyNote} [${sizeNote}]`
        : `whole-function rewrite (${sizeNote})`;
      return {
        shipId: '',
        source: newSource,
        isImprovement: true,
        reason,
        searchReplaceDiff: [],
      };
    }

    // Validation failed — push correction request into the SAME thread.
    lastReason = `validation [${validation.severity}]: ${validation.issues.map((i) => i.code).join(', ')}`;
    logger.warn(
      {
        attempt: attempt + 1,
        severity: validation.severity,
        issues: validation.issues.map((i) => i.code),
      },
      'mutation: validation failed — requesting fix in same conversation',
    );
    const issueList = validation.issues.map((i) => `- ${i.message}`).join('\n');
    messages.push({
      role: 'user',
      content: `Your previous bot didn't pass validation. Issues:\n\n${issueList}\n\nPlease emit a CORRECTED complete \`function tick(s) { ... }\` in one fenced JavaScript block. Fix every issue listed above. Keep the rest of the bot's logic intact.`,
    });
  }

  logger.warn(
    { maxRetries, lastReason, msgCount: messages.length },
    'mutation: max retries exhausted — returning original source',
  );
  return {
    shipId: '',
    source,
    isImprovement: false,
    reason: lastReason.includes('compile')
      ? `compile failed after ${maxRetries + 1} attempts: ${lastReason}`
      : `max retries exhausted: ${lastReason}`,
    searchReplaceDiff: [],
  };
}

/**
 * Legacy mock-mode retry path. Kept so the mock-LLM tests stay
 * deterministic — the threaded conversation pattern only makes sense
 * against a real LLM that can actually fix its own output.
 */
async function generateMutationWithRetryMock(
  source: string,
  context: MutationContext,
  config: HarnessConfig,
  maxRetries: number,
): Promise<MutationPlan> {
  let attempt = 0;
  let history = context.evaluationHistory ?? '';
  while (true) {
    const ctxAttempt: MutationContext = { ...context, evaluationHistory: history };
    const plan = await generateMutation(source, ctxAttempt, config);
    const bundled = bundle(plan.source);
    if (!bundled.startsWith(BUNDLE_ERROR_PREFIX)) return plan;
    if (attempt >= maxRetries) {
      return {
        shipId: plan.shipId,
        source,
        isImprovement: false,
        reason: `compile failed after ${maxRetries} retries: ${bundled.slice(0, 100)}`,
        searchReplaceDiff: [],
      };
    }
    history = `${history}\n[attempt ${attempt + 1} compile error] ${bundled}`;
    attempt += 1;
  }
}

/**
 * Parse SEARCH/REPLACE blocks from LLM output.
 */
function parseSearchReplaceBlocks(content: string): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  const lines = content.split('\n');
  let inSearch = false;
  let inReplace = false;
  let searchLines: string[] = [];
  let replaceLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes('<SEARCH>')) {
      inSearch = true;
      inReplace = false;
      searchLines = [];
      continue;
    }

    if (line.includes('<REPLACE>')) {
      inSearch = false;
      inReplace = true;
      replaceLines = [];
      continue;
    }

    if (line.includes('</SEARCH>') || line.includes('</REPLACE>')) {
      inSearch = false;
      inReplace = false;

      if (searchLines.length > 0 && replaceLines.length > 0) {
        blocks.push({
          startLine: 0,
          endLine: searchLines.length,
          oldText: searchLines.join('\n'),
          newText: replaceLines.join('\n'),
        });
      }
      searchLines = [];
      replaceLines = [];
      continue;
    }

    if (inSearch) searchLines.push(line);
    if (inReplace) replaceLines.push(line);
  }

  return blocks;
}

/**
 * Apply a single SEARCH/REPLACE block to source code.
 */
function applyBlock(source: string, block: SearchReplaceBlock): string {
  const lines = source.split('\n');
  const startIdx = Math.max(0, block.startLine - 1);
  const endIdx = Math.min(lines.length, block.endLine);

  // Find the matching lines
  const targetText = lines.slice(startIdx, endIdx).join('\n');

  if (targetText === block.oldText) {
    // Exact match — replace
    const before = lines.slice(0, startIdx).join('\n');
    const after = lines.slice(endIdx).join('\n');
    return before + '\n' + block.newText + (after.startsWith('\n') ? '' : '\n') + after;
  }

  const oldLineCount = block.oldText.split('\n').length;
  for (let i = 0; i <= lines.length - oldLineCount; i++) {
    const chunk = lines.slice(i, i + oldLineCount).join('\n');
    if (chunk === block.oldText) {
      const before = lines.slice(0, i).join('\n');
      const after = lines.slice(i + oldLineCount).join('\n');
      return before + '\n' + block.newText + (after.startsWith('\n') ? '' : '\n') + after;
    }
  }

  logger.warn({ block }, 'SEARCH/REPLACE block did not match — skipping');
  return source;
}

// ---------------------------------------------------------------------------
// Diverse initial population — Cartesian profile sampling
// ---------------------------------------------------------------------------

/**
 * Behavioral profile axes used to enumerate initial-population diversity.
 *
 * Each value across all axes is a distinct *cell* in the joint behavioral
 * space. We compute the Cartesian product (3·3·4·3·3 = 324 combinations),
 * sample `count` of them deterministically from a seeded PRNG, and ask the
 * LLM to fill each cell with a `function tick(s)` body. The LLM doesn't
 * pick the profile — we do — so its taste can't collapse the diversity.
 */
const PROFILE_AXES = {
  aggression: ['passive', 'opportunistic', 'hyperactive'] as const,
  target: ['asteroids', 'ships', 'mixed'] as const,
  movement: ['stationary', 'orbital', 'erratic', 'linear-drift'] as const,
  range: ['sniper', 'mid', 'brawler'] as const,
  reverse: ['never', 'panic-only', 'heavy'] as const,
};

export type BehaviorProfile = {
  aggression: typeof PROFILE_AXES.aggression[number];
  target: typeof PROFILE_AXES.target[number];
  movement: typeof PROFILE_AXES.movement[number];
  range: typeof PROFILE_AXES.range[number];
  reverse: typeof PROFILE_AXES.reverse[number];
};

/** All 324 distinct profiles. Deterministic order. */
function enumerateProfiles(): BehaviorProfile[] {
  const profiles: BehaviorProfile[] = [];
  for (const aggression of PROFILE_AXES.aggression) {
    for (const target of PROFILE_AXES.target) {
      for (const movement of PROFILE_AXES.movement) {
        for (const range of PROFILE_AXES.range) {
          for (const reverse of PROFILE_AXES.reverse) {
            profiles.push({ aggression, target, movement, range, reverse });
          }
        }
      }
    }
  }
  return profiles;
}

/** Deterministic Fisher-Yates using a seeded LCG (avoid pulling in SeededRNG here). */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = (seed | 0) || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) | 0;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Sample `count` profiles deterministically from the 324 Cartesian cells. */
export function sampleProfiles(count: number, seed = 1): BehaviorProfile[] {
  const all = enumerateProfiles();
  if (count >= all.length) return all;
  return seededShuffle(all, seed).slice(0, count);
}

/** Format a profile as a short tag for prompts and IDs. */
function profileTag(p: BehaviorProfile, index: number): string {
  return `seed-${String(index).padStart(3, '0')}-${p.aggression}-${p.target}-${p.movement}-${p.range}-${p.reverse}`;
}

const DIVERSE_SYSTEM_PROMPT = `You are an expert JavaScript programmer specialising in game AI.

You will receive a list of N distinct *behavioural profiles* for an 8-player free-for-all Asteroids-like arena. For each profile you must produce one complete \`function tick(s)\` body that visibly implements that profile's strategy.

BotState shape — THIS IS THE EXACT OBJECT \`s\`. Memorise it. Every field name here is real; anything else is wrong:
\`\`\`ts
type BotState = {
  tick: number,
  ship: {
    pos:   { x: number, y: number },   // ABSOLUTE wrapped position. NOT s.ship.x !
    vel:   { x: number, y: number },
    angle: number,                      // radians
    health: number,                     // 0..100
    fuel:   number,
    score:  number
  },
  opponents: Array<{ id, pos: {x,y}, vel: {x,y}, angle, health }>,
  asteroids: Array<{ id, pos: {x,y}, vel: {x,y}, radius, tier: 'LARGE'|'MEDIUM'|'SMALL' }>,
  bullets:   Array<{ id, pos: {x,y}, vel: {x,y}, ownerId }>
};
\`\`\`

Action type — the function returns EXACTLY ONE of these per tick:
\`\`\`ts
type BotAction =
  | { type: 'thrust'; direction: 1 | -1 }
  | { type: 'rotate'; direction: 1 | -1 }
  | { type: 'fire' }
  | { type: 'wait' };
\`\`\`

Arena facts:
- World is 2800×2100 px, toroidal (wraps at edges).
- Ship-relative thrust: \`{type:'thrust', direction: 1}\` = forward along \`s.ship.angle\`; \`direction:-1\` = retrograde.
- \`{type:'rotate', direction:1|-1}\` is an angular impulse with natural damping.
- \`{type:'fire'}\` shoots forward; bullets travel ~1600 px before despawning. 3 bullets per ship max.
- Asteroids: LARGE → splits to 2 MEDIUM → 2 SMALL → destroyed. Smalls are worth the most points.
- LARGE asteroid collision = instant kill from full HP. Keep stand-off from LARGE.
- Opponent/asteroid/bullet \`.pos\` is **already shifted into the bot's local toroidal frame**, so \`dx = o.pos.x - s.ship.pos.x\` is the shortest-path signed delta even across the wrap. Don't recompute the wrap.
- Sensor range 600 px. Dead opponents are filtered out.

DON'T (these are LLM hallucinations we've actually seen — every one is INVALID):
- ❌ \`s.ship.x\`, \`s.ship.y\` — use \`s.ship.pos.x\`, \`s.ship.pos.y\`.
- ❌ \`s.ship.vx\`, \`s.ship.vy\` — use \`s.ship.vel.x\`, \`s.ship.vel.y\`.
- ❌ \`s.opponents[i].x\`, \`s.asteroids[i].x\` — use \`.pos.x\` / \`.pos.y\` on every entity.
- ❌ \`s.me\`, \`s.self\`, \`s.player\`, \`s.enemies\`, \`s.foes\`, \`s.rocks\` — none exist.
- ❌ \`s.ship.heading\`, \`s.ship.rotation\`, \`s.ship.hp\` — the fields are \`angle\` and \`health\`.
- ❌ \`{type:'thrust', angle: ...}\`, \`{type:'thrust', power: ...}\` — only \`direction: 1 | -1\`.
- ❌ \`{type:'rotate', angle: ...}\`, \`{type:'fire', target: ...}\` — neither shape exists.
- ❌ \`{type:'move'}\`, \`{type:'shoot'}\`, \`{type:'accelerate'}\`, \`{type:'brake'}\` — not action types.
- ❌ Returning arrays or multiple actions; return \`null\` / \`undefined\`. Use \`{type:'wait'}\` for no-op.
- ❌ Arrow form \`const tick = (s) => {...}\` — must be \`function tick(s) { ... }\`.

Output format — exactly one fenced JSON array. No prose:

\`\`\`json
[
  { "id": "seed-001-...", "source": "function tick(s) { /* full body */ }" },
  ...
]
\`\`\`

Each \`source\` must:
- Start with \`function tick(s) {\` and end with \`}\`.
- Be syntactically valid plain JavaScript (no imports, no TypeScript).
- Use the action types above (no \`thrust\` with \`angle\` — that shape was removed).
- Visibly implement the requested profile. The axes map to observable behavior — every bot you write should obey ITS row:
  - \`aggression\`: passive = rare \`fire\` (≤1 in 10 ticks when in range); opportunistic = fire only when aim-error < 0.15 rad; hyperactive = fire whenever a target is in front cone.
  - \`target\`: asteroids = pick the nearest asteroid; ships = pick the nearest opponent; mixed = whichever is closer.
  - \`movement\`: stationary = no thrust ever; orbital = rotate to lateral, thrust forward 1 of every 3 ticks; erratic = use \`Math.random()\` to choose actions; linear-drift = one initial burn, then coast.
  - \`range\`: sniper = require dist ≥ 350 px before firing AND aim-error < 0.05; mid = fire between 150–400 px; brawler = thrust toward target and fire when dist < 200 px.
  - \`reverse\`: never = direction always 1 if you thrust; panic-only = direction:-1 only when health < 30; heavy = direction:-1 whenever speed > some bound or to back off from asteroids.
- Be **structurally distinct** from the other bots — different control flow, different thresholds, different idioms. Identical bodies with renamed variables count as DUPLICATES and will be dropped.`;

function buildDiverseUserPrompt(profiles: BehaviorProfile[]): string {
  const enumerated = profiles.map((p, i) => {
    const id = profileTag(p, i + 1);
    return `${i + 1}. id=${id}\n   profile=${JSON.stringify(p)}`;
  }).join('\n');
  return `Produce ${profiles.length} bot functions, one per profile below. Return as a single fenced JSON array as specified.

Profiles:
${enumerated}`;
}

export interface DiverseSeed {
  id: string;
  profile: BehaviorProfile;
  source: string;
}

/**
 * Ask the LLM to generate a diverse initial population: `count` distinct
 * bots, one per pre-computed behavioral profile.
 *
 * Threaded retry: if the response fails to parse OR yields zero valid
 * bots after compile-check, the loop pushes the assistant's broken
 * response + a structured correction request back into the SAME
 * conversation and asks the model to fix it. Only the live-LLM path is
 * threaded — mock mode short-circuits with synthetic seeds.
 *
 * Returns the union of valid bots across attempts (i.e., if attempt 1
 * gives 10 valid + 14 invalid and we re-prompt, we keep the 10 and ask
 * for the 14 to be reissued).
 */
export async function generateDiverseSeeds(
  config: HarnessConfig,
  count: number,
  seed = 1,
  maxRetries: number = 2,
): Promise<DiverseSeed[]> {
  if (count <= 0) return [];
  const profiles = sampleProfiles(count, seed);

  // Mock-mode fallback: synthesize hardcoded bots tagged with profile.
  if (isMockMode(config)) {
    return profiles.map((p, i) => ({
      id: profileTag(p, i + 1),
      profile: p,
      source: `function tick(s) { return { type: '${p.aggression === 'hyperactive' ? 'fire' : 'wait'}' }; }`,
    }));
  }

  // Capability probe. For diverse-seed we DELIBERATELY downgrade `'schema'`
  // to `'object'` mode: grammar-constrained decoding on a nested array of
  // schema-validated strings (with regex `pattern` enforcement on each
  // source) is too slow at batch size — generating 12+ bots that way
  // routinely exceeds the 180s timeout. With `'object'` mode the server
  // only enforces "valid JSON," the model decodes at full speed, and our
  // validator + threaded-retry handle any per-bot shape issues. Mutation
  // calls (single bot) stay on `'schema'` mode where the pattern cost is
  // amortized across one regex.
  const caps = await getOrProbeCapabilities(config);
  let effectiveMode: 'object' | 'none';
  if (caps.structuredOutput === 'schema' || caps.structuredOutput === 'object') {
    effectiveMode = 'object';
  } else {
    effectiveMode = 'none';
  }
  const responseFormat = effectiveMode === 'object' ? { type: 'json_object' as const } : undefined;

  const userPrompt = effectiveMode !== 'none'
    ? `Produce ${profiles.length} distinct bot strategies, one per profile below. Return a single JSON object exactly matching this shape (no prose outside the JSON):

\`\`\`json
{
  "bots": [
    { "id": "seed-001-...", "source": "function tick(s) { ...full body... }", "strategy": "one-sentence summary" }
  ]
}
\`\`\`

The id field MUST match exactly one of the ids listed below. Each source must be a complete \`function tick(s) { ... }\` body.

Profiles:
${profiles.map((p, i) => `${i + 1}. id=${profileTag(p, i + 1)}\n   profile=${JSON.stringify(p)}`).join('\n')}`
    : buildDiverseUserPrompt(profiles);

  const messages: ChatMessage[] = [
    { role: 'system', content: BOT_AUTHOR_MANUAL },
    { role: 'user', content: userPrompt },
  ];

  // Accumulate valid bots across attempts. The id→profile map tracks
  // which profiles still need a bot, so re-prompts can ask specifically
  // for the missing ones rather than re-rolling the whole batch.
  const validById = new Map<string, DiverseSeed>();
  const expectedIds = profiles.map((p, i) => profileTag(p, i + 1));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let content = '';
    try {
      content = await callLLMChat(messages, config, {
        temperature: 0.9,
        maxTokens: 32000,
        // 10-minute ceiling — Qwen distill generates ~10 tokens/sec at
        // these prompt sizes; 24 bot bodies (~20k chars total = ~5k
        // tokens) takes ~8min in the worst case. Live-measured at 185s
        // for 12 bots in object mode (2026-05-11), scaling roughly
        // linearly. The retry budget is 2 attempts, so the absolute
        // worst case is ~30min — but only when the model is severely
        // misbehaving, in which case we want to fail loudly anyway.
        timeoutMs: 600_000,
        responseFormat,
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, attempt: attempt + 1 },
        'generateDiverseSeeds: LLM call failed',
      );
      break;
    }

    if (!content) {
      logger.warn({ attempt: attempt + 1 }, 'generateDiverseSeeds: empty content');
      messages.push({ role: 'assistant', content: '' });
      messages.push({
        role: 'user',
        content: 'You returned an empty response. Please emit the JSON array of bot definitions as specified.',
      });
      continue;
    }

    messages.push({ role: 'assistant', content });

    // When structured output is active, parse the response as the
    // DiverseSeedBatch schema. Falls back to the legacy extractor for
    // the 'none' capability path.
    let seeds: DiverseSeed[] = [];
    if (effectiveMode !== 'none') {
      const parsed = parseSchemaResponse(DiverseSeedBatchSchema, content);
      if (parsed.ok && parsed.data) {
        // Map schema entries back to profile-tagged DiverseSeed objects.
        const profileByIdLocal = new Map<string, BehaviorProfile>();
        profiles.forEach((p, i) => profileByIdLocal.set(profileTag(p, i + 1), p));
        for (const entry of parsed.data.bots) {
          const profile = profileByIdLocal.get(entry.id);
          if (!profile) {
            logger.warn(
              { id: entry.id },
              'diverse seed dropped (id did not match any requested profile)',
            );
            continue;
          }
          seeds.push({ id: entry.id, profile, source: entry.source });
        }
      } else {
        logger.warn(
          {
            attempt: attempt + 1,
            issues: parsed.issues.slice(0, 5),
            head: content.slice(0, 240),
          },
          'diverse seed: schema parse failed — falling back to legacy parser',
        );
        // Fall through to the legacy parser as a defense-in-depth move:
        // some servers honor the schema flag but the model still emits
        // a slightly off-schema response (e.g., array instead of object).
        seeds = parseDiverseSeedResponse(content, profiles);
      }
    } else {
      seeds = parseDiverseSeedResponse(content, profiles);
    }
    let newlyValid = 0;
    for (const s of seeds) {
      if (validById.has(s.id)) continue; // already have a working bot for this profile
      const v = validateBotSource(s.source);
      if (!v.ok) {
        logger.warn(
          {
            id: s.id,
            severity: v.severity,
            issues: v.issues.map((i) => i.code),
          },
          'diverse seed dropped (validation failed)',
        );
        continue;
      }
      validById.set(s.id, s);
      newlyValid++;
    }

    const missing = expectedIds.filter((id) => !validById.has(id));
    logger.info(
      {
        attempt: attempt + 1,
        requested: count,
        parsedThisAttempt: seeds.length,
        validNewThisAttempt: newlyValid,
        validTotal: validById.size,
        missing: missing.length,
      },
      'generateDiverseSeeds attempt complete',
    );

    if (missing.length === 0) break;
    if (attempt === maxRetries) break;

    // Re-prompt for the missing slots only. Keep the same conversation
    // so the model sees its prior output + the specific gap to fill.
    const missingProfiles = profiles
      .map((p, i) => ({ p, id: profileTag(p, i + 1) }))
      .filter(({ id }) => !validById.has(id));
    const missingList = missingProfiles
      .map(({ p, id }) => `${id}: ${JSON.stringify(p)}`)
      .join('\n');

    const feedback = seeds.length === 0
      ? `Your previous response yielded ZERO valid bots — the parser couldn't find a JSON array, function blocks, or all entries failed validation. Snippet of what you returned:\n\n${snippetForFeedback(content)}\n\nPlease emit a fenced JSON array \`[{ "id": "...", "source": "function tick(s) { ... }" }, ...]\` with exactly ${missing.length} entries, one per id below.`
      : `Your previous response gave ${newlyValid} valid bots out of ${count} requested. The following profile slots are still missing or failed validation:\n\n${missingList}\n\nPlease emit a new fenced JSON array containing ONLY those ${missing.length} missing bots, with corrected sources. Common failures to avoid: \`s.ship.x\` (use \`s.ship.pos.x\`), \`{type:"shoot"}\` (use \`{type:"fire"}\`), and arrow-form \`const tick = (s) =>\`.`;

    messages.push({ role: 'user', content: feedback });
  }

  const valid = Array.from(validById.values());
  logger.info(
    {
      requested: count,
      valid: valid.length,
      missing: count - valid.length,
      attempts: messages.filter((m) => m.role === 'assistant').length,
    },
    'generateDiverseSeeds complete',
  );
  return valid;
}

/**
 * Extract diverse seed bots from the LLM response. Uses a fallback chain:
 *
 *   1. JSON array `[{id, source}, ...]` (the format we ask for).
 *   2. Multiple ```json or ```javascript fences each containing one bot.
 *   3. Bare `function tick(s) { ... }` blocks anywhere in the prose.
 *
 * Strategy 3 means the user gets *something* useful even when the model
 * ignores the JSON contract entirely (which Qwen3.6-distill does in
 * practice — it likes to emit markdown code blocks per profile).
 */
function parseDiverseSeedResponse(
  content: string,
  profiles: BehaviorProfile[],
): DiverseSeed[] {
  const profileById = new Map<string, BehaviorProfile>();
  const profileByIndex: BehaviorProfile[] = [];
  profiles.forEach((p, i) => {
    profileById.set(profileTag(p, i + 1), p);
    profileByIndex.push(p);
  });

  // Strategy 1: parse the first top-level [...] as JSON.
  const jsonHit = tryParseJsonArray(content);
  if (jsonHit.length > 0) {
    const seeds: DiverseSeed[] = [];
    for (const item of jsonHit) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as { id?: unknown; source?: unknown };
      const id = typeof obj.id === 'string' ? obj.id : null;
      const source = typeof obj.source === 'string' ? obj.source : null;
      if (!id || !source) continue;
      const profile = profileById.get(id);
      if (!profile) continue;
      seeds.push({ id, profile, source });
    }
    if (seeds.length > 0) {
      logger.info({ strategy: 'json-array', count: seeds.length }, 'parsed diverse seed response');
      return seeds;
    }
  }

  // Strategy 2 + 3: extract `function tick(s) {...}` blocks anywhere in
  // the response (inside fences, in prose, doesn't matter). Pair each
  // extracted function with a profile by ORDER of appearance — the LLM
  // was given a numbered list, so its outputs are usually in that order.
  const functions = extractTickFunctions(content);
  if (functions.length === 0) {
    logger.warn(
      {
        contentBytes: content.length,
        head: content.slice(0, 320),
        tail: content.slice(-200),
      },
      'diverse seed response: no JSON array AND no function blocks',
    );
    return [];
  }

  const seeds: DiverseSeed[] = [];
  for (let i = 0; i < functions.length && i < profileByIndex.length; i++) {
    const profile = profileByIndex[i];
    seeds.push({
      id: profileTag(profile, i + 1),
      profile,
      source: functions[i],
    });
  }
  logger.info(
    { strategy: 'function-blocks', count: seeds.length, requested: profiles.length },
    'parsed diverse seed response',
  );
  return seeds;
}

/**
 * Find every `function tick(s) { ... }` body in the text by balanced-brace
 * scanning. Tolerates whatever wraps them (JSON string escapes get
 * unescaped; markdown fences and prose are ignored).
 */
export function extractTickFunctions(content: string): string[] {
  const out: string[] = [];
  // Use a regex to find each `function tick` start position. The body
  // extends to the matching closing brace (balanced-brace scan since
  // tick bodies routinely contain nested {}).
  //
  // The scanner is comment-aware: //-line and /* block */ comments are
  // skipped wholesale so an apostrophe inside a comment (e.g. `we're`)
  // doesn't trip string-mode and gobble the rest of the function.
  const startRe = /function\s+tick\s*\(\s*[a-zA-Z_$][\w$]*\s*\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(content)) !== null) {
    const startIdx = m.index;
    const openBraceIdx = startIdx + m[0].length - 1; // index of `{`
    let depth = 1;
    let i = openBraceIdx + 1;
    let inString: '"' | "'" | '`' | null = null;
    let inLineComment = false;
    let inBlockComment = false;
    let escape = false;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      const next = content[i + 1];
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
      } else if (inBlockComment) {
        if (ch === '*' && next === '/') {
          inBlockComment = false;
          i++; // consume '/' too
        }
      } else if (inString) {
        if (escape) { escape = false; }
        else if (ch === '\\') { escape = true; }
        else if (ch === inString) { inString = null; }
      } else {
        // Outside string/comment: detect comment starts BEFORE quote starts,
        // since `/*` and `//` are not valid inside identifiers and trump
        // any concurrent character classification.
        if (ch === '/' && next === '/') {
          inLineComment = true;
          i++; // skip the second '/'
        } else if (ch === '/' && next === '*') {
          inBlockComment = true;
          i++; // skip the '*'
        } else if (ch === '"' || ch === "'" || ch === '`') {
          inString = ch;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
        }
      }
      i++;
    }
    if (depth !== 0) continue; // unmatched — skip
    let raw = content.slice(startIdx, i);
    // If we extracted from a JSON-escaped string field, undo common escapes.
    if (raw.includes('\\n') || raw.includes('\\"') || raw.includes("\\'")) {
      try {
        raw = JSON.parse(`"${raw.replace(/[\\"]/g, (c) => c === '\\' ? '\\\\' : '\\"')}"`);
        // Note: the above is fragile for arbitrary escapes; fall back to
        // raw text if parse mangles things.
      } catch {
        // Manual undo of the common escapes.
        raw = raw
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\'/g, "'");
      }
    }
    // Sanity: ensure the extracted block compiles to *something*. Don't
    // call bundle() here — that's the caller's job. Just make sure we
    // got at least one statement.
    if (raw.length > 30 && raw.includes('return')) {
      out.push(raw);
    }
  }
  return out;
}

/** Find the first `[ ... ]` slice and try to JSON.parse it. */
function tryParseJsonArray(content: string): unknown[] {
  // Look inside fenced code blocks first (they're more likely to be JSON).
  const fences = content.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? [];
  for (const fence of fences) {
    const body = fence.replace(/^```(?:json)?\s*/, '').replace(/```$/, '');
    const arr = attemptArray(body);
    if (arr) return arr;
  }
  // Fall back to scanning the whole content.
  const arr = attemptArray(content);
  return arr ?? [];
}

function attemptArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Legacy entry point kept for back-compat (the old parser). */
function _legacyParseDiverseSeedResponse(
  content: string,
  profiles: BehaviorProfile[],
): DiverseSeed[] {
  // Strip fenced code block markers if present.
  let body = content;
  const fence = /```(?:json)?\s*([\s\S]*?)```/m.exec(content);
  if (fence) body = fence[1];

  // Find the first top-level [ ... ] in the body.
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < 0 || end <= start) {
    logger.warn('diverse seed response had no JSON array');
    return [];
  }
  const slice = body.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'diverse seed JSON parse failed');
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const profilesById = new Map<string, BehaviorProfile>();
  profiles.forEach((p, i) => profilesById.set(profileTag(p, i + 1), p));

  const out: DiverseSeed[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as { id?: unknown; source?: unknown };
    const id = typeof obj.id === 'string' ? obj.id : null;
    const source = typeof obj.source === 'string' ? obj.source : null;
    if (!id || !source) continue;
    const profile = profilesById.get(id);
    if (!profile) continue; // LLM hallucinated an id we didn't ask for
    out.push({ id, profile, source });
  }
  return out;
}
