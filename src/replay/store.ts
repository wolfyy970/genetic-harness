/**
 * @module replay/store
 *
 * Disk persistence for the genetic harness archive: leaderboard, replays,
 * manifest, and run-status side files. All paths live under a single
 * archive root directory (`HarnessConfig.archiveDir`, default `./data/archive`).
 *
 * Slice 1 ships only the leaderboard helpers. Replay + manifest writers
 * land in slice 2.
 */

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { ArchivedBot } from '../shared/types.js';
import type {
  GenerationStats,
  ReplayFile,
  ReplayManifest,
  ReplayManifestEntry,
} from './types.js';
import type { GridCellSnapshot } from '../orchestrator/population.js';
import { MANIFEST_SCHEMA } from './types.js';

const LEADERBOARD_FILE = 'leaderboard.json';
const MANIFEST_FILE = 'manifest.json';
const GENERATIONS_DIR = 'generations';

/** Pad a generation number for stable directory ordering: 1 → "0001". */
function padGen(n: number): string {
  return String(n).padStart(4, '0');
}

/** Path to a single replay file within `archiveDir`. */
export function replayPath(
  archiveDir: string,
  generation: number,
  matchId: string,
): string {
  return join(
    archiveDir,
    GENERATIONS_DIR,
    `gen-${padGen(generation)}`,
    `${matchId}.json`,
  );
}

/**
 * JSON.stringify replacer that turns `bigint` into string. Needed because
 * `ArchivedBot.fitness.cpuTimeTotal` is a bigint and JSON has no native
 * support for it.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Reverse of `bigintReplacer` for known-bigint fields. We only need to
 * rehydrate `cpuTimeTotal` because that's the one the runtime actually
 * passes around as a bigint.
 */
function rehydrateLeaderboard(bots: unknown[]): ArchivedBot[] {
  return bots.map((b) => {
    const bot = b as ArchivedBot & { fitness: { cpuTimeTotal: unknown } };
    if (typeof bot.fitness?.cpuTimeTotal === 'string') {
      bot.fitness.cpuTimeTotal = BigInt(bot.fitness.cpuTimeTotal);
    }
    return bot;
  });
}

/** Ensure `archiveDir` exists. Idempotent. */
export function ensureArchiveDir(archiveDir: string): void {
  mkdirSync(archiveDir, { recursive: true });
}

/**
 * Persist a leaderboard snapshot to `<archiveDir>/leaderboard.json`.
 * Atomic via write-and-rename to avoid readers seeing a half-written file.
 */
export function writeLeaderboard(
  archiveDir: string,
  bots: ArchivedBot[],
): void {
  ensureArchiveDir(archiveDir);
  const path = join(archiveDir, LEADERBOARD_FILE);
  const tmp = path + '.tmp';
  const json = JSON.stringify(
    { schema: 1, updatedAt: new Date().toISOString(), bots },
    bigintReplacer,
    2,
  );
  writeFileSync(tmp, json, 'utf8');
  renameSync(tmp, path); // atomic on POSIX
}

/**
 * Load the most recent leaderboard from disk. Returns `null` when the
 * file does not exist (a fresh archive); throws on parse failure.
 */
export function loadLeaderboard(archiveDir: string): ArchivedBot[] | null {
  const path = join(archiveDir, LEADERBOARD_FILE);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as { bots: unknown[] };
  return rehydrateLeaderboard(parsed.bots);
}

/**
 * Resolve a path inside `archiveDir`, rejecting any input that escapes the
 * root via `..` or absolute paths. Used by the HTTP layer when serving
 * replay files by URL parameters.
 */
export function safeArchivePath(archiveDir: string, ...parts: string[]): string {
  const root = resolve(archiveDir) + sep;
  const target = resolve(archiveDir, ...parts);
  if (!target.startsWith(root) && target !== resolve(archiveDir)) {
    throw new Error(`Path escapes archive root: ${parts.join('/')}`);
  }
  return target;
}

/**
 * Persist one replay file under `<archiveDir>/generations/gen-NNNN/<matchId>.json`.
 * Returns the path written, relative to `archiveDir`, suitable for embedding
 * in a manifest entry.
 */
export function writeReplay(archiveDir: string, file: ReplayFile): string {
  ensureArchiveDir(archiveDir);
  const dir = join(archiveDir, GENERATIONS_DIR, `gen-${padGen(file.generation)}`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${file.matchId}.json`);
  const tmp = target + '.tmp';
  writeFileSync(tmp, JSON.stringify(file), 'utf8');
  renameSync(tmp, target);
  return join(GENERATIONS_DIR, `gen-${padGen(file.generation)}`, `${file.matchId}.json`);
}

/**
 * Read a replay file by generation + matchId. Throws when the file is
 * missing or path-traversal is attempted.
 */
export function readReplay(
  archiveDir: string,
  generation: number,
  matchId: string,
): ReplayFile {
  if (matchId.includes('/') || matchId.includes('\\') || matchId.includes('..')) {
    throw new Error(`Invalid matchId: ${matchId}`);
  }
  const target = safeArchivePath(
    archiveDir,
    GENERATIONS_DIR,
    `gen-${padGen(generation)}`,
    `${matchId}.json`,
  );
  return JSON.parse(readFileSync(target, 'utf8')) as ReplayFile;
}

/** Load the run manifest if it exists; null otherwise. */
export function loadManifest(archiveDir: string): ReplayManifest | null {
  const path = join(archiveDir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as ReplayManifest;
}

/** Atomically write a manifest. */
export function writeManifest(archiveDir: string, manifest: ReplayManifest): void {
  ensureArchiveDir(archiveDir);
  const path = join(archiveDir, MANIFEST_FILE);
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(manifest, bigintReplacer, 2), 'utf8');
  renameSync(tmp, path);
}

/**
 * Delete `generations/gen-NNNN/` directories beyond the most-recent
 * `keepRecent`. Returns the list of deleted relative paths so the caller
 * can prune them out of the manifest in the same pass.
 *
 * No-op when the generations dir is missing or has fewer than `keepRecent`
 * entries.
 */
export function pruneOldGenerations(
  archiveDir: string,
  keepRecent: number,
): number[] {
  if (keepRecent <= 0) return [];
  const dir = join(archiveDir, GENERATIONS_DIR);
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^gen-\d{4,}$/.test(e.name))
    .map((e) => ({ name: e.name, gen: Number(e.name.slice(4)) }))
    .sort((a, b) => a.gen - b.gen);
  if (entries.length <= keepRecent) return [];
  const toDelete = entries.slice(0, entries.length - keepRecent);
  const deleted: number[] = [];
  for (const e of toDelete) {
    try {
      rmSync(join(dir, e.name), { recursive: true, force: true });
      deleted.push(e.gen);
    } catch {
      /* ignore */
    }
  }
  return deleted;
}

/**
 * Append (or replace) a generation's entry in the manifest. Creates the
 * manifest if absent. The leaderboard, grid, and stats are always
 * overwritten with the latest snapshot supplied.
 */
export function appendGenerationToManifest(
  archiveDir: string,
  args: {
    runId: string;
    arena: string;
    sanitizedConfig: ReplayManifest['config'];
    entry: ReplayManifestEntry;
    leaderboard: ArchivedBot[];
    mapElitesGrid: GridCellSnapshot[];
    generationStats: GenerationStats;
  },
): ReplayManifest {
  const existing = loadManifest(archiveDir);
  const generations = (existing?.generations ?? []).filter(
    (g) => g.generation !== args.entry.generation,
  );
  generations.push(args.entry);
  generations.sort((a, b) => a.generation - b.generation);

  const stats = (existing?.generationStats ?? []).filter(
    (s) => s.generation !== args.generationStats.generation,
  );
  stats.push(args.generationStats);
  stats.sort((a, b) => a.generation - b.generation);

  const manifest: ReplayManifest = {
    schema: MANIFEST_SCHEMA,
    runId: existing?.runId ?? args.runId,
    arena: args.arena,
    config: args.sanitizedConfig,
    generations,
    leaderboard: args.leaderboard,
    mapElitesGrid: args.mapElitesGrid,
    generationStats: stats,
    updatedAt: new Date().toISOString(),
  };
  writeManifest(archiveDir, manifest);
  return manifest;
}
