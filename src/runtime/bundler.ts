/**
 * @module bundler
 */

/**
 * Bundles bot source code (TypeScript) into a single IIFE string
 * suitable for execution inside an isolated-vm isolate.
 */

import { buildSync } from 'esbuild';

/**
 * Compile bot TypeScript source into a bundled IIFE string.
 * Wraps the bot source so the `tick` function is accessible on `globalThis`.
 *
 * @param source - Raw TypeScript source code of the bot
 * @returns Bundled IIFE string with `tick` exposed on globalThis
 */
export function bundle(source: string): string {
  try {
    const result = buildSync({
      stdin: {
        contents: source,
        loader: 'ts' as const,
      },
      format: 'iife',
      target: 'es2020',
      bundle: true,
      minify: false,
      globalName: '__gb',
      write: false,
      logLevel: 'silent',
    });

    if (result.outputFiles.length === 0) {
      return '// Bundling produced no output';
    }

    const bundled = result.outputFiles[0].text;

    // Wrap to expose tick on globalThis for the isolate context
    return `(function() {
      ${bundled}
      if (typeof __gb !== 'undefined') {
        globalThis.tick = __gb.tick || __gb;
      }
    })();`;
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return `// Compilation error: ${msg}`;
  }
}
