/**
 * @module server
 */

/**
 * Minimal HTTP server for the genetic harness.
 *
 * Serves:
 *   GET /api/leaderboard   — leaderboard JSON
 *   GET /api/state         — current arena state
 *   GET /                  — simple status page
 */

import type { ArchivedBot } from './shared/types.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

let leaderboard: ArchivedBot[] = [];

function getLeaderboard(): ArchivedBot[] {
  return leaderboard
    .sort((a, b) => b.fitness.fitnessScore - a.fitness.fitnessScore)
    .slice(0, 50);
}

// Simple in-memory JSON server using Node's built-in http module
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

// Simple in-memory JSON server using Node's built-in http module
/** The HTTP server instance — serves leaderboard, state, and status pages */
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const data = getLeaderboard();
    res.writeHead(200);
    res.end(JSON.stringify({ count: data.length, results: data }));
    return;
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    // Placeholder: in a real implementation this would expose live game state
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'running', leaderboardSize: leaderboard.length }));
    return;
  }

  if (url.pathname === '/' && req.method === 'GET') {
    const html = `<!DOCTYPE html>
<html><head><title>Genetic Harness</title></head>
<body>
  <h1>Genetic Harness</h1>
  <p>LLM-evolved game controllers for multiplayer Asteroids.</p>
  <h2>Leaderboard</h2>
  <div id="leaderboard"></div>
  <script>
    fetch('/api/leaderboard').then(r => r.json()).then(d => {
      const el = document.getElementById('leaderboard');
      el.innerHTML = d.results.map(b =>
        '<div><b>' + b.shipId + '</b> — score: ' + b.fitness.fitnessScore.toFixed(2) +
        ' | win rate: ' + (b.fitness.winRate * 100).toFixed(1) + '%' +
        ' | fuel/tick: ' + b.fitness.avgFuelPerTick.toFixed(0) + '</div>'
      ).join('');
    });
  </script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Genetic harness server running on http://localhost:${PORT}`);
});

// Export for programmatic use

/**
 * Set the current leaderboard data.
 *
 * Called by the evolution runner to update the in-memory leaderboard
 * after each generation. The HTTP server reads this for the /api/leaderboard endpoint.
 *
 * @param data - Sorted array of ArchivedBots (top performers)
 */
export function setLeaderboard(data: ArchivedBot[]) {
  leaderboard = data;
}

export { server };
