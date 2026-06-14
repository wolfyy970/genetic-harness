function tick(s) {
    var ship = s.ship;
    var cx = 400, cy = 300;
    var threats = (s.opponents || []).concat(s.asteroids || []);
    var nearest = null;
    var nearestD2 = Infinity;
    for (var i = 0; i < threats.length; i++) {
      var t = threats[i];
      if (!t.pos) continue;
      var dx = t.pos.x - ship.pos.x;
      var dy = t.pos.y - ship.pos.y;
      var d2 = dx*dx + dy*dy;
      if (d2 < nearestD2) { nearestD2 = d2; nearest = t; }
    }
    if (nearest && nearestD2 < 250 * 250) {
      var ang = Math.atan2(nearest.pos.y - ship.pos.y, nearest.pos.x - ship.pos.x);
      var diff = ang - ship.angle;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      if (Math.abs(diff) < 0.2) return { type: 'fire' };
      return { type: 'rotate', direction: diff > 0 ? 1 : -1 };
    }
    return { type: 'wait' };
  }
