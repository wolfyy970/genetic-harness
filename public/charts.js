// Tiny SVG chart primitives. No deps. Reused for the win-rate-over-gen
// line and the fuel-vs-fitness scatter.

const NS = 'http://www.w3.org/2000/svg';

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function bounds(values, fallback = 1) {
  if (values.length === 0) return { min: 0, max: fallback };
  let min = Infinity, max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { min: 0, max: fallback };
  if (min === max) return { min: min - 1, max: max + 1 };
  return { min, max };
}

/**
 * Render a multi-series line chart into an SVG element.
 * series: [{ label, color, points: [{x, y}] }]
 */
export function lineChart(svg, { series, xLabel = '', yLabel = '' } = {}) {
  clearSvg(svg);
  const w = svg.clientWidth || 400;
  const h = svg.clientHeight || 200;
  const pad = { top: 12, right: 12, bottom: 24, left: 36 };
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const allX = series.flatMap((s) => s.points.map((p) => p.x));
  const allY = series.flatMap((s) => s.points.map((p) => p.y));
  const xb = bounds(allX);
  const yb = bounds(allY);

  const xScale = (x) =>
    pad.left + ((x - xb.min) / (xb.max - xb.min)) * (w - pad.left - pad.right);
  const yScale = (y) =>
    h - pad.bottom - ((y - yb.min) / (yb.max - yb.min)) * (h - pad.top - pad.bottom);

  // Axes
  svg.appendChild(svgEl('line', {
    x1: pad.left, y1: pad.top, x2: pad.left, y2: h - pad.bottom,
    stroke: '#1f2a44',
  }));
  svg.appendChild(svgEl('line', {
    x1: pad.left, y1: h - pad.bottom, x2: w - pad.right, y2: h - pad.bottom,
    stroke: '#1f2a44',
  }));

  // y-axis ticks (3 stops)
  for (const t of [0, 0.5, 1]) {
    const yv = yb.min + t * (yb.max - yb.min);
    const yp = yScale(yv);
    svg.appendChild(svgEl('line', {
      x1: pad.left - 3, y1: yp, x2: pad.left, y2: yp, stroke: '#1f2a44',
    }));
    const lbl = svgEl('text', {
      x: pad.left - 6, y: yp + 4,
      'text-anchor': 'end', fill: '#8a93a6', 'font-size': 10,
    });
    lbl.textContent = yv.toFixed(2);
    svg.appendChild(lbl);
  }

  // axis labels
  if (xLabel) {
    const t = svgEl('text', {
      x: w - pad.right, y: h - 6, 'text-anchor': 'end',
      fill: '#8a93a6', 'font-size': 10,
    });
    t.textContent = xLabel;
    svg.appendChild(t);
  }
  if (yLabel) {
    const t = svgEl('text', {
      x: pad.left, y: 10, 'text-anchor': 'start',
      fill: '#8a93a6', 'font-size': 10,
    });
    t.textContent = yLabel;
    svg.appendChild(t);
  }

  for (const s of series) {
    if (s.points.length === 0) continue;
    const d = s.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(p.x)} ${yScale(p.y)}`)
      .join(' ');
    svg.appendChild(svgEl('path', {
      d, fill: 'none', stroke: s.color ?? '#7dd3fc', 'stroke-width': 1.5,
    }));
    for (const p of s.points) {
      svg.appendChild(svgEl('circle', {
        cx: xScale(p.x), cy: yScale(p.y), r: 2.5, fill: s.color ?? '#7dd3fc',
      }));
    }
  }
}

/**
 * Render a scatter plot. points: [{x, y, label?}]
 */
export function scatter(svg, { points, color = '#ffd166', xLabel = '', yLabel = '' } = {}) {
  clearSvg(svg);
  const w = svg.clientWidth || 400;
  const h = svg.clientHeight || 200;
  const pad = { top: 12, right: 12, bottom: 24, left: 36 };
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const xb = bounds(points.map((p) => p.x));
  const yb = bounds(points.map((p) => p.y));
  const xScale = (x) =>
    pad.left + ((x - xb.min) / (xb.max - xb.min)) * (w - pad.left - pad.right);
  const yScale = (y) =>
    h - pad.bottom - ((y - yb.min) / (yb.max - yb.min)) * (h - pad.top - pad.bottom);

  svg.appendChild(svgEl('line', {
    x1: pad.left, y1: pad.top, x2: pad.left, y2: h - pad.bottom, stroke: '#1f2a44',
  }));
  svg.appendChild(svgEl('line', {
    x1: pad.left, y1: h - pad.bottom, x2: w - pad.right, y2: h - pad.bottom, stroke: '#1f2a44',
  }));

  if (xLabel) {
    const t = svgEl('text', {
      x: w - pad.right, y: h - 6, 'text-anchor': 'end',
      fill: '#8a93a6', 'font-size': 10,
    });
    t.textContent = xLabel;
    svg.appendChild(t);
  }
  if (yLabel) {
    const t = svgEl('text', {
      x: pad.left, y: 10, 'text-anchor': 'start',
      fill: '#8a93a6', 'font-size': 10,
    });
    t.textContent = yLabel;
    svg.appendChild(t);
  }

  for (const p of points) {
    const c = svgEl('circle', {
      cx: xScale(p.x), cy: yScale(p.y), r: 3, fill: color,
      'fill-opacity': 0.7,
    });
    if (p.label) {
      const title = svgEl('title');
      title.textContent = p.label;
      c.appendChild(title);
    }
    svg.appendChild(c);
  }
}

/**
 * Render the MAP-Elites heatmap as a CSS grid with cells colored by
 * fitness (0..1 → light to bright). Empty cells get the neutral panel bg.
 *
 * cells: [{ aggressionBucket, fuelBucket, fitness, shipId, generation }]
 * onClick(cell) is invoked when the user clicks a populated cell.
 */
export function gridHeatmap(container, cells, { rows = 4, cols = 8, onClick } = {}) {
  container.innerHTML = '';
  container.style.display = 'grid';
  container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  container.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  container.style.gap = '2px';

  // Index cells by `${row}-${col}`.
  const byKey = new Map();
  let maxFitness = -Infinity;
  for (const c of cells) {
    if (Number.isFinite(c.fitness) && c.fitness > maxFitness) maxFitness = c.fitness;
    byKey.set(`${c.aggressionBucket}-${c.fuelBucket}`, c);
  }
  if (maxFitness === -Infinity) maxFitness = 1;

  // Render rows top-to-bottom by aggression descending so high-aggression
  // sits on top (matches user intuition about "spam fire" being the
  // headline strategy).
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = 0; c < cols; c++) {
      const cell = byKey.get(`${r}-${c}`);
      const div = document.createElement('div');
      div.className = 'grid-cell';
      if (cell) {
        const t = Math.max(0, Math.min(1, cell.fitness / maxFitness));
        const lightness = 30 + 50 * t;
        div.style.background = `hsl(${190 + 20 * t}, 70%, ${lightness}%)`;
        // Human-readable bucket labels: aggression 0..3 = none/light/medium/heavy fire;
        // fuel 0..7 = log2 ns/tick bands. Tooltip carries best-fitness bot + gen.
        const aggrLabel = ['quiet (0% fire)', 'light fire', 'medium fire', 'spam fire'][r] ?? `agg=${r}`;
        const fuelLabel = `~${Math.round(Math.pow(2, c * 2) / 1000)}µs/tick`;
        div.title =
          `${aggrLabel} · ${fuelLabel}\n` +
          `best: ${cell.shipId} (gen ${cell.generation}) · fitness ${cell.fitness.toFixed(3)}`;
        div.dataset.shipId = cell.shipId;
        div.dataset.generation = String(cell.generation);
        if (onClick) div.addEventListener('click', () => onClick(cell));
      } else {
        div.style.background = '#11172a';
        div.title = 'empty cell — no bot in this aggression × fuel band';
      }
      container.appendChild(div);
    }
  }
}
