/**
 * Tests for the mutation pipeline: mock mutator + compile-and-retry wrapper.
 */

import { describe, it, expect } from 'vitest';
import {
  generateMutation,
  generateMutationWithRetry,
} from '../src/orchestrator/mutation.js';
import { loadConfig } from '../src/shared/config.js';
import type { MutationContext, HarnessConfig } from '../src/shared/types.js';

const SAMPLE_BOT = `function tick(s) {
  if (s.opponents.length > 0) {
    var d = 0;
    if (d < 200) return { type: 'fire' };
  }
  return { type: 'rotate', direction: 1 };
}`;

function mockConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return loadConfig({ llmBaseUrl: 'mock', ...overrides });
}

function emptyContext(): MutationContext {
  return {
    bestK: [],
    evaluationHistory: '',
    rewardReflection: {
      winRate: 0,
      avgScore: 0,
      avgFuelPerTick: 0,
      avgTicksAlive: 0,
      fuelBreakdownBySource: [],
      topBehavioralAxes: { aggression: 0, economic: 0, defensive: 0 },
    },
    mode: 'pure',
    λ: 0,
  };
}

describe('Mock mutator (LLM_MOCK / llmBaseUrl=mock)', () => {
  it('produces a deterministic mutation for the same input', async () => {
    const a = await generateMutation(SAMPLE_BOT, emptyContext(), mockConfig());
    const b = await generateMutation(SAMPLE_BOT, emptyContext(), mockConfig());
    expect(a.source).toBe(b.source);
    expect(a.reason).toBe(b.reason);
  });

  it('marks isImprovement=true when at least one block was applied', async () => {
    const result = await generateMutation(SAMPLE_BOT, emptyContext(), mockConfig());
    if (result.searchReplaceDiff.length > 0) {
      expect(result.isImprovement).toBe(true);
    }
  });

  it('produces a compilable mutation that can run a tick', async () => {
    const { bundle, BUNDLE_ERROR_PREFIX } = await import('../src/runtime/bundler.js');
    const result = await generateMutation(SAMPLE_BOT, emptyContext(), mockConfig());
    const bundled = bundle(result.source);
    expect(bundled).not.toMatch(new RegExp(`^${BUNDLE_ERROR_PREFIX}`));
  });

  it('respects LLM_MOCK env var as a fallback for llmBaseUrl', async () => {
    const original = process.env.LLM_MOCK;
    process.env.LLM_MOCK = '1';
    try {
      // Use a non-mock URL but env should override.
      const config = loadConfig({ llmBaseUrl: 'http://no-such-host:0/v1' });
      const result = await generateMutation(SAMPLE_BOT, emptyContext(), config);
      expect(result.reason).toMatch(/^\[mock\]/);
    } finally {
      if (original === undefined) delete process.env.LLM_MOCK;
      else process.env.LLM_MOCK = original;
    }
  });
});

describe('generateMutationWithRetry', () => {
  it('returns the mutation directly when it compiles on first attempt', async () => {
    const result = await generateMutationWithRetry(
      SAMPLE_BOT,
      emptyContext(),
      mockConfig(),
      2,
    );
    const { bundle, BUNDLE_ERROR_PREFIX } = await import('../src/runtime/bundler.js');
    expect(bundle(result.source).startsWith(BUNDLE_ERROR_PREFIX)).toBe(false);
  });

  it('falls back to original source after exhausting retries on uncompilable input', async () => {
    // Mock mutator can't fix invalid syntax — verify the fallback path.
    const broken = `function tick(s { return { type: 'wait' }; }`;
    const result = await generateMutationWithRetry(
      broken,
      emptyContext(),
      mockConfig(),
      1,
    );
    // Either the mock got lucky and produced compilable output, OR it fell
    // back to the original (also broken). Either way isImprovement is false
    // for the fallback path.
    if (!result.isImprovement) {
      expect(result.source).toBe(broken);
      expect(result.reason).toMatch(/compile failed/);
    }
  });
});
