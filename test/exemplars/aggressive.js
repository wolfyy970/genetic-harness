// Aggressive opponent-hunter — closes range, fires constantly. No aim
// check, no asteroid avoidance, no braking. Quick to die, but scores
// well when the round goes its way. Used as a parent exemplar for
// fixture-sweep mutation tests (Slice F).
function tick(s) {
  if (s.opponents.length === 0) {
    return { type: 'thrust', direction: 1 };
  }
  var best = s.opponents[0];
  var bestD2 = (best.pos.x - s.ship.pos.x) ** 2 + (best.pos.y - s.ship.pos.y) ** 2;
  for (var i = 1; i < s.opponents.length; i++) {
    var o = s.opponents[i];
    var d2 = (o.pos.x - s.ship.pos.x) ** 2 + (o.pos.y - s.ship.pos.y) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = o; }
  }
  var dx = best.pos.x - s.ship.pos.x;
  var dy = best.pos.y - s.ship.pos.y;
  var desired = Math.atan2(dy, dx);
  var err = desired - s.ship.angle;
  // Fire every tick regardless of aim
  if (Math.random() < 0.3) return { type: 'fire' };
  if (Math.abs(err) > 0.2) return { type: 'rotate', direction: err > 0 ? 1 : -1 };
  return { type: 'thrust', direction: 1 };
}
