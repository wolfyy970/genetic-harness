/**
 * @module server
 *
 * HTTP server for the genetic harness. Serves a static dashboard and a
 * small JSON API around the on-disk archive.
 *
 * Routes:
 *   GET /                  — public/index.html
 *   GET /static/*          — files under public/
 *   GET /api/leaderboard   — in-memory leaderboard, falls back to disk
 *   GET /api/state         — minimal status (leaderboard size)
 *
 * The server only starts listening when this module is invoked as the
 * program's main script (`npm run serve`). Importing it from another
 * module — e.g. for the `setLeaderboard` ref — does not bind a port.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchivedBot } from './shared/types.js';
import { loadLeaderboard, loadManifest, readReplay } from './replay/store.js';
import { RunManager } from './server/run-manager.js';
import { isAuthorized, getAuthToken, validateBindHost } from './server/auth.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const HOST = process.env.HARNESS_HOST ?? '127.0.0.1';
let archiveDir = process.env.HARNESS_ARCHIVE_DIR ?? './data/archive';
const PUBLIC_DIR = resolve(
  fileURLToPath(new URL('../public', import.meta.url)),
);

/**
 * Override the archive directory the server reads from. Used by tests so
 * each suite can stage fixtures in a clean tmp dir without touching the
 * user's real `./data/archive`.
 */
export function setArchiveDir(path: string): void {
  archiveDir = path;
}

let leaderboardRef: ArchivedBot[] = [];

/** Run manager. Exported so tests can inject a custom spawnFn. */
export const runManager = new RunManager();

/**
 * Update the in-memory leaderboard. Called by `runEvolution` after every
 * generation when running in the same Node process; safe to import from
 * other modules without starting the server.
 */
export function setLeaderboard(data: ArchivedBot[]): void {
  leaderboardRef = data;
}

/** Get the current in-memory leaderboard. */
export function getLeaderboard(): ArchivedBot[] {
  return leaderboardRef;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function jsonReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, jsonReplacer));
}

function send404(res: ServerResponse, msg = 'Not found'): void {
  sendJson(res, 404, { error: msg });
}

function leaderboardSnapshot(): ArchivedBot[] {
  if (leaderboardRef.length > 0) return leaderboardRef;
  try {
    const disk = loadLeaderboard(archiveDir);
    return disk ?? [];
  } catch (err) {
    return [];
  }
}

function serveStatic(res: ServerResponse, urlPath: string): void {
  // Strip the /static/ prefix; reject path-traversal.
  const stripped = urlPath.replace(/^\/static\//, '');
  if (!stripped || stripped.includes('..')) {
    send404(res);
    return;
  }
  const target = resolve(PUBLIC_DIR, stripped);
  if (!target.startsWith(PUBLIC_DIR + sep) && target !== PUBLIC_DIR) {
    send404(res);
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    send404(res);
    return;
  }
  const ext = extname(target).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(readFileSync(target));
}

async function handlePostRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: (err as Error).message });
    return;
  }
  try {
    const record = runManager.start(body);
    sendJson(res, 200, record);
  } catch (err) {
    const msg = (err as Error).message;
    sendJson(res, /already active/.test(msg) ? 409 : 500, { error: msg });
  }
}

function readJsonBody(req: IncomingMessage, max = 64 * 1024): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        rejectBody(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth gate: every /api/* path requires auth when a token is set.
  if (url.pathname.startsWith('/api/') && !isAuthorized(req)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/runs') {
    void handlePostRun(req, res);
    return;
  }

  if (req.method === 'DELETE') {
    const m = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (m) {
      const ok = runManager.stop(decodeURIComponent(m[1]));
      sendJson(res, ok ? 200 : 404, { stopped: ok });
      return;
    }
  }

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (url.pathname === '/') {
    const indexPath = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(indexPath)) {
      sendJson(res, 200, {
        message:
          'Genetic harness server. UI assets not yet built — run `npm run smoke` and re-fetch /api/leaderboard.',
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES['.html'] });
    res.end(readFileSync(indexPath));
    return;
  }

  if (url.pathname.startsWith('/static/')) {
    serveStatic(res, url.pathname);
    return;
  }

  if (url.pathname === '/api/leaderboard') {
    const data = leaderboardSnapshot();
    sendJson(res, 200, { count: data.length, results: data });
    return;
  }

  if (url.pathname === '/api/manifest') {
    try {
      const manifest = loadManifest(archiveDir);
      if (!manifest) {
        sendJson(res, 200, { empty: true });
        return;
      }
      sendJson(res, 200, manifest);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
    return;
  }

  // GET /api/replays/:generation/:matchId
  const replayMatch = url.pathname.match(/^\/api\/replays\/(\d+)\/([^/]+)$/);
  if (replayMatch) {
    const generation = Number(replayMatch[1]);
    const matchId = decodeURIComponent(replayMatch[2]);
    try {
      const file = readReplay(archiveDir, generation, matchId);
      sendJson(res, 200, file);
    } catch (err) {
      send404(res, (err as Error).message);
    }
    return;
  }

  if (url.pathname === '/api/runs') {
    sendJson(res, 200, { runs: runManager.list() });
    return;
  }

  const runStatus = url.pathname.match(/^\/api\/runs\/([^/]+)\/status$/);
  if (runStatus) {
    const r = runManager.get(decodeURIComponent(runStatus[1]));
    if (!r) {
      send404(res);
      return;
    }
    sendJson(res, 200, r);
    return;
  }

  const runLog = url.pathname.match(/^\/api\/runs\/([^/]+)\/log$/);
  if (runLog) {
    const tail = runManager.log(decodeURIComponent(runLog[1]), 200);
    sendJson(res, 200, { lines: tail });
    return;
  }

  if (url.pathname === '/api/state') {
    sendJson(res, 200, {
      status: 'running',
      leaderboardSize: leaderboardRef.length,
      archiveDir,
    });
    return;
  }

  send404(res);
}

export const server = createServer(handleRequest);

const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  const bindError = validateBindHost(HOST, getAuthToken());
  if (bindError) {
    console.error(`Refusing to start: ${bindError}`);
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`Genetic harness server running on http://${HOST}:${PORT}`);
    console.log(`Archive dir: ${archiveDir}`);
    if (getAuthToken()) {
      console.log('Bearer-token auth: enabled');
    } else {
      console.log('Bearer-token auth: disabled (localhost only)');
    }
  });
}
