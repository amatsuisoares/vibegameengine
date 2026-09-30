import type { Entity } from '../entity';
import type { World } from '../world';

/** Timers, falling out of the world, and death handling. */
export function healthSystem(world: World, dt: number) {
  for (const e of world.entities) {
    if (!e.active) continue;
    if (e.invulnTimer > 0) e.invulnTimer = Math.max(0, e.invulnTimer - dt);
    if (e.stunTimer > 0) e.stunTimer = Math.max(0, e.stunTimer - dt);

    const h = e.components.Health;
    const box = e.aabb();
    const top = box ? box.y : e.y;
    if (top > world.killY) {
      if (!h) {
        world.destroy(e);
        world.emit('fell', { entity: e.id });
        continue;
      }
      h.current = Math.max(0, (h.current ?? h.max) - world.scene.fallDamage);
      world.emit('fell', { entity: e.id, health: h.current });
      if (h.current > 0) respawn(world, e);
    }

    if (h && (h.current ?? h.max) <= 0) die(world, e);
  }
}

function die(world: World, e: Entity) {
  const h = e.components.Health!;
  switch (h.onDeath) {
    case 'destroy':
      world.destroy(e);
      world.emit('death', { entity: e.id });
      break;
    case 'lose':
      world.emit('death', { entity: e.id });
      world.status = 'lost';
      world.emit('lose', { entity: e.id });
      world.console.log(`LOSE: ${e.id} died`, 'engine');
      break;
    case 'respawn':
      world.emit('death', { entity: e.id });
      h.current = h.max;
      respawn(world, e);
      break;
    case 'none':
      break;
  }
}

export function respawn(world: World, e: Entity) {
  const p = world.respawnPointOf(e);
  e.x = e.prevX = p.x;
  e.y = e.prevY = p.y;
  const b = e.components.Body;
  if (b) b.vx = b.vy = 0;
  e.stunTimer = 0;
  world.emit('respawn', { entity: e.id, x: p.x, y: p.y });
}
