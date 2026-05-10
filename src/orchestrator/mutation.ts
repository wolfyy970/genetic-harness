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

/**
 * Build the mutation prompt for the LLM.
 * Uses k=2 versioned exemplars sorted ascending with scores,
 * plus reward-reflection and failure traces.
 */
export function buildMutationPrompt(context: MutationContext): { system: string; user: string } {
  const { bestK, evaluationHistory, rewardReflection, mode, fuelBudget, λ } = context;

  const systemPrompt = `You are an expert TypeScript programmer specializing in competitive game AI.
You will be given code for a game controller (bot) that plays a multiplayer Asteroids-like arena.
Your job is to improve the bot by producing SEARCH/REPLACE blocks.

Rules:
- Only modify code inside the SEARCH/REPLACE blocks
- Do NOT change the function signature: function tick(botState: BotState): BotAction
- Do NOT add console.log, setTimeout, fetch, or any non-deterministic APIs
- Keep the code clean and readable
- Each SEARCH/REPLACE block must have exact matching oldText (all lines)
- The newText should be the replacement

Mutation prompt structure:
- Show the current best bot with its score and code
- Show the second-best bot with its score and code
- Show failure traces from recent mutations
- Show reward reflection with per-component statistics
- Request a SEARCH/REPLACE diff that improves on both exemplars`;

  const userPrompt = `Current mode: ${mode}${fuelBudget ? ` (fuel ceiling: ${fuelBudget}/tick)` : ''}${λ ? ` (weight: λ=${λ})` : ''}

== Best exemplar (priority_v0) ==
Score: ${bestK[0]?.fitness.fitnessScore?.toFixed(2) ?? 'N/A'}
Win rate: ${(bestK[0]?.fitness.winRate ?? 0) * 100}%
Avg fuel/tick: ${bestK[0]?.fitness.avgFuelPerTick?.toFixed(0) ?? 'N/A'}
Code:
\`\`\`ts
${bestK[0]?.source ?? 'N/A'}
\`\`\`

== Second best exemplar (priority_v1) ==
Score: ${bestK[1]?.fitness.fitnessScore?.toFixed(2) ?? 'N/A'}
Win rate: ${(bestK[1]?.fitness.winRate ?? 0) * 100}%
Code:
\`\`\`ts
${bestK[1]?.source ?? 'N/A'}
\`\`\`

== Reward Reflection ==
Win rate: ${(rewardReflection?.winRate ?? 0) * 100}%
Avg score: ${rewardReflection?.avgScore ?? 0}
Avg fuel/tick: ${rewardReflection?.avgFuelPerTick?.toFixed(0) ?? 0}

== Recent Failure Traces ==
${evaluationHistory || 'No failures in recent history'}

== Instructions ==
Improve the best exemplar (priority_v0) by producing SEARCH/REPLACE blocks.
Focus on: strategic improvement, code clarity, and performance.

Produce the output in the following format:
\`\`\`
<SEARCH>
[current code lines]
</SEARCH>
<REPLACE>
[new code lines]
</REPLACE>
\`\`\`

You may produce multiple SEARCH/REPLACE blocks if needed.`;

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

  // Call oMLX with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000); // 60s timeout

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

    if (!content) {
      return {
        shipId: '',
        source,
        isImprovement: false,
        reason: 'LLM returned empty response',
        searchReplaceDiff: [],
      };
    }

    // Parse SEARCH/REPLACE blocks from LLM output
    const blocks = parseSearchReplaceBlocks(content);

    // Apply mutations
    let newSource = source;
    for (const block of blocks) {
      if (block.oldText && block.newText) {
        newSource = applyBlock(newSource, block);
      }
    }

    return {
      shipId: '',
      source: newSource,
      isImprovement: blocks.length > 0,
      reason: blocks.length > 0 ? `Applied ${blocks.length} mutation block(s)` : 'No mutations generated',
      searchReplaceDiff: blocks,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Generate a mutation, then verify it compiles. On bundle failure, feed
 * the compile error back into the mutation context as a failure trace and
 * retry, up to `maxRetries` times.
 *
 * This is the "Self-Debugging" pattern from the literature: cheap retry
 * loops with grounded compile-error feedback materially improve LLM-coding
 * quality at low cost. With mock-LLM mode the mock is deterministic and
 * compiles on the first try, so this is essentially a pass-through during
 * tests; the wrapper earns its keep with live LLMs.
 */
export async function generateMutationWithRetry(
  source: string,
  context: MutationContext,
  config: HarnessConfig,
  maxRetries: number = 2,
): Promise<MutationPlan> {
  let attempt = 0;
  let history = context.evaluationHistory ?? '';

  while (true) {
    const ctxAttempt: MutationContext = {
      ...context,
      evaluationHistory: history,
    };
    const plan = await generateMutation(source, ctxAttempt, config);
    const bundled = bundle(plan.source);

    if (!bundled.startsWith(BUNDLE_ERROR_PREFIX)) {
      return plan;
    }

    if (attempt >= maxRetries) {
      logger.warn(
        { attempt, error: bundled.slice(0, 200) },
        'Mutation failed to compile after retries — returning original source',
      );
      // Return the original (compilable) source as a no-op mutation so the
      // candidate isn't lost from the population.
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
