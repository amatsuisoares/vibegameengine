import type { Entity } from '../entity';
import { inflate, overlaps } from '../math';
import type { World } from '../world';

export type Contact = [Entity, Entity];

export const pairKey = (a: Entity, b: Entity) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);

/**
 * All pairs of overlapping (or touching, within half a pixel) colliders where at
 * least one side can move. O(n^2): fine for MVP scenes of a few hundred entities.
 */
export function findContacts(world: World): Contact[] {
  const movers: Entity[] = [];
  const all: Entity[] = [];
  for (const e of world.entities) {
    if (!e.active || !e.components.Collider) continue;
    all.push(e);
    const t = e.components.Body?.type;
    if (t === 'dynamic' || t === 'kinematic') movers.push(e);
  }
  const contacts: Contact[] = [];
  const seen = new Set<string>();
  for (const a of movers) {
    const ab = inflate(a.aabb()!, 0.5);
    for (const b of all) {
      if (a === b) continue;
      const key = pairKey(a, b);
      if (seen.has(key)) continue;
      if (overlaps(ab, b.aabb()!)) {
        seen.add(key);
        contacts.push([a, b]);
      }
    }
  }
  return contacts;
}

/** Applies built-in gameplay rules (collect, stomp, damage, goal, checkpoint) to contacts. */
export function interactionSystem(world: World, contacts: Contact[]) {
  const current = new Set<string>();
  for (const [a, b] of contacts) {
    const key = pairKey(a, b);
    current.add(key);
    const entered = !world.prevContacts.has(key);
    handle(world, a, b, entered);
    handle(world, b, a, entered);
  }
  world.prevContacts = current;
}

function handle(world: World, src: Entity, other: Entity, entered: boolean) {
  if (src.destroyed || other.destroyed || world.status !== 'running') return;
  const c = src.components;

  if (c.Collectible && other.hasAnyTag(c.Collectible.collectorTags)) {
    const col = c.Collectible;
    world.addVar(col.variable, col.amount);
    if (col.score) world.addVar('score', col.score);
    const h = other.components.Health;
    if (col.heal && h) h.current = Math.min(h.max, (h.current ?? h.max) + col.heal);
    world.destroy(src);
    world.emit('collect', { entity: src.id, by: other.id, variable: col.variable, value: world.vars[col.variable] });
    return;
  }

  let stomped = false;
  if (c.Stompable && other.hasAnyTag(c.Stompable.stomperTags) && isStomp(other, src)) {
    stomped = true;
    const ob = other.components.Body;
    if (ob) ob.vy = -c.Stompable.bounceSpeed;
    world.emit('stomp', { entity: src.id, by: other.id });
    if (src.components.Health) applyDamage(world, src, c.Stompable.damage, other, true);
    else {
      world.destroy(src);
      world.emit('death', { entity: src.id, cause: 'stomp' });
    }
  }

  if (!stomped && c.Damage && other.hasAnyTag(c.Damage.targetTags)) {
    if (applyDamage(world, other, c.Damage.amount, src) && c.Damage.destroyOnHit) world.destroy(src);
  }

  if (c.Checkpoint && entered && other.hasAnyTag(c.Checkpoint.activatorTags)) {
    const prev = world.respawnPoints.get(other.id);
    if (!prev || prev.x !== src.x) {
      world.respawnPoints.set(other.id, { x: src.x, y: other.y });
      world.emit('checkpoint', { entity: src.id, by: other.id });
    }
  }

  if (c.Goal && entered && other.hasAnyTag(c.Goal.collectorTags)) {
    const missing = Object.entries(c.Goal.require ?? {}).filter(([k, min]) => {
      const v = world.vars[k];
      return typeof v !== 'number' || v < min;
    });
    if (missing.length) {
      world.emit('goal_blocked', { entity: src.id, by: other.id, missing: Object.fromEntries(missing) });
    } else if (c.Goal.action === 'loadScene' && c.Goal.scene) {
      world.emit('goal', { entity: src.id, by: other.id, action: 'loadScene', scene: c.Goal.scene });
      world.pendingScene = c.Goal.scene;
    } else {
      world.emit('goal', { entity: src.id, by: other.id, action: 'win' });
      world.status = 'won';
      world.emit('win', {});
      world.console.log(`WIN: ${other.id} reached ${src.id}`, 'engine');
    }
  }
}

/** The stomper was above the target last frame and is moving down. */
function isStomp(stomper: Entity, target: Entity): boolean {
  const b = stomper.components.Body;
  const sp = stomper.prevAabb();
  const tp = target.prevAabb();
  if (!b || !sp || !tp || b.vy <= 0) return false;
  return sp.y + sp.h <= tp.y + 4;
}

/** Returns true if damage was applied (false if invulnerable or no Health). */
export function applyDamage(world: World, target: Entity, amount: number, source?: Entity, ignoreInvuln = false): boolean {
  const h = target.components.Health;
  if (!h || amount <= 0) return false;
  if (target.invulnTimer > 0 && !ignoreInvuln) return false;
  h.current = Math.max(0, (h.current ?? h.max) - amount);
  target.invulnTimer = h.invulnerableTime;
  world.emit('damage', { entity: target.id, source: source?.id, amount, health: h.current });

  const b = target.components.Body;
  const kb = source?.components.Damage?.knockback ?? 0;
  if (b && source && kb > 0 && b.type === 'dynamic') {
    const dir = Math.sign(target.x - source.x) || 1;
    b.vx = dir * kb;
    b.vy = -kb * 0.6;
    target.stunTimer = 0.25;
  }
  return true;
}
