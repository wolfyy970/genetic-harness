// Hunter-style stub — tries to target asteroids but has no tier awareness,
// no aim-error wraparound, and a fire-when-roughly-pointing heuristic.
// Used as a parent exemplar for fixture-sweep mutation tests (Slice F).
function tick(s) {
  if (s.asteroids.length === 0) return { type: 'wait' };
  var nearest = s.asteroids[0];
  var bestD2 = (nearest.pos.x - s.ship.pos.x) ** 2 + (nearest.pos.y - s.ship.pos.y) ** 2;
  for (var i = 1; i < s.asteroids.length; i++) {
    var a = s.asteroids[i];
    var d2 = (a.pos.x - s.ship.pos.x) ** 2 + (a.pos.y - s.ship.pos.y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; nearest = a; }
  }
  var dx = nearest.pos.x - s.ship.pos.x;
  var dy = nearest.pos.y - s.ship.pos.y;
  var ang = Math.atan2(dy, dx);
  // Naive: no aim-error wraparound, breaks when angles cross ±π
  if (Math.abs(ang - s.ship.angle) < 0.3) return { type: 'fire' };
  return { type: 'rotate', direction: ang > s.ship.angle ? 1 : -1 };
}
