// genetic-harness dashboard. Vanilla JS, no bundler.
//
// Responsibilities:
//   - Poll /api/manifest + /api/leaderboard.
//   - Render the leaderboard table.
//   - Render the MAP-Elites grid heatmap + generation charts.
//   - Drive the replay player: dropdown, scrubber, play/pause, RAF loop.
//   - Per-arena viewer is loaded dynamically based on manifest.arena.

import { lineChart, scatter, gridHeatmap } from '/static/charts.js';

// ---- auth ----------------------------------------------------------------
// When the server is started with HARNESS_TOKEN set, every /api/* request
// must carry `Authorization: Bearer <token>`. We prompt once on first 401
// and stash the token in localStorage.

const TOKEN_KEY = 'harness-token';

function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setStoredToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** Show the auth banner; called whenever a 401 lands. */
function showAuthBanner(errorText) {
  const banner = document.getElementById('auth-banner');
  const err = document.getElementById('auth-error');
  if (banner) banner.hidden = false;
  if (err) {
    if (errorText) {
      err.hidden = false;
      err.textContent = errorText;
    } else {
      err.hidden = true;
    }
  }
}

/** Hide the auth banner; called once an authed request succeeds. */
function hideAuthBanner() {
  const banner = document.getElementById('auth-banner');
  if (banner) banner.hidden = true;
  const status = document.getElementById('auth-status');
  if (status && getStoredToken()) status.hidden = false;
}

async function authedFetch(url, init = {}) {
  const headers = new Headers(init.headers ?? {});
  const token = getStoredToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    showAuthBanner(token ? 'Token rejected — try again' : null);
  } else if (res.ok) {
    hideAuthBanner();
  }
  return res;
}

const POLL_MS = 2000;
const BASE_PLAYBACK_FPS = 20; // tick rate for the player; matches arena's 50ms tickMs.

const els = {
  status: document.getElementById('status'),
  leaderboardBody: document.querySelector('#leaderboard tbody'),
  replaySelect: document.getElementById('replay-select'),
  filterGeneration: document.getElementById('filter-generation'),
  filterTopology: document.getElementById('filter-topology'),
  filterHeroOnly: document.getElementById('filter-hero-only'),
  scrubber: document.getElementById('scrubber'),
  playPause: document.getElementById('play-pause'),
  stepFirst: document.getElementById('step-first'),
  stepPrev: document.getElementById('step-prev'),
  stepNext: document.getElementById('step-next'),
  stepLast: document.getElementById('step-last'),
  restartBtn: document.getElementById('restart'),
  speedSelect: document.getElementById('speed-select'),
  loopToggle: document.getElementById('loop-toggle'),
  loopIndicator: document.getElementById('loop-indicator'),
  frameInfo: document.getElementById('frame-info'),
  tickInfo: document.getElementById('tick-info'),
  aliveInfo: document.getElementById('alive-info'),
  speedInfo: document.getElementById('speed-info'),
  playerPanel: document.getElementById('player-panel'),
  canvas: document.getElementById('canvas'),
  legend: document.getElementById('legend'),
  scoreboard: document.getElementById('scoreboard'),
  scoreboardRows: document.getElementById('scoreboard-rows'),
  archiveState: document.getElementById('archive-state'),
  clearArchiveLabel: document.getElementById('clear-archive-label'),
  seedFromArchiveLabel: document.getElementById('seed-from-archive-label'),
  grid: document.getElementById('grid'),
  chartWinRate: document.getElementById('chart-winrate'),
  chartScatter: document.getElementById('chart-scatter'),
  runForm: document.getElementById('run-form'),
  runStatus: document.getElementById('run-status'),
  startButton: document.getElementById('start-run'),
  stopButton: document.getElementById('stop-run'),
  refreshModels: document.getElementById('refresh-models'),
  botSourcePanel: document.getElementById('bot-source-panel'),
  botSourceName: document.getElementById('bot-source-name'),
  botSourceCode: document.getElementById('bot-source-code'),
  copySourceBtn: document.getElementById('copy-source'),
};
const ctx = els.canvas.getContext('2d');

let viewer = null;        // imported per-arena module
let manifest = null;      // last fetched manifest
let leaderboard = [];     // last fetched leaderboard
let currentReplay = null; // currently loaded ReplayFile
let frameIndex = 0;
let playing = false;
let lastTickAt = 0;
let selectedShipId = null;
let playbackSpeed = 1;    // 0.25 / 0.5 / 1 / 2 / 4
let loopEnabled = true;
let highlightedShipId = null; // for scoreboard ↔ canvas hover sync

/** Deterministic per-ship colour matching the viewer's hash palette. */
const SHIP_PALETTE = [
  '#7dd3fc', '#f87171', '#fbbf24', '#a3e635',
  '#c084fc', '#34d399', '#fb7185', '#60a5fa',
];
function shipColour(id, isHero) {
  if (isHero) return SHIP_PALETTE[0];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return SHIP_PALETTE[Math.abs(h) % SHIP_PALETTE.length];
}

// ---- formatting ----------------------------------------------------------

function fmt(n, digits = 2) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}
function fmtPct(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}
function fmtFuel(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—';
  return Math.round(n).toLocaleString();
}

// ---- leaderboard ---------------------------------------------------------

function renderLeaderboard(rows) {
  els.leaderboardBody.innerHTML = '';
  if (rows.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.className = 'empty';
    td.textContent = 'No data yet — run `npm run smoke` (or evolve via the API).';
    tr.appendChild(td);
    els.leaderboardBody.appendChild(tr);
    return;
  }
  rows.forEach((bot, i) => {
    const tr = document.createElement('tr');
    tr.dataset.shipId = bot.shipId ?? bot.id ?? '';
    if (tr.dataset.shipId === selectedShipId) tr.classList.add('selected');
    const cells = [
      String(i + 1),
      bot.shipId ?? bot.id ?? '',
      fmt(bot.fitness?.fitnessScore, 3),
      fmtPct(bot.fitness?.winRate),
      fmtFuel(bot.fitness?.avgFuelPerTick),
      String(bot.fitness?.totalMatches ?? 0),
      String(bot.metadata?.generation ?? 0),
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => selectShip(tr.dataset.shipId));
    els.leaderboardBody.appendChild(tr);
  });
}

// ---- replay listing & loading -------------------------------------------

function allReplays() {
  if (!manifest?.generations) return [];
  const out = [];
  for (const g of manifest.generations) {
    for (const r of g.replays) {
      out.push({ ...r, generation: g.generation });
    }
  }
  // Latest generations first.
  out.sort((a, b) => b.generation - a.generation);
  return out;
}

/** Available generation numbers, latest first. Empty when no manifest. */
function availableGenerations() {
  if (!manifest?.generations) return [];
  return manifest.generations
    .map((g) => g.generation)
    .sort((a, b) => b - a);
}

/** Refresh the generation-filter <select> options whenever the manifest changes. */
function rebuildGenerationFilter() {
  const sel = els.filterGeneration;
  if (!sel) return;
  const prev = sel.value;
  const gens = availableGenerations();
  sel.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'all';
  sel.appendChild(allOpt);
  if (gens.length > 0) {
    const latestOpt = document.createElement('option');
    latestOpt.value = 'latest';
    latestOpt.textContent = `latest (gen ${gens[0]})`;
    sel.appendChild(latestOpt);
    for (const g of gens) {
      const opt = document.createElement('option');
      opt.value = String(g);
      opt.textContent = `gen ${g}`;
      sel.appendChild(opt);
    }
  }
  // Restore previous selection if still valid; otherwise default to "latest".
  if (Array.from(sel.options).some((o) => o.value === prev)) {
    sel.value = prev;
  } else {
    sel.value = gens.length > 0 ? 'latest' : 'all';
  }
}

/** Pretty-format one replay entry's dropdown label. */
function replayLabel(r) {
  const topology = r.topology ?? '1v1';
  const heroRank = (r.ranks ?? []).find((x) => x.refId === r.shipId);
  // Outcome emoji from rank (lower = better). Sole survivor still counts as 🥇.
  let outcomeIcon = '';
  if (heroRank) {
    const total = r.ranks.length;
    if (heroRank.rank === 1) outcomeIcon = '🥇';
    else if (heroRank.rank <= Math.ceil(total / 3)) outcomeIcon = '🥈';
    else if (heroRank.rank <= Math.ceil((2 * total) / 3)) outcomeIcon = '·';
    else outcomeIcon = '💀';
  }
  const scorePart = heroRank ? ` · score ${heroRank.score}` : ` · fit=${(r.fitness ?? 0).toFixed(3)}`;
  const rankPart = heroRank ? ` (rank ${heroRank.rank}/${r.ranks.length})` : '';
  const seedPart = r.seed !== undefined ? ` · seed ${r.seed}` : '';
  return `gen ${r.generation} · ${outcomeIcon} ${r.shipId} · ${topology}${scorePart}${rankPart}${seedPart}`.trim();
}

function rebuildReplayDropdown() {
  const replays = allReplays();
  const genFilter = els.filterGeneration?.value ?? 'all';
  const topoFilter = els.filterTopology?.value ?? 'all';
  const heroOnly = !!els.filterHeroOnly?.checked;

  let filtered = replays;
  if (genFilter !== 'all') {
    if (genFilter === 'latest') {
      const latestGen = filtered[0]?.generation;
      filtered = filtered.filter((r) => r.generation === latestGen);
    } else {
      const gen = Number(genFilter);
      filtered = filtered.filter((r) => r.generation === gen);
    }
  }
  if (topoFilter !== 'all') {
    filtered = filtered.filter((r) => (r.topology ?? '1v1') === topoFilter);
  }
  if (heroOnly && selectedShipId) {
    filtered = filtered.filter((r) => r.shipId === selectedShipId);
  }

  // Preserve the user's current selection if still in the list.
  const prevValue = els.replaySelect.value;

  els.replaySelect.innerHTML = '';
  if (filtered.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent =
      replays.length === 0
        ? '(no replays — enable recordReplays in your run)'
        : '(no replays match these filters)';
    els.replaySelect.appendChild(opt);
    return;
  }
  for (const r of filtered) {
    const opt = document.createElement('option');
    opt.value = `${r.generation}|${matchIdFromPath(r.path)}`;
    opt.textContent = replayLabel(r);
    els.replaySelect.appendChild(opt);
  }

  if (Array.from(els.replaySelect.options).some((o) => o.value === prevValue)) {
    els.replaySelect.value = prevValue;
  }
}

function matchIdFromPath(path) {
  // generations/gen-NNNN/<matchId>.json
  const file = path.split('/').pop() ?? '';
  return file.replace(/\.json$/, '');
}

async function loadSelectedReplay() {
  const value = els.replaySelect.value;
  if (!value) return;
  const [gen, matchId] = value.split('|');
  const res = await authedFetch(`/api/replays/${encodeURIComponent(gen)}/${encodeURIComponent(matchId)}`);
  if (!res.ok) {
    els.frameInfo.textContent = `error: ${res.status}`;
    return;
  }
  currentReplay = await res.json();
  frameIndex = 0;
  els.scrubber.min = '0';
  els.scrubber.max = String(Math.max(0, (currentReplay.frames?.length ?? 1) - 1));
  els.scrubber.value = '0';
  selectedShipId =
    currentReplay.participants?.find((p) => p.role === 'candidate')?.refId ?? selectedShipId;
  await ensureViewer(currentReplay.arena);
  paintCurrentFrame();
}

async function ensureViewer(arenaName) {
  if (viewer && viewer._arena === arenaName) return;
  try {
    const mod = await import(`/static/viewers/${arenaName}.js`);
    viewer = { ...mod, _arena: arenaName };
    // Canvas internal size = viewer's stated "drawing surface" resolution.
    // The viewer then applies a world→canvas scale internally based on
    // the per-frame `meta.worldWidth/Height` we pass — positions get
    // scaled (so a ship at world x=2400 lands on the canvas), but ship
    // glyphs stay in canvas pixels so they remain visible at human size.
    if (mod.dimensions) {
      els.canvas.width = mod.dimensions.width;
      els.canvas.height = mod.dimensions.height;
    }
    renderLegend();
  } catch (err) {
    els.frameInfo.textContent = `no viewer for arena "${arenaName}"`;
  }
}

function renderLegend() {
  els.legend.innerHTML = '';
  if (!viewer?.legend) return;
  for (const item of viewer.legend()) {
    const span = document.createElement('span');
    span.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = item.color;
    span.appendChild(swatch);
    span.appendChild(document.createTextNode(item.label));
    els.legend.appendChild(span);
  }
}

function paintCurrentFrame() {
  if (!currentReplay || !viewer?.paint) return;
  const frames = currentReplay.frames ?? [];
  if (frames.length === 0) return;
  const idx = Math.max(0, Math.min(frames.length - 1, frameIndex));
  const heroShipId = 'ship-0'; // candidate slot in our match config
  const frame = frames[idx];
  viewer.paint(ctx, frame, {
    width: els.canvas.width,
    height: els.canvas.height,
    // World dimensions from the recorded match — the viewer uses these
    // to compute a world→canvas scale so the full play area maps onto
    // the canvas regardless of how big the world is.
    worldWidth: currentReplay.config?.worldWidth ?? els.canvas.width,
    worldHeight: currentReplay.config?.worldHeight ?? els.canvas.height,
    heroShipId,
    highlightShipId: highlightedShipId,
  });
  els.scrubber.value = String(idx);
  els.frameInfo.textContent = `frame ${idx + 1} / ${frames.length}`;
  if (els.tickInfo) {
    const tick = typeof frame.tick === 'number' ? frame.tick : idx;
    els.tickInfo.textContent = `tick ${tick}`;
  }
  if (els.aliveInfo) {
    const ships = (frame.entities ?? []).filter((e) => e.type === 'ship');
    const alive = ships.filter((s) => (s.health ?? 0) > 0).length;
    els.aliveInfo.textContent = `alive ${alive} / ${ships.length}`;
  }
  if (els.speedInfo) {
    els.speedInfo.textContent = `${playbackSpeed}×`;
  }
  renderScoreboard(frame);
}

/** Per-ship scoreboard. Renders 8 rows for an 8-ship FFA replay. */
function renderScoreboard(frame) {
  if (!els.scoreboardRows || !currentReplay) return;
  const heroId = 'ship-0';
  const participants = currentReplay.participants ?? [];

  // Index live ships by id from the current frame. A ship missing from the
  // frame has been destroyed (renderer drops dead ships from entities[]).
  const liveById = new Map();
  for (const e of frame.entities ?? []) {
    if (e.type === 'ship') liveById.set(e.id, e);
  }

  // Build one row per participant (always 8 in an FFA, regardless of how
  // many are still alive this frame). Sort by current score desc; alive
  // ships ahead of dead-tied-on-score.
  const rows = participants.map((p) => {
    const live = liveById.get(p.shipId) ?? null;
    const alive = live !== null;
    // Last-known score from the live entity; for dead bots, we don't have
    // a per-frame score after death — fall back to final shipReport score.
    const finalReport = currentReplay.shipReports?.find((r) => r.shipId === p.shipId);
    const score = live?.score ?? finalReport?.score ?? 0;
    return { participant: p, live, alive, score };
  });
  rows.sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return b.score - a.score;
  });

  // Wipe and re-render. Cheap at 8 rows.
  els.scoreboardRows.innerHTML = '';
  rows.forEach(({ participant, live, alive, score }) => {
    const shipId = participant.shipId;
    const isHero = shipId === heroId;
    const refId = participant.refId ?? shipId;
    const colour = shipColour(shipId, isHero);

    const row = document.createElement('div');
    row.className = 'scoreboard-row';
    if (isHero) row.classList.add('hero');
    if (!alive) row.classList.add('dead');
    if (highlightedShipId === shipId) row.classList.add('highlight');
    row.dataset.shipId = shipId;

    const swatch = document.createElement('span');
    swatch.className = 'scoreboard-swatch';
    swatch.style.background = colour;
    row.appendChild(swatch);

    const name = document.createElement('span');
    name.className = 'scoreboard-name';
    name.textContent = `${isHero ? '★ ' : ''}${refId}${alive ? '' : ' ✕'}`;
    row.appendChild(name);

    const stats = document.createElement('span');
    stats.className = 'scoreboard-stats';
    const hp = live ? Math.max(0, Math.round(live.health ?? 0)) : 0;
    const scoreStr = `<span class="score">${score}</span>`;
    const hpStr = alive ? `<span class="hp">hp ${hp}</span>` : '<span class="hp">DEAD</span>';
    stats.innerHTML = `${scoreStr} · ${hpStr}`;
    row.appendChild(stats);

    // Hover-to-highlight: drives a CSS class the viewer reads via `meta`.
    // Dead ships can still be hovered — but the canvas won't have anything
    // to draw a glow around, so it's effectively a no-op visually.
    row.addEventListener('mouseenter', () => {
      highlightedShipId = shipId;
      els.canvas.dataset.highlight = shipId;
      els.scoreboardRows.querySelectorAll('.scoreboard-row.highlight')
        .forEach((el) => el.classList.remove('highlight'));
      row.classList.add('highlight');
    });
    row.addEventListener('mouseleave', () => {
      highlightedShipId = null;
      els.canvas.dataset.highlight = '';
      row.classList.remove('highlight');
    });

    els.scoreboardRows.appendChild(row);
  });
}

// ---- playback loop -------------------------------------------------------

function playLoop(ts) {
  if (!playing) return;
  if (!currentReplay) {
    playing = false;
    return;
  }
  const interval = 1000 / (BASE_PLAYBACK_FPS * playbackSpeed);
  if (ts - lastTickAt >= interval) {
    lastTickAt = ts;
    frameIndex += 1;
    const total = currentReplay.frames?.length ?? 0;
    if (frameIndex >= total) {
      if (loopEnabled) {
        frameIndex = 0;
        flashLoopIndicator();
      } else {
        // Pin to last frame and stop playback.
        frameIndex = Math.max(0, total - 1);
        playing = false;
        els.playPause.textContent = '▶';
        paintCurrentFrame();
        return;
      }
    }
    paintCurrentFrame();
  }
  requestAnimationFrame(playLoop);
}

function togglePlay() {
  if (!currentReplay) return;
  playing = !playing;
  els.playPause.textContent = playing ? '⏸' : '▶';
  if (playing) {
    // If we're at the end, restart from frame 0 before resuming.
    const total = currentReplay.frames?.length ?? 0;
    if (frameIndex >= total - 1) frameIndex = 0;
    lastTickAt = 0;
    requestAnimationFrame(playLoop);
  }
}

function pause() {
  if (!playing) return;
  playing = false;
  els.playPause.textContent = '▶';
}

function stepFrame(delta) {
  if (!currentReplay) return;
  pause();
  const total = currentReplay.frames?.length ?? 0;
  if (total === 0) return;
  frameIndex = Math.max(0, Math.min(total - 1, frameIndex + delta));
  paintCurrentFrame();
}

function jumpFrame(idx) {
  if (!currentReplay) return;
  pause();
  const total = currentReplay.frames?.length ?? 0;
  if (total === 0) return;
  frameIndex = Math.max(0, Math.min(total - 1, idx));
  paintCurrentFrame();
}

function restartReplay() {
  if (!currentReplay) return;
  frameIndex = 0;
  paintCurrentFrame();
  // Auto-play after restart for the common "watch again" case.
  if (!playing) togglePlay();
}

function flashLoopIndicator() {
  if (!els.loopIndicator) return;
  els.loopIndicator.classList.remove('flash');
  // Force reflow so the animation restarts.
  void els.loopIndicator.offsetWidth;
  els.loopIndicator.classList.add('flash');
}

function setPlaybackSpeed(s) {
  playbackSpeed = s;
  if (els.speedSelect) els.speedSelect.value = String(s);
  if (els.speedInfo) els.speedInfo.textContent = `${s}×`;
}

// ---- selection -----------------------------------------------------------

function renderBotSource(shipId) {
  if (!els.botSourcePanel || !els.botSourceName || !els.botSourceCode) return;

  // Panel is always visible now (paired with the leaderboard on the same
  // row). Empty state shows a placeholder so the column doesn't collapse.
  if (!shipId) {
    els.botSourceName.textContent = '—';
    els.botSourceCode.textContent = 'Click a bot in the leaderboard to inspect its source code.';
    return;
  }

  const bot = leaderboard.find((b) => (b.shipId ?? b.id) === shipId);
  if (!bot || !bot.source) {
    els.botSourceName.textContent = shipId;
    els.botSourceCode.textContent = 'No source code available for this bot.';
    return;
  }

  els.botSourceName.textContent = `${bot.shipId ?? bot.id} · gen ${bot.metadata?.generation ?? 0} · fitness ${fmt(bot.fitness?.fitnessScore, 3)}`;
  // textContent is safe by default; no manual HTML-escaping needed.
  els.botSourceCode.textContent = bot.source;
}

function selectShip(shipId) {
  if (selectedShipId === shipId) {
    selectedShipId = null;
  } else {
    selectedShipId = shipId;
  }
  renderLeaderboard(leaderboard);
  renderBotSource(selectedShipId);
  rebuildReplayDropdown();
  if (els.replaySelect.options.length > 0) {
    void loadSelectedReplay();
  }
}

// ---- polling -------------------------------------------------------------

async function pollManifest() {
  try {
    const res = await authedFetch('/api/manifest');
    if (!res.ok) return;
    const body = await res.json();
    const prevHad = manifest !== null;
    if (body?.empty) {
      manifest = null;
    } else {
      manifest = body;
    }
    rebuildGenerationFilter();
    rebuildReplayDropdown();
    renderGrid();
    renderCharts();
    // Auto-load the best replay on the first successful fetch after a
    // cold start (manifest went from null/absent → populated), if the user
    // hasn't selected anything yet.
    if (!prevHad && manifest && !currentReplay) {
      void autoLoadBestReplay();
    }
  } catch (err) {
    /* leave previous manifest in place */
  }
}

/**
 * On a cold page-load with replays available, pre-fill the player with
 * the most recently-recorded best-fitness replay. Falls back silently if
 * the manifest has no entries.
 */
async function autoLoadBestReplay() {
  // Honour persisted selection first.
  const last = (() => {
    try { return localStorage.getItem('last-replay'); } catch { return null; }
  })();
  if (last && Array.from(els.replaySelect.options).some((o) => o.value === last)) {
    els.replaySelect.value = last;
    await loadSelectedReplay();
    return;
  }
  // Otherwise pick the first option in the (already-filtered) dropdown.
  if (els.replaySelect.options.length > 0 && els.replaySelect.options[0].value) {
    await loadSelectedReplay();
  }
}

function renderGrid() {
  if (!manifest) {
    els.grid.innerHTML = '';
    return;
  }
  gridHeatmap(els.grid, manifest.mapElitesGrid ?? [], {
    rows: 4,
    cols: 8,
    onClick: (cell) => selectShip(cell.shipId),
  });
}

function renderCharts() {
  const stats = manifest?.generationStats ?? [];
  lineChart(els.chartWinRate, {
    series: [
      {
        label: 'best winRate',
        color: '#7dd3fc',
        points: stats.map((s) => ({ x: s.generation, y: s.bestWinRate })),
      },
      {
        label: 'mean fitness',
        color: '#ffd166',
        points: stats.map((s) => ({ x: s.generation, y: s.meanFitness })),
      },
    ],
    xLabel: 'generation',
  });

  // Fuel vs fitness scatter — use leaderboard so each elite is one point.
  const points = (manifest?.leaderboard ?? []).map((b) => ({
    x: b.fitness?.avgFuelPerTick ?? 0,
    y: b.fitness?.fitnessScore ?? 0,
    label: `${b.shipId} · gen ${b.metadata?.generation ?? 0}`,
  }));
  scatter(els.chartScatter, {
    points,
    color: '#ffd166',
    xLabel: 'fuel ns/tick',
    yLabel: 'fitness',
  });
}

async function pollLeaderboard() {
  try {
    const res = await authedFetch('/api/leaderboard');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    leaderboard = Array.isArray(body.results) ? body.results : [];
    renderLeaderboard(leaderboard);
    els.status.textContent = `${leaderboard.length} bots · updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    els.status.textContent = `error: ${err.message}`;
  }
}

let activeRunId = null;

async function pollRuns() {
  try {
    const res = await authedFetch('/api/runs');
    if (!res.ok) return;
    const body = await res.json();
    const runs = body.runs ?? [];
    const active = runs.find(
      (r) => r.state === 'running' || r.state === 'starting',
    );
    if (active) {
      activeRunId = active.id;
      els.runStatus.textContent = `${active.id} · ${active.state} · pid=${active.pid ?? '—'}`;
      els.startButton.disabled = true;
      els.stopButton.disabled = false;
    } else {
      activeRunId = null;
      const last = runs[0];
      if (last) {
        els.runStatus.textContent = `last: ${last.id} · ${last.state}${last.exitCode != null ? ' · exit=' + last.exitCode : ''}`;
      } else {
        els.runStatus.textContent = 'no active run';
      }
      els.startButton.disabled = false;
      els.stopButton.disabled = true;
    }
  } catch (err) {
    /* ignore */
  }
}

/**
 * Update the model `<select>`'s first option to surface fetch status.
 * The first option is the placeholder/status row — its text is what the
 * user sees when no model is picked yet.
 */
function setModelStatus(msg) {
  const select = document.getElementById('model-select');
  if (!select?.options?.length) return;
  select.options[0].textContent = msg || 'Select a model…';
}

async function fetchModels(baseUrl) {
  if (!baseUrl || baseUrl === 'mock') return { models: [], error: null };
  try {
    setModelStatus('fetching models…');
    // Ask our own server to proxy the request; avoids CORS when the LLM
    // server doesn't send Access-Control-Allow-Origin headers.
    const res = await authedFetch('/api/models');
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = body.error?.message || body.error || `HTTP ${res.status}`;
      setModelStatus(`models: ${err}`);
      return { models: [], error: String(err) };
    }
    const body = await res.json();
    const models = (body.data ?? [])
      .filter((m) => m.object === 'model' || m.id)
      .map((m) => m.id)
      .filter(Boolean);
    setModelStatus(
      models.length === 0 ? 'no models found' : `${models.length} models — pick one`,
    );
    return { models, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setModelStatus(`models: ${msg}`);
    return { models: [], error: msg };
  }
}

function populateModelSelect(models) {
  const select = document.getElementById('model-select');
  if (!select) return;
  // Preserve the first option (the status/placeholder row) and replace
  // everything after it with the new model list.
  const placeholder = select.options[0]?.cloneNode(true);
  select.innerHTML = '';
  if (placeholder) select.appendChild(placeholder);
  if (!models || models.length === 0) return;
  for (const id of models) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    select.appendChild(opt);
  }
}

async function refreshModelList() {
  const baseInput = els.runForm.elements.namedItem('llmBaseUrl');
  const baseUrl = baseInput?.value?.trim();
  const { models, error } = await fetchModels(baseUrl);
  populateModelSelect(models);
  return { models, error };
}

async function loadDefaults() {
  try {
    const res = await authedFetch('/api/defaults');
    if (!res.ok) return;
    const body = await res.json();
    const modelSelect = document.getElementById('model-select');
    const baseInput = els.runForm.elements.namedItem('llmBaseUrl');

    if (baseInput && !baseInput.value) baseInput.value = body.llmBaseUrl ?? '';
    if (baseInput) baseInput.placeholder = body.llmBaseUrl ?? '';

    const defaultModel = body.llmModel ?? '';
    await refreshModelList();
    if (modelSelect && defaultModel) {
      const match = Array.from(modelSelect.options).find(
        (opt) => opt.value === defaultModel,
      );
      if (match) modelSelect.value = defaultModel;
    }

    // Pre-populate the archive / carry-over checkboxes. localStorage wins
    // over server defaults so a user's last choice sticks across reloads.
    const clearBox = els.runForm.elements.namedItem('clearArchiveBeforeRun');
    const seedBox = els.runForm.elements.namedItem('seedFromArchive');
    const seedCount = els.runForm.elements.namedItem('seedFromArchiveCount');
    const storedClear = localStorage.getItem('clearArchiveBeforeRun');
    const storedSeed = localStorage.getItem('seedFromArchive');
    const storedSeedCount = localStorage.getItem('seedFromArchiveCount');
    if (clearBox) {
      clearBox.checked = storedClear !== null
        ? storedClear === 'true'
        : Boolean(body.clearArchiveBeforeRun);
    }
    if (seedBox) {
      seedBox.checked = storedSeed !== null
        ? storedSeed === 'true'
        : Boolean(body.seedFromArchive?.enabled);
    }
    if (seedCount) {
      const fromServer = body.seedFromArchive?.count ?? 2;
      seedCount.value = storedSeedCount !== null ? storedSeedCount : String(fromServer);
    }
    const seedModeSelect = els.runForm.elements.namedItem('seedMode');
    const storedSeedMode = localStorage.getItem('seedMode');
    if (seedModeSelect) {
      seedModeSelect.value = storedSeedMode
        ?? body.seedMode
        ?? 'diverse';
    }
  } catch {
    /* swallow — placeholder text remains visible */
  }
}

async function startRun(event) {
  event.preventDefault();
  const form = new FormData(els.runForm);
  const llmModel = (form.get('llmModel') ?? '').toString().trim();
  const llmBaseUrl = (form.get('llmBaseUrl') ?? '').toString().trim();
  const clearArchive = form.get('clearArchiveBeforeRun') === 'on';
  const seedFromArchive = form.get('seedFromArchive') === 'on';
  const seedCount = Math.max(0, Number(form.get('seedFromArchiveCount')) || 0);
  const seedMode = (form.get('seedMode') ?? 'diverse').toString();
  // Persist the user's choices so reloads remember them.
  localStorage.setItem('clearArchiveBeforeRun', clearArchive ? 'true' : 'false');
  localStorage.setItem('seedFromArchive', seedFromArchive ? 'true' : 'false');
  localStorage.setItem('seedFromArchiveCount', String(seedCount));
  localStorage.setItem('seedMode', seedMode);

  const overrides = {
    maxGenerations: Number(form.get('maxGenerations')) || 3,
    islandCount: Number(form.get('islandCount')) || 2,
    mode: form.get('mode') ?? 'pure',
    recordReplays: form.get('recordReplays') === 'on',
    clearArchiveBeforeRun: clearArchive,
    seedFromArchive: { enabled: seedFromArchive, count: seedCount },
    seedMode,
    // The dashboard always runs against the real LLM. If `llmBaseUrl` is
    // empty here, the orchestrator falls back to the server's `.env`
    // value; if that's also unset/unreachable, `runEvolution` aborts on
    // the startup probe with a clear error.
    llmBaseUrl: llmBaseUrl || undefined,
    llmModel: llmModel || undefined,
    stages: {
      syntax: true,
      quickRollout: { enabled: true, steps: 50 },
      quickGames: { enabled: true, games: 1 },
      fullTournament: { enabled: false, games: 0 },
    },
    maxIdleMs: 60_000,
    evalTimeoutMs: 60_000,
  };
  // Strip undefined so the orchestrator's defaults still apply.
  for (const k of Object.keys(overrides)) {
    if (overrides[k] === undefined) delete overrides[k];
  }
  const res = await authedFetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    els.runStatus.textContent = `start failed: ${body.error ?? res.status}`;
    return;
  }
  void pollRuns();
}

async function stopRun() {
  if (!activeRunId) return;
  await authedFetch(`/api/runs/${encodeURIComponent(activeRunId)}`, {
    method: 'DELETE',
  });
  void pollRuns();
}

async function tick() {
  await Promise.all([pollManifest(), pollLeaderboard(), pollRuns(), pollArchiveState()]);
}

/**
 * Surface "what's on disk" to the run-control form so the user can see
 * exactly what `clear archive` and `carry top N` will operate on.
 */
async function pollArchiveState() {
  if (!els.archiveState) return;
  try {
    const res = await authedFetch('/api/archive-state');
    if (!res.ok) return;
    const s = await res.json();
    renderArchiveState(s);
  } catch {
    /* keep last render */
  }
}

function renderArchiveState(s) {
  if (!els.archiveState) return;
  if (!s || !s.exists) {
    els.archiveState.classList.add('empty');
    els.archiveState.innerHTML =
      '<em>archive is empty</em> — first run will seed bots and start fresh.';
    // Checkbox labels stay short and constant — the archive-state banner
    // below carries the verbose context.
    if (els.clearArchiveLabel) els.clearArchiveLabel.textContent = 'clear archive';
    if (els.seedFromArchiveLabel) els.seedFromArchiveLabel.textContent = 'elites';
    const seedBox = els.runForm?.elements?.namedItem('seedFromArchive');
    if (seedBox) {
      seedBox.disabled = true;
      seedBox.checked = false;
    }
    const seedCount = els.runForm?.elements?.namedItem('seedFromArchiveCount');
    if (seedCount) seedCount.disabled = true;
    return;
  }
  els.archiveState.classList.remove('empty');
  const lastRunShort = s.lastRunId ? s.lastRunId.replace(/^run-/, '').slice(0, 19) : '—';
  els.archiveState.innerHTML =
    `archive holds <strong>${s.leaderboardSize}</strong> bots, ` +
    `<strong>${s.totalReplays}</strong> replays, last gen <strong>${s.lastGen}</strong> ` +
    `<span style="opacity:0.6">(run ${lastRunShort})</span>`;
  if (els.clearArchiveLabel) els.clearArchiveLabel.textContent = 'clear archive';
  if (els.seedFromArchiveLabel) {
    els.seedFromArchiveLabel.textContent = `elites (of ${s.leaderboardSize})`;
  }
  const seedBox = els.runForm?.elements?.namedItem('seedFromArchive');
  if (seedBox) seedBox.disabled = false;
  const seedCount = els.runForm?.elements?.namedItem('seedFromArchiveCount');
  if (seedCount) {
    seedCount.disabled = false;
    seedCount.max = String(Math.max(1, s.leaderboardSize));
  }
}

// ---- wire up -------------------------------------------------------------

els.replaySelect.addEventListener('change', () => {
  // Persist so a reload restores the last-played replay.
  try {
    if (els.replaySelect.value) localStorage.setItem('last-replay', els.replaySelect.value);
  } catch {
    /* ignore */
  }
  void loadSelectedReplay();
});

// Filter controls — re-build dropdown on any change.
els.filterGeneration?.addEventListener('change', rebuildReplayDropdown);
els.filterTopology?.addEventListener('change', rebuildReplayDropdown);
els.filterHeroOnly?.addEventListener('change', rebuildReplayDropdown);
els.scrubber.addEventListener('input', () => {
  // Scrubbing pauses playback so the user can inspect a precise frame.
  pause();
  frameIndex = parseInt(els.scrubber.value, 10) || 0;
  paintCurrentFrame();
});
els.playPause.addEventListener('click', togglePlay);

// Frame-step + restart transport buttons.
els.stepFirst?.addEventListener('click', () => jumpFrame(0));
els.stepPrev?.addEventListener('click', () => stepFrame(-1));
els.stepNext?.addEventListener('click', () => stepFrame(1));
els.stepLast?.addEventListener('click', () => {
  const total = currentReplay?.frames?.length ?? 0;
  jumpFrame(total - 1);
});
els.restartBtn?.addEventListener('click', restartReplay);

// Speed + loop toggles.
els.speedSelect?.addEventListener('change', () => {
  const s = parseFloat(els.speedSelect.value);
  if (Number.isFinite(s) && s > 0) setPlaybackSpeed(s);
});
els.loopToggle?.addEventListener('change', () => {
  loopEnabled = !!els.loopToggle.checked;
});

// Keyboard shortcuts. Only active when focus is on the player panel or its
// children — keeps the form fields free of accidental hotkey hijacking.
function isPlayerFocusable() {
  const active = document.activeElement;
  return els.playerPanel && (
    active === els.playerPanel ||
    els.playerPanel.contains(active)
  );
}

document.addEventListener('keydown', (ev) => {
  // Never hijack when the user is typing into a text input or select.
  const tag = (document.activeElement?.tagName ?? '').toLowerCase();
  if (['input', 'select', 'textarea'].includes(tag) && document.activeElement !== els.playerPanel) {
    return;
  }
  if (!currentReplay) return;
  if (!isPlayerFocusable() && tag !== 'body') return;
  switch (ev.key) {
    case ' ':
    case 'Spacebar':
      ev.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
      ev.preventDefault();
      stepFrame(-1);
      break;
    case 'ArrowRight':
      ev.preventDefault();
      stepFrame(1);
      break;
    case 'Home':
      ev.preventDefault();
      jumpFrame(0);
      break;
    case 'End':
      ev.preventDefault();
      jumpFrame((currentReplay.frames?.length ?? 1) - 1);
      break;
    case 'r':
    case 'R':
      ev.preventDefault();
      restartReplay();
      break;
    case 'l':
    case 'L':
      ev.preventDefault();
      loopEnabled = !loopEnabled;
      if (els.loopToggle) els.loopToggle.checked = loopEnabled;
      break;
    case '1': setPlaybackSpeed(0.25); break;
    case '2': setPlaybackSpeed(0.5); break;
    case '3': setPlaybackSpeed(1); break;
    case '4': setPlaybackSpeed(2); break;
    case '5': setPlaybackSpeed(4); break;
  }
});

// Click on the canvas to focus the player panel — makes keyboard hotkeys
// "just work" after interacting with the replay.
els.canvas?.addEventListener('click', () => {
  els.playerPanel?.focus();
});

els.runForm.addEventListener('submit', startRun);
els.stopButton.addEventListener('click', stopRun);

const baseUrlInput = els.runForm.elements.namedItem('llmBaseUrl');
if (baseUrlInput) {
  baseUrlInput.addEventListener('change', () => void refreshModelList());
}

if (els.refreshModels) {
  els.refreshModels.addEventListener('click', () => void refreshModelList());
}

if (els.copySourceBtn) {
  els.copySourceBtn.addEventListener('click', () => {
    const code = els.botSourceCode?.textContent ?? '';
    navigator.clipboard.writeText(code).catch(() => {});
    els.copySourceBtn.textContent = 'copied!';
    setTimeout(() => { els.copySourceBtn.textContent = '📋'; }, 2000);
  });
}

// Auth banner save / logout / show-on-mount-if-token-present.
const authInput = document.getElementById('auth-input');
const authSaveBtn = document.getElementById('auth-save');
const authLogoutBtn = document.getElementById('auth-logout');
const authStatusEl = document.getElementById('auth-status');

function saveTokenFromBanner() {
  const v = authInput?.value?.trim();
  if (!v) return;
  setStoredToken(v);
  authInput.value = '';
  hideAuthBanner();
  if (authStatusEl) authStatusEl.hidden = false;
  // Re-tick so a successful authed fetch can land and confirm.
  void tick();
}

authSaveBtn?.addEventListener('click', saveTokenFromBanner);
authInput?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    saveTokenFromBanner();
  }
});
authLogoutBtn?.addEventListener('click', () => {
  setStoredToken(null);
  if (authStatusEl) authStatusEl.hidden = true;
  // Force a re-fetch so the banner reappears if the server demands auth.
  void tick();
});

if (getStoredToken() && authStatusEl) authStatusEl.hidden = false;

void loadDefaults();
tick();
setInterval(tick, POLL_MS);

// ---- live reload (dev mode) ---------------------------------------------
// Polls /api/state and reloads the page when the server restarts.
// This pairs with `npm run dev` (tsx watch) so the browser auto-refreshes
// whenever backend code changes.

const LIVERELOAD_INTERVAL_MS = 3000;
let lastServerStartTime = null;

async function checkLiveReload() {
  try {
    // Use authedFetch so live-reload still works when HARNESS_TOKEN is set.
    const res = await authedFetch('/api/state');
    if (!res.ok) return;
    const body = await res.json();
    const startTime = body?.serverStartTime;
    if (!startTime) return;
    if (lastServerStartTime && lastServerStartTime !== startTime) {
      window.location.reload();
      return;
    }
    lastServerStartTime = startTime;
  } catch {
    // Server might be restarting; check again next interval.
  }
}

// First check after a short delay to let the page settle.
setTimeout(() => {
  void checkLiveReload();
  setInterval(checkLiveReload, LIVERELOAD_INTERVAL_MS);
}, 1000);
