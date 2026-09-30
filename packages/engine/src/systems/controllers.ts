import type { Entity } from '../entity';
import { approach, pointInBox } from '../math';
import type { World } from '../world';

export function controllerSystem(world: World, dt: number) {
  for (const e of world.entities) {
    if (!e.active) continue;
    if (e.components.PlatformerController) platformer(world, e, dt);
    if (e.components.Patrol) patrol(world, e);
    if (e.components.FollowTarget) follow(world, e, dt);
  }
}

function platformer(world: World, e: Entity, dt: number) {
  const c = e.components.PlatformerController!;
  const b = e.components.Body;
  if (!b || b.type !== 'dynamic') return;
  const input = world.input;
  const stunned = e.stunTimer > 0;

  const dir = stunned ? 0 : (input.action(c.rightAction) ? 1 : 0) - (input.action(c.leftAction) ? 1 : 0);
  if (!stunned) {
    let accel = dir !== 0 ? c.acceleration : c.deceleration;
    if (!e.grounded) accel *= c.airControl;
    b.vx = approach(b.vx, dir * c.moveSpeed, accel * dt);
  }

  if (e.grounded) {
    e.coyoteTimer = c.coyoteTime;
    e.jumpsUsed = 0;
  } else {
    e.coyoteTimer -= dt;
  }

  const jumpPressed = !stunned && input.actionPressed(c.jumpAction);
  if (jumpPressed) e.jumpBufferTimer = c.jumpBuffer;
  else e.jumpBufferTimer -= dt;

  if (e.jumpBufferTimer > 0) {
    let canJump = false;
    if (e.coyoteTimer > 0) {
      canJump = true;
      e.jumpsUsed = 1;
    } else {
      // Walked off a ledge without jumping: the ground jump is spent.
      if (e.jumpsUsed === 0) e.jumpsUsed = 1;
      if (e.jumpsUsed < c.maxJumps) {
        canJump = true;
        e.jumpsUsed++;
      }
    }
    if (canJump) {
      b.vy = -c.jumpSpeed;
      e.jumpBufferTimer = 0;
      e.coyoteTimer = 0;
      e.grounded = false;
      world.emit('jump', { entity: e.id });
    }
  }

  // Releasing jump early cuts the ascent (short hop).
  if (!jumpPressed && input.actionReleased(c.jumpAction) && b.vy < 0) b.vy *= c.variableJumpCut;
}

function patrol(world: World, e: Entity) {
  const p = e.components.Patrol!;
  const b = e.components.Body;
  let dir = e.patrolDir;
  if (p.distance > 0) {
    if (e.x <= e.spawnX - p.distance / 2) dir = 1;
    else if (e.x >= e.spawnX + p.distance / 2) dir = -1;
  }
  if (dir > 0 && e.onWallRight) dir = -1;
  else if (dir < 0 && e.onWallLeft) dir = 1;
  if (p.turnAtEdges && e.grounded && !groundAhead(world, e, dir)) dir = -dir;
  e.patrolDir = dir;
  if (b) b.vx = dir * p.speed;
}

/** Is there solid ground just past the leading bottom corner? */
export function groundAhead(world: World, e: Entity, dir: number): boolean {
  const box = e.aabb();
  if (!box) return true;
  const px = dir > 0 ? box.x + box.w + 2 : box.x - 2;
  const py = box.y + box.h + 2;
  return world.entities.some((s) => s !== e && s.active && s.isSolid && pointInBox(px, py, s.aabb()!));
}

function follow(world: World, e: Entity, dt: number) {
  const f = e.components.FollowTarget!;
  const b = e.components.Body;
  let target: Entity | undefined;
  if (f.targetId) target = world.get(f.targetId);
  else {
    let best = Infinity;
    for (const t of world.withTag(f.targetTag)) {
      if (t === e) continue;
      const d = Math.hypot(t.x - e.x, t.y - e.y);
      if (d < best) (best = d), (target = t);
    }
  }

  let vx = 0;
  let vy = 0;
  if (target && Math.hypot(target.x - e.x, target.y - e.y) <= f.activationRange) {
    const dx = target.x - e.x;
    const dy = target.y - e.y;
    if (f.mode === 'horizontal') {
      if (Math.abs(dx) > f.stopDistance) vx = Math.sign(dx) * f.speed;
    } else {
      const len = Math.hypot(dx, dy);
      if (len > f.stopDistance) (vx = (dx / len) * f.speed), (vy = (dy / len) * f.speed);
    }
  }

  if (b) {
    b.vx = vx;
    if (f.mode === 'free') b.vy = vy;
  } else {
    e.x += vx * dt;
    e.y += vy * dt;
  }
}
