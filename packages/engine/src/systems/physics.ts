import type { Entity } from '../entity';
import { overlaps } from '../math';
import type { World } from '../world';

/**
 * Arcade physics: dynamic bodies get gravity and are moved one axis at a time,
 * resolving penetration against solids (static/kinematic/no-body colliders).
 * Dynamic bodies do not block each other; their overlaps become contacts.
 *
 * Limitation: no swept collision. A body moving more than half the thickness of a
 * solid per frame can tunnel (maxFallSpeed 900 = 15px/frame, so keep solids >= 16px).
 */
export function physicsSystem(world: World, dt: number) {
  const gravity = world.config.gravity;
  const solids = world.entities.filter((s) => s.active && s.isSolid);

  for (const e of world.entities) {
    const b = e.components.Body;
    if (!e.active || !b) continue;

    if (b.type === 'kinematic') {
      e.x += b.vx * dt;
      e.y += b.vy * dt;
      continue;
    }
    if (b.type !== 'dynamic') continue;

    b.vy = Math.min(b.vy + gravity * b.gravityScale * dt, b.maxFallSpeed);
    e.grounded = false;
    e.groundId = null;
    e.onWallLeft = e.onWallRight = false;

    const col = e.components.Collider;
    if (!col || col.isTrigger) {
      e.x += b.vx * dt;
      e.y += b.vy * dt;
      continue;
    }

    moveX(e, b.vx * dt, solids);
    moveY(e, b.vy * dt, solids);
  }
}

function moveX(e: Entity, dx: number, solids: Entity[]) {
  if (dx === 0) return;
  const b = e.components.Body!;
  const col = e.components.Collider!;
  e.x += dx;
  for (const s of solids) {
    if (s === e || s.components.Collider!.oneWay) continue;
    const box = e.aabb()!;
    const sb = s.aabb()!;
    if (!overlaps(box, sb)) continue;
    if (dx > 0) {
      e.x = sb.x - col.width / 2 - col.offsetX;
      e.onWallRight = true;
    } else {
      e.x = sb.x + sb.w + col.width / 2 - col.offsetX;
      e.onWallLeft = true;
    }
    b.vx = 0;
  }
}

function moveY(e: Entity, dy: number, solids: Entity[]) {
  if (dy === 0) return;
  const b = e.components.Body!;
  const col = e.components.Collider!;
  const prevBottom = e.prevAabb()!.y + col.height;
  e.y += dy;
  for (const s of solids) {
    if (s === e) continue;
    const oneWay = s.components.Collider!.oneWay;
    const box = e.aabb()!;
    const sb = s.aabb()!;
    if (!overlaps(box, sb)) continue;
    if (dy > 0) {
      if (oneWay && prevBottom > sb.y + 0.01) continue;
      e.y = sb.y - col.height / 2 - col.offsetY;
      e.grounded = true;
      e.groundId = s.id;
    } else {
      if (oneWay) continue;
      e.y = sb.y + sb.h + col.height / 2 - col.offsetY;
    }
    b.vy = 0;
  }
}
