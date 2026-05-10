// Type declarations for the asteroids viewer module. Exposes the contract
// every per-arena viewer should follow so TS-level callers (tests, the
// dashboard's loader, future viewers) get checked against a stable shape.

import type { ReplayFrame } from '../../src/shared/types.js';

export interface ViewerMeta {
  width: number;
  height: number;
  /** Ship id of the candidate so the viewer can highlight it. */
  heroShipId?: string;
}

export interface ViewerLegendItem {
  color: string;
  label: string;
}

export const dimensions: { width: number; height: number };

/** Pure: paints one frame onto the supplied 2D context. */
export function paint(
  ctx: CanvasRenderingContext2D,
  frame: ReplayFrame,
  meta: ViewerMeta,
): void;

export function legend(): ViewerLegendItem[];
