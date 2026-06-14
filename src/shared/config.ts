/**
 * Configuration loading and merging utilities for the genetic harness.
 *
 * @module config
 *
 * Layering, lowest precedence first:
 *   1. `DEFAULT_CONFIG` from types.ts (compiled-in)
 *   2. Env-var overrides (read at `loadConfig` call time)
 *   3. `overrides` argument (CLI JSON, runEvolution(...) caller, etc.)
 *
 * Env vars all use the `HARNESS_` prefix for consistency with the server's
 * own bind-host / token / archive vars.
 */

import { HarnessConfig, DEFAULT_CONFIG } from './types.js';

/**
 * Read env-var overrides for fields that have a useful default-from-env
 * path. A value is only included when the env var is set, so callers
 * still see hardcoded defaults when env is empty.
 */
function envOverrides(): Partial<HarnessConfig> {
  const out: Partial<HarnessConfig> = {};
  if (process.env.HARNESS_LLM_BASE_URL) out.llmBaseUrl = process.env.HARNESS_LLM_BASE_URL;
  if (process.env.HARNESS_LLM_MODEL) out.llmModel = process.env.HARNESS_LLM_MODEL;
  if (process.env.HARNESS_LLM_API_KEY) out.llmApiKey = process.env.HARNESS_LLM_API_KEY;
  if (process.env.HARNESS_ARCHIVE_DIR) out.archiveDir = process.env.HARNESS_ARCHIVE_DIR;

  if (process.env.HARNESS_CLEAR_ARCHIVE_BEFORE_RUN !== undefined) {
    out.clearArchiveBeforeRun = process.env.HARNESS_CLEAR_ARCHIVE_BEFORE_RUN === '1' ||
      process.env.HARNESS_CLEAR_ARCHIVE_BEFORE_RUN.toLowerCase() === 'true';
  }
  if (process.env.HARNESS_SEED_FROM_ARCHIVE !== undefined) {
    const enabled = process.env.HARNESS_SEED_FROM_ARCHIVE === '1' ||
      process.env.HARNESS_SEED_FROM_ARCHIVE.toLowerCase() === 'true';
    const count = process.env.HARNESS_SEED_FROM_ARCHIVE_COUNT
      ? Math.max(0, Math.floor(Number(process.env.HARNESS_SEED_FROM_ARCHIVE_COUNT)))
      : (enabled ? 2 : 0);
    out.seedFromArchive = { enabled, count };
  }

  return out;
}

/**
 * Load the harness configuration with env-var defaults + caller overrides.
 *
 * @param overrides - Partial config to override env + defaults
 * @returns Full `HarnessConfig`
 */
export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    ...DEFAULT_CONFIG,
    ...envOverrides(),
    ...overrides,
  };
}

/**
 * Shallow-merge a base config with overrides. Used for partial updates
 * outside the `loadConfig` flow.
 */
export function mergeConfig(base: HarnessConfig, overrides: Partial<HarnessConfig>): HarnessConfig {
  return { ...base, ...overrides };
}
