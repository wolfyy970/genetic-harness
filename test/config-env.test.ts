/**
 * Tests for env-var defaults applied by loadConfig().
 *
 * The precedence chain is: DEFAULT_CONFIG < env vars < explicit overrides.
 * These tests pin each rung so a future refactor can't silently invert the
 * order.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/shared/config.js';
import { DEFAULT_CONFIG } from '../src/shared/types.js';

const TARGET_VARS = [
  'HARNESS_LLM_BASE_URL',
  'HARNESS_LLM_MODEL',
  'HARNESS_LLM_API_KEY',
  'HARNESS_ARCHIVE_DIR',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of TARGET_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TARGET_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadConfig env precedence', () => {
  it('returns DEFAULT_CONFIG values when no env vars are set', () => {
    const c = loadConfig();
    expect(c.llmBaseUrl).toBe(DEFAULT_CONFIG.llmBaseUrl);
    expect(c.llmModel).toBe(DEFAULT_CONFIG.llmModel);
    expect(c.llmApiKey).toBe(DEFAULT_CONFIG.llmApiKey);
    expect(c.archiveDir).toBe(DEFAULT_CONFIG.archiveDir);
  });

  it('applies HARNESS_LLM_BASE_URL / MODEL / API_KEY / ARCHIVE_DIR over defaults', () => {
    process.env.HARNESS_LLM_BASE_URL = 'http://studio.local:8000/v1';
    process.env.HARNESS_LLM_MODEL = 'CustomLLM-7B';
    process.env.HARNESS_LLM_API_KEY = 'studio-key';
    process.env.HARNESS_ARCHIVE_DIR = '/Volumes/big/genetic-harness';

    const c = loadConfig();
    expect(c.llmBaseUrl).toBe('http://studio.local:8000/v1');
    expect(c.llmModel).toBe('CustomLLM-7B');
    expect(c.llmApiKey).toBe('studio-key');
    expect(c.archiveDir).toBe('/Volumes/big/genetic-harness');
  });

  it('caller overrides still win over env vars', () => {
    process.env.HARNESS_LLM_BASE_URL = 'http://studio.local:8000/v1';
    process.env.HARNESS_LLM_MODEL = 'CustomLLM-7B';

    const c = loadConfig({
      llmBaseUrl: 'mock',
      llmModel: 'OtherModel-13B',
    });
    expect(c.llmBaseUrl).toBe('mock');
    expect(c.llmModel).toBe('OtherModel-13B');
  });

  it('empty-string env var is treated as unset', () => {
    process.env.HARNESS_LLM_BASE_URL = '';
    const c = loadConfig();
    expect(c.llmBaseUrl).toBe(DEFAULT_CONFIG.llmBaseUrl);
  });
});
