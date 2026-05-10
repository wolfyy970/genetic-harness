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

async function authedFetch(url, init = {}) {
  const headers = new Headers(init.headers ?? {});
  const token = getStoredToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    const next = window.prompt('Enter HARNESS_TOKEN');
    if (next) {
      setStoredToken(next);
      const headers2 = new Headers(init.headers ?? {});
      headers2.set('Authorization', `Bearer ${next}`);
      return fetch(url, { ...init, headers: headers2 });
    }
  }
  return res;
}

const POLL_MS = 2000;
const PLAYBACK_FPS = 20; // tick rate for the player; matches arena's 50ms tickMs.

const els = {
  status: document.getElementById('status'),
  leaderboardBody: document.querySelector('#leaderboard tbody'),
  replaySelect: document.getElementById('replay-select'),
  scrubber: document.getElementById('scrubber'),
  playPause: document.getElementById('play-pause'),
  frameInfo: document.getElementById('frame-info'),
  canvas: document.getElementById('canvas'),
  legend: document.getElementById('legend'),
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

function rebuildReplayDropdown() {
  const replays = allReplays();
  const filtered = selectedShipId
    ? replays.filter((r) => r.shipId === selectedShipId)
    : replays;
  const list = filtered.length > 0 ? filtered : replays;

  els.replaySelect.innerHTML = '';
  if (list.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no replays — enable recordReplays in your run)';
    els.replaySelect.appendChild(opt);
    return;
  }
  for (const r of list) {
    const opt = document.createElement('option');
    opt.value = `${r.generation}|${matchIdFromPath(r.path)}`;
    opt.textContent = `gen ${r.generation} · ${r.shipId} vs ${r.opponent} · fit=${r.fitness.toFixed(3)}`;
    els.replaySelect.appendChild(opt);
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
  viewer.paint(ctx, frames[idx], {
    width: els.canvas.width,
    height: els.canvas.height,
    heroShipId,
  });
  els.scrubber.value = String(idx);
  els.frameInfo.textContent = `${idx + 1} / ${frames.length}`;
}

// ---- playback loop -------------------------------------------------------

function playLoop(ts) {
  if (!playing) return;
  if (!currentReplay) {
    playing = false;
    return;
  }
  const interval = 1000 / PLAYBACK_FPS;
  if (ts - lastTickAt >= interval) {
    lastTickAt = ts;
    frameIndex += 1;
    if (frameIndex >= (currentReplay.frames?.length ?? 0)) {
      frameIndex = 0;
    }
    paintCurrentFrame();
  }
  requestAnimationFrame(playLoop);
}

function togglePlay() {
  playing = !playing;
  els.playPause.textContent = playing ? '⏸' : '▶';
  if (playing) {
    lastTickAt = 0;
    requestAnimationFrame(playLoop);
  }
}

// ---- selection -----------------------------------------------------------

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderBotSource(shipId) {
  if (!els.botSourcePanel || !els.botSourceName || !els.botSourceCode) return;

  if (!shipId) {
    els.botSourcePanel.classList.remove('active');
    return;
  }

  const bot = leaderboard.find((b) => (b.shipId ?? b.id) === shipId);
  if (!bot || !bot.source) {
    els.botSourceName.textContent = shipId;
    els.botSourceCode.textContent = 'No source code available for this bot.';
    els.botSourcePanel.classList.add('active');
    return;
  }

  els.botSourceName.textContent = `${bot.shipId ?? bot.id} · gen ${bot.metadata?.generation ?? 0} · fitness ${fmt(bot.fitness?.fitnessScore, 3)}`;
  els.botSourceCode.innerHTML = escapeHtml(bot.source);
  els.botSourcePanel.classList.add('active');
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
    if (body?.empty) {
      manifest = null;
    } else {
      manifest = body;
    }
    rebuildReplayDropdown();
    renderGrid();
    renderCharts();
  } catch (err) {
    /* leave previous manifest in place */
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

let modelFetchStatus = '';

function setModelStatus(msg) {
  modelFetchStatus = msg;
  const modelInput = els.runForm?.elements?.namedItem('llmModel');
  if (modelInput) modelInput.placeholder = msg || 'loading…';
}

async function fetchModels(baseUrl) {
  console.log('fetchModels called with baseUrl:', baseUrl);
  if (!baseUrl || baseUrl === 'mock') {
    console.log('Early return - baseUrl is empty or mock');
    return { models: [], error: null };
  }
  try {
    setModelStatus('fetching models…');
    // Ask our own server to proxy the request; avoids CORS when the LLM
    // server doesn't send Access-Control-Allow-Origin headers.
    console.log('Fetching from /api/models');
    const res = await authedFetch('/api/models');
    console.log('Response status:', res.status);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = body.error?.message || `HTTP ${res.status}`;
      setModelStatus(`models: ${err}`);
      return { models: [], error: err };
    }
    const body = await res.json();
    console.log('Response body:', body);
    const models = (body.data ?? [])
      .filter((m) => m.object === 'model' || m.id)
      .map((m) => m.id)
      .filter(Boolean);
    console.log('Parsed models:', models.length, models);
    setModelStatus(`${models.length} models found`);
    return { models, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('fetchModels error:', msg);
    setModelStatus(`models: ${msg}`);
    return { models: [], error: msg };
  }
}

function populateModelSelect(models) {
  console.log('populateModelSelect called with', models?.length, 'models');
  const select = document.getElementById('model-select');
  if (!select) {
    console.error('Select element not found!');
    return;
  }
  // Keep the first "Select a model..." option
  const placeholder = select.options[0];
  select.innerHTML = '';
  select.appendChild(placeholder);
  
  if (!models || models.length === 0) {
    console.log('No models to populate');
    return;
  }
  for (const id of models) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    select.appendChild(opt);
  }
  console.log('Populated select with', select.options.length - 1, 'options');
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
    if (!res.ok) {
      console.error('Failed to load defaults:', res.status);
      return;
    }
    const body = await res.json();
    console.log('Loaded defaults:', body);
    const modelSelect = document.getElementById('model-select');
    const baseInput = els.runForm.elements.namedItem('llmBaseUrl');
    
    if (baseInput && !baseInput.value) baseInput.value = body.llmBaseUrl ?? '';
    if (baseInput) baseInput.placeholder = body.llmBaseUrl ?? '';
    
    // Store the default model to select after population
    const defaultModel = body.llmModel ?? '';
    
    console.log('About to refresh models with baseUrl:', baseInput?.value);
    await refreshModelList();
    
    // Select the default model if it exists in the list
    if (modelSelect && defaultModel) {
      const options = Array.from(modelSelect.options);
      const match = options.find(opt => opt.value === defaultModel);
      if (match) {
        modelSelect.value = defaultModel;
      }
    }
  } catch (err) {
    console.error('Error in loadDefaults:', err);
  }
}

async function startRun(event) {
  event.preventDefault();
  const form = new FormData(els.runForm);
  const useMock = form.get('useMockLLM') === 'on';
  const llmModel = (form.get('llmModel') ?? '').toString().trim();
  const llmBaseUrl = (form.get('llmBaseUrl') ?? '').toString().trim();
  const overrides = {
    maxGenerations: Number(form.get('maxGenerations')) || 3,
    islandCount: Number(form.get('islandCount')) || 2,
    mode: form.get('mode') ?? 'pure',
    recordReplays: form.get('recordReplays') === 'on',
    // Mock mode wins over llmBaseUrl: when checked, force the mock mutator;
    // otherwise pass the user's chosen baseUrl + model verbatim. Empty
    // strings fall through to the env / DEFAULT_CONFIG layers.
    llmBaseUrl: useMock ? 'mock' : llmBaseUrl || undefined,
    llmModel: useMock ? undefined : llmModel || undefined,
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
  await Promise.all([pollManifest(), pollLeaderboard(), pollRuns()]);
}

// ---- wire up -------------------------------------------------------------

els.replaySelect.addEventListener('change', () => {
  void loadSelectedReplay();
});
els.scrubber.addEventListener('input', () => {
  frameIndex = parseInt(els.scrubber.value, 10) || 0;
  paintCurrentFrame();
});
els.playPause.addEventListener('click', togglePlay);
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
    const res = await fetch('/api/state');
    if (!res.ok) return;
    const body = await res.json();
    const startTime = body?.serverStartTime;
    if (!startTime) return;
    if (lastServerStartTime && lastServerStartTime !== startTime) {
      console.log('[livereload] Server restarted — reloading page');
      window.location.reload();
      return;
    }
    lastServerStartTime = startTime;
  } catch {
    // Server might be restarting; check again next interval
  }
}

// First check after a short delay to let the page settle.
setTimeout(() => {
  void checkLiveReload();
  setInterval(checkLiveReload, LIVERELOAD_INTERVAL_MS);
}, 1000);
