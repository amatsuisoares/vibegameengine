import { FIXED_DT, type World } from '../world';

/**
 * Mover: follows waypoints relative to the spawn position at a constant speed, back and
 * forth (or looping), pausing `waitMs` at each point. With a kinematic Body it sets the
 * body's velocity, so physics moves it and carries whatever stands on it; without a Body
 * it moves the entity directly (decoration).
 */
export function moverSystem(world: World, dt: number) {
  for (const e of world.entities) {
    const m = e.components.Mover;
    if (!m || !e.active) continue;
    const body = e.components.Body;
    if (body && body.type !== 'kinematic') continue;

    const points = [{ x: 0, y: 0 }, ...m.path];
    const st = (e.mover ??= { target: 1, dir: 1, wait: 0 });
    let px = e.x;
    let py = e.y;
    if (st.wait > 0) st.wait--;
    else {
      let budget = m.speed * dt;
      // A few hops at most: several waypoints can be passed in one frame at high speed.
      for (let hop = 0; hop < points.length + 1 && budget > 0; hop++) {
        const t = points[st.target];
        const tx = e.spawnX + t.x;
        const ty = e.spawnY + t.y;
        const dist = Math.hypot(tx - px, ty - py);
        if (dist > budget) {
          px += ((tx - px) / dist) * budget;
          py += ((ty - py) / dist) * budget;
          break;
        }
        px = tx;
        py = ty;
        budget -= dist;
        advance(st, points.length, m.loop);
        if (m.waitMs > 0) {
          st.wait = Math.round(m.waitMs / 1000 / FIXED_DT); // in frames: exact, unlike summed seconds
          break;
        }
      }
    }
    if (body) {
      body.vx = (px - e.x) / dt;
      body.vy = (py - e.y) / dt;
    } else {
      e.x = px;
      e.y = py;
    }
  }
}

function advance(st: { target: number; dir: number }, count: number, loop: boolean) {
  if (loop) {
    st.target = (st.target + 1) % count;
    return;
  }
  if (st.target + st.dir < 0 || st.target + st.dir >= count) st.dir = -st.dir;
  st.target += st.dir;
}
