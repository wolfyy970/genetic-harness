/**
 * Configuration loading and merging utilities for the genetic harness.
 *
 * Provides functions to load the harness configuration from defaults
 * with optional overrides, and to shallow-merge two config objects.
 *
 * @module config
 */

import { HarnessConfig, DEFAULT_CONFIG } from './types.js';

/**
 * Load the harness configuration with optional overrides.
 *
 * Merges `overrides` on top of the built-in `DEFAULT_CONFIG`.
 * Useful for creating a config from a partial object or environment variables.
 *
 * @param overrides - Partial config to override defaults
 * @returns Full `HarnessConfig` with defaults + overrides applied
 */
export function loadConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  };
}

/**
 * Merge a base configuration with overrides, returning a new object.
 *
 * This is a shallow merge — nested properties are replaced entirely,
 * not merged recursively.
 *
 * @param base      - The base configuration to extend
 * @param overrides - Partial config to apply on top
 * @returns A new `HarnessConfig` with overrides applied
 */
export function mergeConfig(base: HarnessConfig, overrides: Partial<HarnessConfig>): HarnessConfig {
  return { ...base, ...overrides };
}
