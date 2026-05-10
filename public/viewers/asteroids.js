// Asteroids replay viewer.
//
// Per-arena viewer modules expose:
//   - dimensions: { width, height } (matches the arena's GameConfig world size)
//   - paint(ctx, frame, meta): stateless renderer for one ReplayFrame
//   - legend(meta): array of { color, label } describing the palette
//
// Adding a new arena = drop a new file under public/viewers/<arena>.js with
// the same shape. The page does `import('/static/viewers/' + arena + '.js')`.

export const dimensions = { width: 800, height: 600 };

const PALETTE = {
  bg: '#0a0e1a',
  hero: '#7dd3fc',      // cyan — the candidate's ship
  enemy: '#f87171',     // red — reference opponents
  asteroid: '#8a8a9a',  // grey
  bullet: '#ffd166',    // amber
  hpBar: '#7dd3fc',
};

export function legend() {
  return [
    { color: PALETTE.hero, label: 'candidate' },
    { color: PALETTE.enemy, label: 'opponent' },
    { color: PALETTE.asteroid, label: 'asteroid' },
    { color: PALETTE.bullet, label: 'bullet' },
  ];
}

function paintShip(ctx, e, isHero) {
  ctx.save();
  ctx.translate(e.pos.x, e.pos.y);
  ctx.rotate(e.angle ?? 0);
  ctx.strokeStyle = isHero ? PALETTE.hero : PALETTE.enemy;
  ctx.lineWidth = 2;
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
    ctx.fillRect(e.pos.x - 10, e.pos.y - 16, 20 * hpFrac, 2);
    ctx.globalAlpha = 1;
  }
}

function paintAsteroid(ctx, e) {
  ctx.strokeStyle = PALETTE.asteroid;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(e.pos.x, e.pos.y, e.radius ?? 20, 0, Math.PI * 2);
  ctx.stroke();
}

function paintBullet(ctx, e) {
  ctx.fillStyle = PALETTE.bullet;
  ctx.fillRect(e.pos.x - 1.5, e.pos.y - 1.5, 3, 3);
}

export function paint(ctx, frame, meta) {
  const w = meta?.width ?? dimensions.width;
  const h = meta?.height ?? dimensions.height;
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, w, h);

  const heroId = meta?.heroShipId;

  for (const e of frame.entities ?? []) {
    if (e.type === 'asteroid') paintAsteroid(ctx, e);
    else if (e.type === 'bullet') paintBullet(ctx, e);
  }
  // Ships drawn last so they sit on top of bullets/asteroids.
  for (const e of frame.entities ?? []) {
    if (e.type === 'ship') paintShip(ctx, e, e.id === heroId);
  }
}
