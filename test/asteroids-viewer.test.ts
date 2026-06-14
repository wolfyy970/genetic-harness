/**
 * Tests for the per-arena viewer module at public/viewers/asteroids.js.
 *
 * The viewer's `paint` is a pure function that calls a 2D-context. We
 * shim the context with a recorder and assert call counts/arguments per
 * entity type. This avoids needing node-canvas, headless-chrome, or any
 * runtime dependency to validate rendering correctness.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface CtxCall {
  method: string;
  args: unknown[];
}

class RecordingCtx {
  calls: CtxCall[] = [];
  // Mutable canvas state we record by `set` for assertions.
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 0;
  globalAlpha = 1;

  fillRect(...args: unknown[]) { this.calls.push({ method: 'fillRect', args }); }
  strokeRect(...args: unknown[]) { this.calls.push({ method: 'strokeRect', args }); }
  beginPath() { this.calls.push({ method: 'beginPath', args: [] }); }
  closePath() { this.calls.push({ method: 'closePath', args: [] }); }
  moveTo(...args: unknown[]) { this.calls.push({ method: 'moveTo', args }); }
  lineTo(...args: unknown[]) { this.calls.push({ method: 'lineTo', args }); }
  arc(...args: unknown[]) { this.calls.push({ method: 'arc', args }); }
  stroke() { this.calls.push({ method: 'stroke', args: [] }); }
  fill() { this.calls.push({ method: 'fill', args: [] }); }
  save() { this.calls.push({ method: 'save', args: [] }); }
  restore() { this.calls.push({ method: 'restore', args: [] }); }
  translate(...args: unknown[]) { this.calls.push({ method: 'translate', args }); }
  rotate(...args: unknown[]) { this.calls.push({ method: 'rotate', args }); }

  countOf(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

let viewer: typeof import('../public/viewers/asteroids.js');

beforeAll(async () => {
  // Import the public/ viewer directly. Same JS the browser loads.
  const path = join(process.cwd(), 'public', 'viewers', 'asteroids.js');
  const url = new URL(`file://${path}`);
  viewer = await import(url.href);
});

// Pass world dims that match the canvas dims so scale = 1 and the
// recorded canvas operations land at the same coordinates the tests
// historically expected. (The viewer now scales world→canvas internally;
// scale=1 makes tests' coordinate assertions still meaningful.)
const META = {
  width: 1280, height: 960,
  worldWidth: 1280, worldHeight: 960,
  heroShipId: 'ship-0',
};

function frame(entities: unknown[]) {
  return { type: 'asteroids' as const, tick: 1, entities } as never;
}

describe('asteroids viewer', () => {
  it('exports a 4:3 drawing-surface dimension (1280x960)', () => {
    // 1280x960 matches the world's 4:3 aspect and fits typical laptop
    // viewports after CSS `width: 100%` scaling. The viewer applies a
    // world→canvas scale at paint time using `meta.worldWidth/Height`.
    expect(viewer.dimensions.width).toBe(1280);
    expect(viewer.dimensions.height).toBe(960);
  });

  it('legend enumerates entity types (asteroid tiers + bullet); ships handled by scoreboard', () => {
    const items = viewer.legend();
    expect(items.length).toBe(4);
    // Slice 4 of the UX overhaul: ships moved out of the legend into a
    // dedicated per-ship scoreboard panel; the legend now lists only the
    // non-ship entity types so the user can map asteroid sizes at a glance.
    expect(items.map((i) => i.label)).toEqual([
      'asteroid (large)',
      'asteroid (medium)',
      'asteroid (small)',
      'bullet',
    ]);
  });

  it('paints background then asteroid then bullet then ship for one of each', () => {
    const ctx = new RecordingCtx();
    viewer.paint(
      ctx as unknown as CanvasRenderingContext2D,
      frame([
        { type: 'asteroid', id: 'a1', pos: { x: 100, y: 100 }, radius: 25 },
        { type: 'bullet', id: 'b1', pos: { x: 200, y: 200 } },
        {
          type: 'ship',
          id: 'ship-0',
          pos: { x: 50, y: 50 },
          angle: 0,
          health: 100,
        },
      ]),
      META,
    );

    // First call should be the background fillRect.
    expect(ctx.calls[0].method).toBe('fillRect');

    // Asteroid: arc + stroke. Bullet: fillRect (after the bg). Ship: triangle path.
    expect(ctx.countOf('arc')).toBe(1);
    expect(ctx.countOf('fillRect')).toBeGreaterThanOrEqual(2); // bg + bullet (+ optional hp bar)
    expect(ctx.countOf('translate')).toBe(1); // ship
    expect(ctx.countOf('rotate')).toBe(1);    // ship
  });

  it('handles missing optional fields without throwing', () => {
    const ctx = new RecordingCtx();
    expect(() =>
      viewer.paint(
        ctx as unknown as CanvasRenderingContext2D,
        frame([
          { type: 'ship', id: 'ship-0', pos: { x: 10, y: 10 } }, // no angle, no health
          { type: 'asteroid', id: 'a', pos: { x: 0, y: 0 } },    // no radius
        ]),
        META,
      ),
    ).not.toThrow();
  });

  it('paints ships after asteroids/bullets so they sit on top', () => {
    const ctx = new RecordingCtx();
    viewer.paint(
      ctx as unknown as CanvasRenderingContext2D,
      // Order in the entities[] array intentionally puts the ship first;
      // the viewer should still draw it last.
      frame([
        { type: 'ship', id: 'ship-0', pos: { x: 0, y: 0 }, angle: 0, health: 100 },
        { type: 'bullet', id: 'b', pos: { x: 5, y: 5 } },
        { type: 'asteroid', id: 'a', pos: { x: 10, y: 10 }, radius: 5 },
      ]),
      META,
    );

    // The ship's path uses translate() — that should come AFTER the
    // asteroid's arc() and AFTER the bullet's fillRect (which is the
    // first fillRect after the bg one at index 0).
    const firstTranslateIdx = ctx.calls.findIndex((c) => c.method === 'translate');
    const arcIdx = ctx.calls.findIndex((c) => c.method === 'arc');
    const bulletFillRectIdx = ctx.calls.findIndex(
      (c: CtxCall, i: number) => c.method === 'fillRect' && i > 0,
    );

    expect(firstTranslateIdx).toBeGreaterThan(arcIdx);
    expect(firstTranslateIdx).toBeGreaterThan(bulletFillRectIdx);
  });
});
