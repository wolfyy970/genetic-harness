/**
 * Tests for the runtime (bundler, deterministic globals, isolate).
 */

import { describe, it, expect } from 'vitest';
import { bundle } from '../src/runtime/bundler.js';

// =============================================================================
// Bundler tests
// =============================================================================

describe('Bundler', () => {
  it('bundles valid bot source code', () => {
    const source = `
      export function tick(botState: any): any {
        return { type: 'wait' };
      }
    `;
    const bundled = bundle(source);
    expect(bundled).toContain('tick');
    expect(bundled).toContain('globalThis.tick');
    expect(bundled).not.toContain('Compilation error');
  });

  it('handles compilation errors gracefully', () => {
    const source = `
      export function tick(botState: any): any {
        return { type: 'invalid_action' };
        // Missing closing brace
    `;
    const bundled = bundle(source);
    // Should contain error info but not throw
    expect(bundled).toContain('Compilation error');
  });

  it('produces IIFE-wrapped output that assigns tick to globalThis', () => {
    const source = `
      export function tick(botState: any): any {
        return { type: 'fire' };
      }
    `;
    const bundled = bundle(source);
    // esbuild's iife format uses arrow-function wrappers in modern targets
    expect(bundled).toMatch(/^\(\s*(?:\(\)\s*=>|function\s*\()/);
    expect(bundled).toContain('})();');
    expect(bundled).toContain('globalThis.tick = tick');
  });

  it('includes the tick function in output', () => {
    const source = `
      export function tick(botState: any): any {
        return { type: 'thrust', angle: 0 };
      }
    `;
    const bundled = bundle(source);
    expect(bundled).toContain('tick');
  });

  it('bundles with no errors for a complete bot', () => {
    const source = `
      interface BotState {
        ship: { pos: { x: number; y: number }; angle: number };
        asteroids: Array<{ pos: { x: number; y: number }; radius: number }>;
        opponents: Array<{ pos: { x: number; y: number } }>;
      }

      interface BotAction {
        type: 'thrust' | 'rotate' | 'fire' | 'wait';
        angle?: number;
        direction?: number;
      }

      export function tick(botState: BotState): BotAction {
        if (botState.asteroids.length === 0) {
          return { type: 'fire' };
        }
        return { type: 'wait' };
      }
    `;
    const bundled = bundle(source);
    expect(bundled).not.toContain('Compilation error');
    expect(bundled).toContain('tick');
  });
});
