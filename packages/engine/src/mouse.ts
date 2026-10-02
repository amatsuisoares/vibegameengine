import type { Entity } from './entity';
import type { Game, ScreenBox } from './game';
import { hitBox, isDrawn, type ClickInfo, type DragInfo } from './interact';
import { round2 } from './math';
import { screenToWorld } from './systems/camera';

/**
 * Mouse perception: what is under the virtual mouse and what a left click there would reach,
 * computed on demand from the world (nothing is triggered). Lets the agent understand 2D
 * interfaces: "the mouse is over the bed, 0 px; a click would interact with it", or "nothing
 * clickable here; the closest is the bowl, 23 px away".
 */

export interface MouseEntity extends ClickInfo {
  id: string;
  name: string;
  tags: string[];
  /** Box on screen (viewport px). */
  screen: ScreenBox | null;
  /** Distance from the mouse (world px) to the entity's box; 0 when the mouse is over it. */
  distance: number;
  layer: number;
}

export interface LastClick {
  frame: number;
  /** Viewport point of the press. */
  x: number;
  y: number;
  world: { x: number; y: number };
  /** Entity the click reached (null = nothing clickable there). */
  entity: string | null;
  /** 2 for the second click of a double click. */
  clicks?: number;
}

export interface MouseTarget {
  /** Viewport coordinates, world coordinates, buttons held. */
  screen: { x: number; y: number };
  world: { x: number; y: number };
  buttons: string[];
  insideViewport: boolean;
  /** What a left click here would reach now (null = nothing clickable). */
  target: MouseEntity | null;
  /** Topmost drawn entity under the mouse (may not be clickable, e.g. a background). */
  hovered: MouseEntity | null;
  /** Every entity under the mouse, topmost first (at most 8). */
  under: string[];
  /** When nothing clickable is under the mouse: the closest clickable entity on screen. */
  nearest?: MouseEntity;
  lastClick?: LastClick;
  /** The drag in progress (left button held and moved). */
  drag?: DragInfo;
}

/** Topmost first: higher Sprite layer, then later in the scene (same order a click uses). */
export function stackAt(game: Game, x: number, y: number): Entity[] {
  const hits: { e: Entity; layer: number; i: number }[] = [];
  game.world.entities.forEach((e, i) => {
    if (!e.active || e.destroyed) return;
    const b = hitBox(e);
    if (!b || x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return;
    if (!isDrawn(e) && !e.aabb()) return;
    hits.push({ e, layer: e.components.Sprite?.layer ?? 0, i });
  });
  return hits.sort((a, b) => b.layer - a.layer || b.i - a.i).map((h) => h.e);
}

function boxDistance(e: Entity, x: number, y: number): number {
  const b = hitBox(e) ?? { x: e.x, y: e.y, w: 0, h: 0 };
  const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
  const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
  return round2(Math.hypot(dx, dy));
}

export function mouseTarget(game: Game): MouseTarget {
  const w = game.world;
  const m = game.input.snapshot().mouse;
  const p = screenToWorld(w, m.x, m.y);
  const { width, height } = game.project.config;
  const describe = (e: Entity): MouseEntity => ({
    id: e.id,
    name: e.name,
    tags: [...e.tags],
    screen: game.screenBoxOf(e),
    distance: boxDistance(e, p.x, p.y),
    layer: e.components.Sprite?.layer ?? 0,
    ...game.interactions.clickInfo(e),
  });

  const stack = stackAt(game, p.x, p.y);
  const drag = game.interactions.dragInfo();
  const target = game.interactions.clickTargetAt(p.x, p.y);
  const hovered = stack[0] ?? null;
  let nearest: MouseEntity | undefined;
  if (!target) {
    for (const e of w.entities) {
      if (!e.active || e.destroyed || !game.interactions.takesClicks(e) || !game.screenBoxOf(e)) continue;
      const d = boxDistance(e, p.x, p.y);
      if (!nearest || d < nearest.distance) nearest = describe(e);
    }
  }
  return {
    screen: { x: m.x, y: m.y },
    world: { x: round2(p.x), y: round2(p.y) },
    buttons: m.buttons,
    insideViewport: m.x >= 0 && m.y >= 0 && m.x <= width && m.y <= height,
    target: target && describe(target),
    hovered: hovered && describe(hovered),
    under: stack.slice(0, 8).map((e) => e.id),
    ...(nearest && { nearest }),
    ...(game.lastClick && { lastClick: game.lastClick }),
    ...(drag && { drag }),
  };
}
