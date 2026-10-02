import type { Entity } from './entity';
import type { World } from './world';

/**
 * Ambient: entities put properties in the environment — a lamp light, a radio noise and music, a
 * cushion comfort — each with a reach (Ambient.radius; none = the whole scene) and a falloff. env at
 * a point is the sum, per property, of what reaches it from every enabled emitter, so behavior can
 * depend on WHERE an entity is (sleeping in the dark corner, dancing near the music). The engine never
 * says what a property means: the game does.
 *
 *   envAt(world, x, y) -> {light: 0.8, noise: 0.2, ...}   (only properties that reach the point)
 */

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** How much of an emitter reaches a point (0..1). */
export function reachOf(e: Entity, x: number, y: number): number {
  const a = e.components.Ambient;
  if (!a || !a.enabled || !e.active) return 0;
  if (a.radius === undefined) return 1;
  const d = Math.hypot(e.x - x, e.y - y);
  if (d > a.radius) return 0;
  return a.falloff === 'none' ? 1 : 1 - d / a.radius;
}

export function envAt(world: World, x: number, y: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of world.entities) {
    if (e.destroyed || !e.components.Ambient) continue;
    const k = reachOf(e, x, y);
    if (k <= 0) continue;
    for (const [prop, v] of Object.entries(e.components.Ambient.emits)) out[prop] = (out[prop] ?? 0) + v * k;
  }
  for (const prop of Object.keys(out)) out[prop] = round3(out[prop]);
  return out;
}
