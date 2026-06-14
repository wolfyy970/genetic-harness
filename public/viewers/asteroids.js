// Asteroids replay viewer.
//
// Per-arena viewer modules expose:
//   - dimensions: { width, height } (the canvas's drawing-surface resolution)
//   - paint(ctx, frame, meta): stateless renderer for one ReplayFrame
//   - legend(meta): array of { color, label } describing the palette
//
// Coordinate model:
//   - Replay frames carry entity positions in **world** coordinates
//     (the GameConfig.worldWidth × worldHeight, e.g. 2800 × 2100).
//   - The canvas surface is a fixed display resolution (1280 × 960 below)
//     — chosen to match a 4:3 world aspect ratio and still fit on
//     typical laptop screens after CSS scaling (width: 100%).
//   - We map world → canvas with a single scale factor per axis. Entity
//     POSITIONS get scaled, but ship/bullet/HP-bar GLYPHS stay in canvas
//     pixels so they're still visible at human size. Asteroid radii +
//     vertices are physical world objects → they scale.
//
// Adding a new arena: drop a new file under public/viewers/<arena>.js with
// the same shape. The page does `import('/static/viewers/' + arena + '.js')`.

export const dimensions = { width: 1280, height: 960 };

const PALETTE = {
  bg: '#0a0e1a',
  hero: '#7dd3fc',      // cyan — the candidate's ship
  enemy: '#f87171',     // red — reference opponents
  asteroid: '#8a8a9a',  // grey (fallback / MEDIUM)
  bullet: '#ffd166',    // amber
  hpBar: '#7dd3fc',
};

// Per-tier asteroid stroke. LARGE is brighter and thicker, SMALL is dim
// and thin — visual cue for "shoot small ones for big points".
const TIER_STROKE = {
  LARGE: { color: '#c8c8d8', width: 2.0 },
  MEDIUM: { color: '#8a8a9a', width: 1.5 },
  SMALL: { color: '#6a6a78', width: 1.0 },
};

// 8-colour palette for ship identities beyond the hero. Stable per ship id.
const SHIP_COLOURS = [
  '#7dd3fc', // cyan (hero default)
  '#f87171', // red
  '#fbbf24', // amber
  '#a3e635', // lime
  '#c084fc', // violet
  '#34d399', // emerald
  '#fb7185', // rose
  '#60a5fa', // blue
];

function shipColour(id, isHero) {
  if (isHero) return PALETTE.hero;
  // Hash id deterministically to a palette slot.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return SHIP_COLOURS[Math.abs(h) % SHIP_COLOURS.length];
}

export function legend() {
  // Ships have their own per-row swatches in the scoreboard panel, so the
  // legend only enumerates non-ship entity types.
  return [
    { color: TIER_STROKE.LARGE.color, label: 'asteroid (large)' },
    { color: TIER_STROKE.MEDIUM.color, label: 'asteroid (medium)' },
    { color: TIER_STROKE.SMALL.color, label: 'asteroid (small)' },
    { color: PALETTE.bullet, label: 'bullet' },
  ];
}

/**
 * Draw a ship glyph at the given canvas-space (post-scale) position.
 * Glyph size (10 × 6) is in canvas pixels — kept constant across world
 * sizes so the ship stays visually readable regardless of zoom.
 */
function paintShip(ctx, e, cx, cy, isHero, isHighlighted) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(e.angle ?? 0);
  ctx.strokeStyle = shipColour(e.id, isHero);
  ctx.lineWidth = isHighlighted ? 4 : (isHero ? 2.5 : 2);
  if (isHighlighted) {
    ctx.shadowColor = shipColour(e.id, isHero);
    ctx.shadowBlur = 12;
  }
  ctx.beginPath();
  ctx.moveTo(10, 0);
  ctx.lineTo(-7, 6);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-7, -6);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  if (typeof e.health === 'number') {
    const hpFrac = Math.max(0, Math.min(1, e.health / 100));
    ctx.fillStyle = PALETTE.hpBar;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(cx - 10, cy - 16, 20 * hpFrac, 2);
    ctx.globalAlpha = 1;
  }
}

/**
 * Draw an asteroid. Position is post-scale (canvas pixels). Radius and
 * polygon vertices ARE in world units → scaled by `scale`.
 */
function paintAsteroid(ctx, e, cx, cy, scale) {
  const stroke = (e.tier && TIER_STROKE[e.tier]) || TIER_STROKE.MEDIUM;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;

  // Schema 2+: jagged polygon with rotation. Fall back to a circle for
  // older replays that only carry `radius`.
  if (Array.isArray(e.vertices) && e.vertices.length > 0) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(e.rotation ?? 0);
    ctx.beginPath();
    ctx.moveTo(e.vertices[0].x * scale, e.vertices[0].y * scale);
    for (let i = 1; i < e.vertices.length; i++) {
      ctx.lineTo(e.vertices[i].x * scale, e.vertices[i].y * scale);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
    return;
  }

  ctx.beginPath();
  ctx.arc(cx, cy, (e.radius ?? 20) * scale, 0, Math.PI * 2);
  ctx.stroke();
}

/** Bullets stay a constant 3 px in canvas pixels regardless of world size. */
function paintBullet(ctx, cx, cy) {
  ctx.fillStyle = PALETTE.bullet;
  ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
}

export function paint(ctx, frame, meta) {
  const canvasW = meta?.width ?? dimensions.width;
  const canvasH = meta?.height ?? dimensions.height;
  const worldW = meta?.worldWidth ?? canvasW;
  const worldH = meta?.worldHeight ?? canvasH;

  // One scale factor per axis (they should be equal when aspect ratios
  // match — they do for 4:3 worlds on 4:3 canvases).
  const scaleX = canvasW / worldW;
  const scaleY = canvasH / worldH;
  // Use the smaller scale for radii/vertices so a tall-aspect world
  // doesn't get vertically stretched asteroids. With matched aspects
  // (worldW/worldH = canvasW/canvasH) this is just `scaleX`.
  const uniformScale = Math.min(scaleX, scaleY);

  // Background.
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, canvasW, canvasH);

  const heroId = meta?.heroShipId;
  const highlightId = meta?.highlightShipId ?? null;

  // Pass 1: asteroids + bullets (drawn beneath ships).
  for (const e of frame.entities ?? []) {
    const cx = e.pos.x * scaleX;
    const cy = e.pos.y * scaleY;
    if (e.type === 'asteroid') paintAsteroid(ctx, e, cx, cy, uniformScale);
    else if (e.type === 'bullet') paintBullet(ctx, cx, cy);
  }
  // Pass 2: ships on top.
  for (const e of frame.entities ?? []) {
    if (e.type !== 'ship') continue;
    const cx = e.pos.x * scaleX;
    const cy = e.pos.y * scaleY;
    paintShip(ctx, e, cx, cy, e.id === heroId, e.id === highlightId);
  }
}
