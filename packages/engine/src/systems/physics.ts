import type { Entity } from '../entity';
import { overlaps, type AABB } from '../math';
import type { World } from '../world';

/**
 * Arcade physics: dynamic bodies get gravity and are moved one axis at a time,
 * resolving penetration against solids (static/kinematic/no-body colliders).
 * Dynamic bodies do not block each other; their overlaps become contacts.
 * Kinematic bodies move first; a dynamic body that was standing on one is carried
 * along (moving platforms, elevators), including on one-way platforms.
 *
 * Continuous collision (V0.6): each axis move is swept first — the body stops at the first solid
 * its path crosses, however thin the solid and however fast the body — then any remaining overlap
 * is resolved as before (bodies pushed into solids by platforms, rising one-way platforms).
 * The box each mover had before moving is kept in `sweptFrom`, so contacts (triggers, pickups,
 * damage, goals) can use the whole path of fast movers (see findContacts).
 */
export function physicsSystem(world: World, dt: number) {
  const gravity = world.config.gravity;
  const solids = world.entities.filter((s) => s.active && s.isSolid);

  const moved = new Map<string, { dx: number; dy: number }>();
  for (const e of world.entities) {
    const b = e.components.Body;
    e.sweptFrom = null;
    if (!e.active || b?.type !== 'kinematic') continue;
    e.sweptFrom = e.aabb();
    const dx = b.vx * dt;
    const dy = b.vy * dt;
    e.x += dx;
    e.y += dy;
    if (dx || dy) moved.set(e.id, { dx, dy });
  }

  for (const e of world.entities) {
    const b = e.components.Body;
    if (!e.active || b?.type !== 'dynamic') continue;

    const carrier = e.grounded && e.groundId ? moved.get(e.groundId) : undefined;
    b.vy = Math.min(b.vy + gravity * b.gravityScale * dt, b.maxFallSpeed);
    e.grounded = false;
    e.groundId = null;
    e.onWallLeft = e.onWallRight = false;

    const col = e.components.Collider;
    e.sweptFrom = e.aabb();
    if (!col || col.isTrigger) {
      e.x += b.vx * dt;
      e.y += b.vy * dt;
      continue;
    }

    if (carrier) carry(world, e, carrier, solids);
    moveX(e, b.vx * dt, solids);
    moveY(e, b.vy * dt, solids);
  }
}

/** Moves a body with the platform it stood on: stays on its top, then follows it sideways. */
function carry(world: World, e: Entity, by: { dx: number; dy: number }, solids: Entity[]) {
  const platform = world.get(e.groundId!);
  const top = platform?.aabb()?.y;
  const col = e.components.Collider!;
  const before = e.y;
  e.y = top !== undefined ? top - col.height / 2 - col.offsetY : e.y + by.dy;
  e.prevY += e.y - before; // one-way checks compare with the previous bottom
  if (by.dx) {
    const vx = e.components.Body!.vx;
    moveX(e, by.dx, solids);
    e.components.Body!.vx = vx; // being pushed against a wall by the platform does not stop the body's own motion
    e.prevX += by.dx;
  }
}

/** Touch tolerance (px): a box resting exactly on a face counts as touching it. */
const EPS = 0.01;

/**
 * The first solid face a box moving by `d` along one axis would cross: its coordinate, or null.
 * Only solids already ahead of the box and overlapping it on the other axis can be hit.
 */
function sweep(box: AABB, axis: 'x' | 'y', d: number, solids: Entity[], self: Entity): { at: number; solid: Entity } | null {
  const [pos, size, cross, crossSize] = axis === 'x' ? (['x', 'w', 'y', 'h'] as const) : (['y', 'h', 'x', 'w'] as const);
  const lead = d > 0 ? box[pos] + box[size] : box[pos];
  let best: { at: number; solid: Entity } | null = null;
  for (const s of solids) {
    if (s === self) continue;
    const oneWay = s.components.Collider!.oneWay;
    // One-way platforms only stop bodies falling onto their top.
    if (oneWay && (axis === 'x' || d < 0)) continue;
    const sb = s.aabb()!;
    if (!(box[cross] < sb[cross] + sb[crossSize] - 1e-6 && box[cross] + box[crossSize] > sb[cross] + 1e-6)) continue;
    const face = d > 0 ? sb[pos] : sb[pos] + sb[size];
    const ahead = d > 0 ? face >= lead - EPS && face < lead + d : face <= lead + EPS && face > lead + d;
    if (ahead && (!best || (d > 0 ? face < best.at : face > best.at))) best = { at: face, solid: s };
  }
  return best;
}

function moveX(e: Entity, dx: number, solids: Entity[]) {
  if (dx === 0) return;
  const b = e.components.Body!;
  const col = e.components.Collider!;
  const hit = sweep(e.aabb()!, 'x', dx, solids, e);
  if (hit) {
    e.x = dx > 0 ? hit.at - col.width / 2 - col.offsetX : hit.at + col.width / 2 - col.offsetX;
    if (dx > 0) e.onWallRight = true;
    else e.onWallLeft = true;
    b.vx = 0;
  } else e.x += dx;
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
  const hit = sweep(e.aabb()!, 'y', dy, solids, e);
  if (hit) {
    if (dy > 0) {
      e.y = hit.at - col.height / 2 - col.offsetY;
      e.grounded = true;
      e.groundId = hit.solid.id;
    } else e.y = hit.at + col.height / 2 - col.offsetY;
    b.vy = 0;
  } else e.y += dy;
  for (const s of solids) {
    if (s === e) continue;
    const oneWay = s.components.Collider!.oneWay;
    const box = e.aabb()!;
    const sb = s.aabb()!;
    if (!overlaps(box, sb)) continue;
    if (dy > 0) {
      // Compare with where the platform was: a rising one-way platform must still catch the body.
      if (oneWay && prevBottom > s.prevAabb()!.y + 0.01) continue;
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
