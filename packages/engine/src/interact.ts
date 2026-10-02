import type { Components } from '@vibe/shared';
import type { Entity } from './entity';
import { compileExpr, type ExprScope } from './expr';
import type { Game } from './game';
import { round2, type AABB } from './math';
import { emitSound } from './sound';
import { screenToWorld } from './systems/camera';
import { pairKey } from './systems/interactions';
import { FIXED_DT, type World } from './world';

/**
 * Interactions: entities with an `Interactable` component (a door, a bowl, an NPC) that actors
 * (entities with one of its `actorTags`) or the player's mouse can use. The engine only decides
 * *whether* an interaction happens — by click, by key in range, by entering the range, or by a
 * script calling game.interact() — and reports it; what it does is up to the game:
 *
 *   event "interact"          { entity, action, via, by?, label? }  -> rules, onEvent, read_events
 *   event "interact_blocked"  { entity, action, via, by?, reason }  -> why an attempt failed
 *   script hook onInteract(self, by, game, { action, via })          on the interactable's script
 *
 * Blocked reasons, checked in this order: disabled, actor (missing tag), range, cooldown,
 * condition (expression false), error (expression failed).
 */

export type InteractVia = 'click' | 'key' | 'enter' | 'script';
export type BlockReason = 'disabled' | 'actor' | 'range' | 'cooldown' | 'condition' | 'error';
export type InteractableData = NonNullable<Components['Interactable']>;

export interface InteractResult {
  ok: boolean;
  /** Why it did not happen; "not_interactable" when the target has no (active) Interactable. */
  reason?: BlockReason | 'not_interactable';
}

/** What the interaction system needs from the scripts (implemented by ScriptRunner). */
export interface InteractionHooks {
  hasClickHandler(e: Entity): boolean;
  click(e: Entity, pos: { x: number; y: number }): void;
  interact(e: Entity, by: Entity | undefined, info: { action: string; via: InteractVia }): void;
}

/** Interactable state in getState() snapshots (and so in expressions: entity('door').interactable.uses). */
export interface InteractableSnapshot {
  action: string;
  label?: string;
  via: string[];
  enabled: boolean;
  uses: number;
  /** Cooldown time left (only while cooling down). */
  cooldownMs?: number;
  /** Actors close enough to interact by key or by entering. */
  inRange: string[];
}

export interface NearbyInteractable {
  id: string;
  action: string;
  label?: string;
  /** Gap between the boxes in px (0 = touching or overlapping). */
  distance: number;
}

const MAX_DEPTH = 8;

/** Box used for clicks and interaction range: the Collider, else the visible (scaled) Sprite. */
export function hitBox(e: Entity): AABB | null {
  const box = e.aabb();
  if (box) return box;
  const s = e.components.Sprite;
  if (!s || !s.visible) return null;
  const w = s.width * Math.abs(e.scaleX);
  const h = s.height * Math.abs(e.scaleY);
  return { x: e.x - w / 2, y: e.y - h / 2, w, h };
}

/** Distance between two entities' boxes (0 when they touch or overlap); entities without a box count as a point. */
export function gap(a: Entity, b: Entity): number {
  const ba = hitBox(a) ?? { x: a.x, y: a.y, w: 0, h: 0 };
  const bb = hitBox(b) ?? { x: b.x, y: b.y, w: 0, h: 0 };
  const dx = Math.max(0, bb.x - (ba.x + ba.w), ba.x - (bb.x + bb.w));
  const dy = Math.max(0, bb.y - (ba.y + ba.h), ba.y - (bb.y + bb.h));
  return Math.hypot(dx, dy);
}

/** True when an entity is drawn: a visible sprite with some opacity, or non-empty visible text. */
export function isDrawn(e: Entity): boolean {
  const { Sprite: sp, Text: tx } = e.components;
  return !!((sp && sp.visible && sp.opacity > 0) || (tx && tx.text !== '' && tx.opacity > 0));
}

/** How an entity would take a left click, and whether its Interactable would accept it now. */
export interface ClickInfo {
  /** Would a left click reach it (it is a click target)? */
  clickable: boolean;
  /** What handles the click: a click Interactable, a script onClick, the "clickable" tag. */
  handlers: ('interactable' | 'onClick' | 'tag')[];
  interactable?: { action: string; label?: string; enabled: boolean; uses: number; ready: boolean; blocked?: BlockReason; cooldownMs?: number };
}

/** Topmost (highest pickLayer, then latest in the scene) active entity containing the point. */
/**
 * Layer an entity is drawn on for picking: the highest of its Sprite and Text layers (an entity
 * drawn only by its Text, e.g. an emoji toy, is on top of what its Text covers).
 */
export function pickLayer(e: Entity): number {
  const s = e.components.Sprite;
  const t = e.components.Text;
  if (s && t) return Math.max(s.layer, t.layer);
  return s?.layer ?? t?.layer ?? 0;
}

export function topmostAt(world: World, x: number, y: number, accept: (e: Entity) => boolean): Entity | null {
  let best: Entity | null = null;
  let bestLayer = -Infinity;
  for (const e of world.entities) {
    if (!e.active) continue;
    const b = hitBox(e);
    if (!b || x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h || !accept(e)) continue;
    const layer = pickLayer(e);
    if (layer >= bestLayer) {
      best = e;
      bestLayer = layer;
    }
  }
  return best;
}

const usable = (e: Entity, via: 'click' | 'key' | 'enter') => {
  const c = e.components.Interactable;
  return !!c && c.enabled && e.active && c.via.includes(via);
};

const cooldownFrames = (ms: number) => Math.max(0, Math.round(ms / 1000 / FIXED_DT));

/** A second press within this time and distance of the first is a double click. */
const DOUBLE_CLICK_FRAMES = 18; // 300 ms
const DOUBLE_CLICK_PX = 6;
/** Moving this far (viewport px) with the left button held starts a drag. */
const DRAG_PX = 4;

/** The drag in progress (left button held and moved), in world coordinates. */
export interface DragInfo {
  /** Entity grabbed at the press (a click target or a "draggable"), or null. */
  entity: string | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
}

/** Runs the interactions of one world. Created per scene load (like the rules and scripts). */
export class InteractionRunner {
  /** Actor|target pairs within range of an "enter" interactable at the end of the previous frame. */
  private near = new Set<string>();
  private readonly compiled = new Map<string, (scope: ExprScope) => unknown>();
  private readonly reported = new Set<string>();
  private depth = 0;
  /** Left press being held: where (viewport and world), what it grabbed, and the grab offset. */
  private press: { at: { x: number; y: number }; world: { x: number; y: number }; entity: Entity | null; offset: { x: number; y: number } } | null = null;
  private drag: DragInfo | null = null;
  /** Previous left press, for double clicks. */
  private lastPress: { frame: number; x: number; y: number; clicks: number } | null = null;
  /** True during the frame of the second press of a double click. */
  doubleClicked = false;

  constructor(
    private readonly world: World,
    private readonly game: Game,
    private readonly hooks: InteractionHooks,
  ) {}

  /** Input stage (start of the frame): the left click and the interaction keys. */
  input() {
    if (this.world.status !== 'running') return;
    this.gestures();
    this.click();
    if (this.world.status !== 'running') return;
    const input = this.world.input;
    const best = this.keyTarget((c) => input.actionPressed(c.key));
    if (best) this.attempt(best.target, best.actor, 'key');
  }

  /**
   * A left click goes to the topmost clickable entity under the mouse: one with a click
   * Interactable, a script with onClick, or the tag "clickable" (rules react to its "click" event).
   */
  private click() {
    const w = this.world;
    const at = w.input.leftPressPosition();
    if (!at) return;
    const pos = screenToWorld(w, at.x, at.y);
    const target = this.clickTargetAt(pos.x, pos.y);
    const clicks = this.doubleClicked ? 2 : 1;
    this.game.lastClick = { frame: w.frame, x: at.x, y: at.y, world: { x: round2(pos.x), y: round2(pos.y) }, entity: target?.id ?? null, ...(clicks > 1 && { clicks }) };
    if (!target) return;
    w.emit('click', { entity: target.id, x: Math.round(pos.x), y: Math.round(pos.y), ...(clicks > 1 && { clicks }) });
    this.hooks.click(target, pos);
    if (usable(target, 'click') && w.status === 'running') this.attempt(target, undefined, 'click');
  }

  /** The drag in progress, or null. */
  dragInfo(): DragInfo | null {
    return this.drag && { ...this.drag };
  }

  /**
   * Mouse gestures, from the virtual input at the start of the frame: double clicks (a second
   * press close in time and space), and drags (left button held and moved): "drag_start" /
   * "drag_end" events with the grabbed entity and where it was dropped. Entities tagged
   * "draggable" follow the mouse while dragged.
   */
  private gestures() {
    const w = this.world;
    const input = w.input;
    const at = input.leftPressPosition();
    this.doubleClicked = false;
    if (at) {
      const prev = this.lastPress;
      const double = !!prev && prev.clicks === 1 && w.frame - prev.frame <= DOUBLE_CLICK_FRAMES && Math.hypot(at.x - prev.x, at.y - prev.y) <= DOUBLE_CLICK_PX;
      this.doubleClicked = double;
      this.lastPress = { frame: w.frame, x: at.x, y: at.y, clicks: double ? 2 : 1 };
      const world = screenToWorld(w, at.x, at.y);
      const entity = topmostAt(w, world.x, world.y, (e) => this.takesClicks(e) || e.hasTag('draggable'));
      this.press = { at, world, entity, offset: entity ? { x: entity.x - world.x, y: entity.y - world.y } : { x: 0, y: 0 } };
      this.drag = null;
      return;
    }
    const press = this.press;
    if (!press) return;
    const m = input.mouse;
    const pos = screenToWorld(w, m.x, m.y);
    const grabbed = press.entity && !press.entity.destroyed ? press.entity : null;
    if (input.isMouseDown('left')) {
      if (!this.drag && Math.hypot(m.x - press.at.x, m.y - press.at.y) > DRAG_PX) {
        this.drag = { entity: grabbed?.id ?? null, startX: round2(press.world.x), startY: round2(press.world.y), x: round2(pos.x), y: round2(pos.y) };
        w.emit('drag_start', { entity: this.drag.entity, x: Math.round(press.world.x), y: Math.round(press.world.y) });
      }
      if (this.drag) {
        this.drag.x = round2(pos.x);
        this.drag.y = round2(pos.y);
        if (grabbed?.hasTag('draggable')) {
          grabbed.x = pos.x + press.offset.x;
          grabbed.y = pos.y + press.offset.y;
        }
      }
      return;
    }
    // Released.
    if (this.drag) {
      const drop = topmostAt(w, pos.x, pos.y, (e) => e !== grabbed && isDrawn(e));
      w.emit('drag_end', { entity: this.drag.entity, x: Math.round(pos.x), y: Math.round(pos.y), drop: drop?.id ?? null });
    }
    this.press = null;
    this.drag = null;
  }

  /** Whether an entity takes left clicks (Interactable with click, a script onClick or the "clickable" tag). */
  takesClicks(e: Entity): boolean {
    return e.hasTag('clickable') || usable(e, 'click') || this.hooks.hasClickHandler(e);
  }

  /** The entity a left click at this world point reaches (same rule as a real click). */
  clickTargetAt(x: number, y: number): Entity | null {
    return topmostAt(this.world, x, y, (e) => this.takesClicks(e));
  }

  /** How `e` would take a left click right now, with no side effects (nothing is triggered). */
  clickInfo(e: Entity): ClickInfo {
    const c = e.components.Interactable;
    const handlers: ClickInfo['handlers'] = [];
    if (usable(e, 'click')) handlers.push('interactable');
    if (this.hooks.hasClickHandler(e)) handlers.push('onClick');
    if (e.hasTag('clickable')) handlers.push('tag');
    const info: ClickInfo = { clickable: handlers.length > 0, handlers };
    if (c) {
      const reason = c.via.includes('click') ? this.check(e, c, undefined, 'click') : null;
      const readyAt = e.interact?.readyAt ?? 0;
      info.interactable = {
        action: c.action,
        ...(c.label && { label: c.label }),
        enabled: c.enabled,
        uses: e.interact?.uses ?? 0,
        ready: c.via.includes('click') && !reason,
        ...(reason && { blocked: reason }),
        ...(reason === 'cooldown' && { cooldownMs: Math.round(((readyAt - this.world.frame) * 1000) / 60) }),
      };
    }
    return info;
  }

  /** After physics: "enter" interactions for actors that came within range, and the key prompt focus. */
  proximity() {
    const w = this.world;
    const now = new Set<string>();
    for (const target of [...w.entities]) {
      if (!usable(target, 'enter')) continue;
      const c = target.components.Interactable!;
      for (const actor of this.actorsOf(target, c)) {
        if (gap(actor, target) > c.range) continue;
        const key = pairKey(actor, target);
        now.add(key);
        if (!this.near.has(key) && w.status === 'running' && usable(target, 'enter')) this.attempt(target, actor, 'enter');
      }
    }
    this.near = now;
    const focus = this.keyTarget(() => true);
    w.interactFocus = focus && { entity: focus.target.id, by: focus.actor.id };
  }

  /** Tries an interaction now; reports it (event, sound, onInteract) or why it was blocked. */
  attempt(target: Entity, actor: Entity | undefined, via: InteractVia): InteractResult {
    const w = this.world;
    const c = target.components.Interactable;
    if (!c || !target.active) return { ok: false, reason: 'not_interactable' };
    const base = { entity: target.id, action: c.action, via, ...(actor && { by: actor.id }) };
    const state = (target.interact ??= { readyAt: 0, uses: 0 });
    const reason = this.check(target, c, actor, via);
    if (reason) {
      const left = reason === 'cooldown' ? { cooldownMs: Math.round(((state.readyAt - w.frame) * 1000) / 60) } : {};
      w.emit('interact_blocked', { ...base, reason, ...left });
      return { ok: false, reason };
    }
    state.uses++;
    state.readyAt = w.frame + cooldownFrames(c.cooldownMs);
    if (c.once) c.enabled = false;
    w.emit('interact', { ...base, ...(c.label && { label: c.label }) });
    if (c.sound) emitSound(w, c.sound, 1, `interact:${target.id}`);
    if (this.depth >= MAX_DEPTH) throw new Error('interactions nested too deeply (does an onInteract interact with itself?)');
    this.depth++;
    try {
      this.hooks.interact(target, actor, { action: c.action, via });
    } finally {
      this.depth--;
    }
    return { ok: true };
  }

  private check(target: Entity, c: InteractableData, actor: Entity | undefined, via: InteractVia): BlockReason | null {
    if (!c.enabled) return 'disabled';
    if (actor && !actor.hasAnyTag(c.actorTags)) return 'actor';
    if (actor && via !== 'click' && gap(actor, target) > c.range) return 'range';
    if (this.world.frame < (target.interact?.readyAt ?? 0)) return 'cooldown';
    if (c.condition !== undefined) {
      try {
        if (!this.condition(c.condition, target.id)) return 'condition';
      } catch (err) {
        const message = `Interactable of "${target.id}": condition ${err instanceof Error ? err.message : String(err)}`;
        if (!this.reported.has(message)) {
          this.reported.add(message);
          this.world.console.error(message, 'interact');
        }
        return 'error';
      }
    }
    return null;
  }

  private condition(src: string, self: string): boolean {
    let fn = this.compiled.get(src);
    if (!fn) {
      fn = compileExpr(src);
      this.compiled.set(src, fn);
    }
    return !!fn({ game: this.game, self });
  }

  private actorsOf(target: Entity, c: InteractableData): Entity[] {
    return this.world.entities.filter((e) => e.active && e !== target && e.hasAnyTag(c.actorTags));
  }

  /** Closest (target, actor) pair in range for the interaction key; ties keep scene order. */
  private keyTarget(accept: (c: InteractableData) => boolean) {
    let best: { target: Entity; actor: Entity; d: number } | null = null;
    for (const target of this.world.entities) {
      if (!usable(target, 'key')) continue;
      const c = target.components.Interactable!;
      if (!accept(c)) continue;
      for (const actor of this.actorsOf(target, c)) {
        const d = gap(actor, target);
        if (d <= c.range && (!best || d < best.d)) best = { target, actor, d };
      }
    }
    return best;
  }

  /** Enabled interactables `actor` may use and is close enough to, nearest first. */
  nearby(actor: Entity): NearbyInteractable[] {
    const out: NearbyInteractable[] = [];
    for (const e of this.world.entities) {
      const c = e.components.Interactable;
      if (!c || !c.enabled || !e.active || e === actor || !actor.hasAnyTag(c.actorTags)) continue;
      const d = gap(actor, e);
      if (d <= c.range) out.push({ id: e.id, action: c.action, ...(c.label && { label: c.label }), distance: round2(d) });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }
}

export function snapshotInteractable(world: World, e: Entity): InteractableSnapshot | undefined {
  const c = e.components.Interactable;
  if (!c) return undefined;
  const left = (e.interact?.readyAt ?? 0) - world.frame;
  const inRange = world.entities.filter((a) => a.active && a !== e && a.hasAnyTag(c.actorTags) && gap(a, e) <= c.range).map((a) => a.id);
  return {
    action: c.action,
    ...(c.label && { label: c.label }),
    via: [...c.via],
    enabled: c.enabled,
    uses: e.interact?.uses ?? 0,
    ...(left > 0 && { cooldownMs: Math.round((left * 1000) / 60) }),
    inRange,
  };
}
