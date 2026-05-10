/**
 * Tests for the MAP-Elites population.
 *
 * Focus: cell-key bucketing on (aggression × log fuel) — the new Phase-1
 * key — and elite replacement / migration semantics.
 */

import { describe, it, expect } from 'vitest';
import { Population } from '../src/orchestrator/population.js';
import type { ArchivedBot, FitnessResult } from '../src/shared/types.js';

function fitness(overrides: Partial<FitnessResult> = {}): FitnessResult {
  return {
    shipId: 'x',
    winRate: 0,
    avgScore: 0,
    avgFuelPerTick: 0,
    avgTicksAlive: 0,
    totalMatches: 0,
    totalTicksAlive: 0,
    cpuTimeTotal: 0n,
    memoryUsed: 0,
    crashes: 0,
    fitnessScore: 0,
    aggression: 0,
    economy: 0,
    ...overrides,
  };
}

function bot(id: string, fit: FitnessResult, island = 0): ArchivedBot {
  return {
    id,
    source: `// ${id}`,
    shipId: id,
    fitness: fit,
    stage: 2,
    timestamp: 0,
    metadata: {
      generation: 0,
      island,
      behavioralSignature: [],
      complexity: 1,
      noveltyScore: 1,
    },
  };
}

describe('Population MAP-Elites grid', () => {
  it('places bots into distinct cells when their (aggression, fuel) bucket differs', () => {
    const pop = new Population({ islandCount: 1, migrationInterval: 1000 });
    pop.addCandidate(
      bot('lean-defensive', fitness({ aggression: 0.0, avgFuelPerTick: 1, fitnessScore: 0.1 })),
    );
    pop.addCandidate(
      bot('aggressive-bloated', fitness({ aggression: 0.9, avgFuelPerTick: 100_000, fitnessScore: 0.5 })),
    );
    expect(pop.getArchive().length).toBe(2);
  });

  it('replaces the elite in a cell when a higher-fitness bot arrives', () => {
    const pop = new Population({ islandCount: 1, migrationInterval: 1000 });
    pop.addCandidate(bot('a', fitness({ aggression: 0.5, avgFuelPerTick: 100, fitnessScore: 0.2 })));
    pop.addCandidate(bot('b', fitness({ aggression: 0.5, avgFuelPerTick: 100, fitnessScore: 0.6 })));
    const archive = pop.getArchive();
    expect(archive.length).toBe(1);
    expect(archive[0].id).toBe('b');
  });

  it('rejects a worse bot competing for the same cell', () => {
    const pop = new Population({ islandCount: 1, migrationInterval: 1000 });
    pop.addCandidate(bot('strong', fitness({ aggression: 0.5, avgFuelPerTick: 100, fitnessScore: 0.8 })));
    pop.addCandidate(bot('weak', fitness({ aggression: 0.5, avgFuelPerTick: 100, fitnessScore: 0.3 })));
    const archive = pop.getArchive();
    expect(archive.length).toBe(1);
    expect(archive[0].id).toBe('strong');
  });

  it('clamps aggression and fuel buckets so extreme values do not throw', () => {
    const pop = new Population({ islandCount: 1, migrationInterval: 1000 });
    expect(() =>
      pop.addCandidate(
        bot('weird', fitness({ aggression: 5, avgFuelPerTick: 1e15, fitnessScore: 0.1 })),
      ),
    ).not.toThrow();
    expect(() =>
      pop.addCandidate(
        bot('also-weird', fitness({ aggression: -1, avgFuelPerTick: -50, fitnessScore: 0.05 })),
      ),
    ).not.toThrow();
    expect(pop.getArchive().length).toBeGreaterThanOrEqual(1);
  });

  it('returns the global best across all islands', () => {
    const pop = new Population({ islandCount: 2, migrationInterval: 1000 });
    pop.addCandidate(bot('a', fitness({ aggression: 0.1, avgFuelPerTick: 10, fitnessScore: 0.3 })));
    pop.addCandidate(bot('b', fitness({ aggression: 0.6, avgFuelPerTick: 200, fitnessScore: 0.7 })));
    const best = pop.getBest();
    expect(best?.id).toBe('b');
  });
});

describe('Population.getGridSnapshot', () => {
  it('returns one entry per occupied (aggression, fuel) cell', () => {
    const pop = new Population({ islandCount: 1, migrationInterval: 1000 });
    pop.addCandidate(bot('a', fitness({ aggression: 0.1, avgFuelPerTick: 10, fitnessScore: 0.2 })));
    pop.addCandidate(bot('b', fitness({ aggression: 0.6, avgFuelPerTick: 1_000_000, fitnessScore: 0.4 })));
    pop.addCandidate(bot('c', fitness({ aggression: 0.95, avgFuelPerTick: 50, fitnessScore: 0.6 })));
    const snap = pop.getGridSnapshot();
    expect(snap.length).toBe(3);
    const buckets = snap
      .map((s) => `${s.aggressionBucket}-${s.fuelBucket}`)
      .sort();
    expect(buckets.length).toBe(3);
  });

  it('keeps the higher-fitness elite when two islands share a cell', () => {
    const pop = new Population({ islandCount: 2, migrationInterval: 1000 });
    // Both bots land in (aggression=0, fuel=0) but island assignment uses
    // smallest-island rule, so they end up on different islands. Then we
    // also add a stronger duplicate bot via a follow-up add — verify the
    // global snapshot reports the higher one.
    pop.addCandidate(bot('weak', fitness({ aggression: 0.0, avgFuelPerTick: 0, fitnessScore: 0.1 })));
    pop.addCandidate(bot('strong', fitness({ aggression: 0.0, avgFuelPerTick: 0, fitnessScore: 0.9 })));
    const snap = pop.getGridSnapshot();
    // Both bots compete for (0, 0); the snapshot dedups to 1 cell.
    expect(snap.length).toBe(1);
    expect(snap[0].shipId).toBe('strong');
  });

  it('includes fitness, shipId, and generation per cell', () => {
    const pop = new Population({ islandCount: 1, migrationInterval: 1000 });
    pop.addCandidate(bot('a', fitness({ aggression: 0.5, avgFuelPerTick: 100, fitnessScore: 0.5 })));
    const snap = pop.getGridSnapshot();
    expect(snap[0].shipId).toBe('a');
    expect(snap[0].generation).toBe(0);
    expect(snap[0].fitness).toBeCloseTo(0.5);
    expect(snap[0].aggressionBucket).toBeGreaterThanOrEqual(0);
    expect(snap[0].fuelBucket).toBeGreaterThanOrEqual(0);
  });
});
