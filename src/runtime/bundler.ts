/**
 * @module bundler
 */

/**
 * Bundles bot source code (TypeScript) into a single IIFE string
 * suitable for execution inside an isolated-vm isolate.
 */

import { buildSync } from 'esbuild';

/**
 * Sentinel prefix returned in place of bundled JS when esbuild fails.
 * Callers should test `result.startsWith(BUNDLE_ERROR_PREFIX)`.
 */
export const BUNDLE_ERROR_PREFIX = '// Compilation error:';

/**
 * Compile bot TypeScript source into an IIFE that exposes `tick` on globalThis.
 *
 * The bot source defines `function tick(botState) { ... }` at the top level.
 * We append an explicit assignment so `tick` is reachable from outside the
 * IIFE scope (esbuild keeps top-level function declarations IIFE-local
 * otherwise, even with `globalName`).
 *
 * @param source - Raw TypeScript source code of the bot
 * @returns Bundled JS string, or a string starting with BUNDLE_ERROR_PREFIX on failure
 */
export function bundle(source: string): string {
  try {
    const wrapped = `${source}\nif (typeof tick === 'function') { globalThis.tick = tick; }\n`;
    const result = buildSync({
      stdin: {
        contents: wrapped,
        loader: 'ts' as const,
      },
      format: 'iife',
      target: 'es2020',
      bundle: true,
      minify: false,
      write: false,
      logLevel: 'silent',
    });

    if (result.outputFiles.length === 0) {
      return `${BUNDLE_ERROR_PREFIX} bundling produced no output`;
    }

    return result.outputFiles[0].text;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return `${BUNDLE_ERROR_PREFIX} ${msg}`;
  }
}
