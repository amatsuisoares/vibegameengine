import { COMPONENT_TYPES, type ComponentType } from '@vibe/shared';
import type { Entity } from './entity';
import type { World } from './world';

/**
 * Tweens: smooth changes of a number over time — position, scale, rotation, opacity or any numeric
 * component field ("Text.fontSize") — for UI, feedback, floating objects and transitions. Counted in
 * fixed frames, so they replay exactly. One TweenRunner per world (scene); a tween belongs to an
 * entity and is dropped with it (and waits while it is disabled). A new tween of the same property
 * replaces the running one. Finishing emits "tween_end" {entity, prop, id} and calls onDone.
 */

export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

const EASE: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
};

export interface TweenOptions {
  prop: string;
  to: number;
  ms: number;
  from?: number;
  ease?: Ease;
  yoyo?: boolean;
  repeat?: number;
  id?: string;
  onDone?: () => void;
  onError?: (err: unknown) => void;
}

export interface TweenInfo {
  id: string;
  prop: string;
  to: number;
  /** Time left, ms (absent when it repeats forever). */
  ms?: number;
}

interface Tween {
  id: string;
  entity: Entity;
  prop: string;
  from: number;
  to: number;
  frames: number;
  ease: (t: number) => number;
  yoyo: boolean;
  repeat: number;
  /** Frames already played. */
  done: number;
  onDone?: () => void;
  onError?: (err: unknown) => void;
}

const DT = 1 / 60;
const toFrames = (ms: number) => Math.max(0, Math.round(ms / 1000 / DT));

/** Properties a tween writes (for replacing a running tween of the same thing). */
const keysOf = (prop: string) => (prop === 'scale' ? ['scaleX', 'scaleY'] : [prop]);

/** Reads and writes a tweenable property; throws with the allowed names when it is not one. */
export function tweenProp(e: Entity, prop: string): { get(): number; set(v: number): void } {
  switch (prop) {
    case 'x':
    case 'y':
    case 'rotation':
    case 'scaleX':
    case 'scaleY':
      return { get: () => e[prop], set: (v) => (e[prop] = v) };
    case 'scale':
      return {
        get: () => e.scaleX,
        set: (v) => {
          e.scaleX = v;
          e.scaleY = v;
        },
      };
    case 'opacity': {
      const { Sprite, Text } = e.components;
      if (!Sprite && !Text) throw new Error(`entity "${e.id}" has no Sprite or Text to fade`);
      return {
        get: () => (Sprite ?? Text)!.opacity,
        set: (v) => {
          const o = Math.min(1, Math.max(0, v));
          if (Sprite) Sprite.opacity = o;
          if (Text) Text.opacity = o;
        },
      };
    }
  }
  const m = /^([A-Za-z]+)\.([A-Za-z]+)$/.exec(prop);
  if (!m || !(COMPONENT_TYPES as string[]).includes(m[1])) {
    throw new Error(`cannot tween "${prop}": use x, y, rotation, scaleX, scaleY, scale, opacity or "Component.field"`);
  }
  const data = e.components[m[1] as ComponentType] as Record<string, unknown> | undefined;
  if (!data) throw new Error(`entity "${e.id}" has no ${m[1]} component`);
  if (typeof data[m[2]] !== 'number') throw new Error(`${m[1]}.${m[2]} of "${e.id}" is not a number`);
  return { get: () => data[m[2]] as number, set: (v) => (data[m[2]] = v) };
}

export class TweenRunner {
  private tweens: Tween[] = [];
  private auto = 0;

  constructor(private readonly world: World) {}

  /** Starts a tween on `e` now (the first step shows on this frame's run). Returns its id. */
  start(e: Entity, o: TweenOptions): string {
    for (const [name, v] of [['to', o.to], ['ms', o.ms], ['from', o.from]] as const) {
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`tween ${name} must be a finite number (got ${String(v)})`);
    }
    if (o.ms < 0) throw new Error('tween ms must be >= 0');
    const ease = EASE[o.ease ?? 'easeInOut'];
    if (!ease) throw new Error(`unknown ease "${o.ease}" (linear, easeIn, easeOut, easeInOut)`);
    const repeat = o.repeat ?? 0;
    if (!Number.isInteger(repeat) || repeat < -1) throw new Error('tween repeat must be an integer >= -1');
    const access = tweenProp(e, o.prop);
    const keys = keysOf(o.prop);
    this.tweens = this.tweens.filter((t) => !(t.entity === e && keysOf(t.prop).some((k) => keys.includes(k))));
    const id = o.id ?? `tween${++this.auto}`;
    this.tweens = this.tweens.filter((t) => !(t.entity === e && t.id === id));
    const from = o.from ?? access.get();
    if (o.from !== undefined) access.set(o.from);
    this.tweens.push({ id, entity: e, prop: o.prop, from, to: o.to, frames: toFrames(o.ms), ease, yoyo: !!o.yoyo, repeat, done: 0, onDone: o.onDone, onError: o.onError });
    return id;
  }

  /** Stops the tweens of `e` with this id or property (all of them without one); values stay where they are. */
  stop(e: Entity, idOrProp?: string): number {
    const before = this.tweens.length;
    this.tweens = this.tweens.filter((t) => !(t.entity === e && (idOrProp === undefined || t.id === idOrProp || t.prop === idOrProp)));
    return before - this.tweens.length;
  }

  list(e: Entity): TweenInfo[] {
    return this.tweens
      .filter((t) => t.entity === e)
      .map((t) => ({ id: t.id, prop: t.prop, to: t.to, ...(t.repeat >= 0 && { ms: Math.round(((total(t) - t.done) * 1000) / 60) }) }));
  }

  /** Advances every tween by one frame. */
  run() {
    const w = this.world;
    this.tweens = this.tweens.filter((t) => !t.entity.destroyed);
    for (const t of [...this.tweens]) {
      if (w.status !== 'running') return;
      if (!this.tweens.includes(t) || !t.entity.enabled) continue;
      t.done++;
      const finished = t.repeat >= 0 && t.done >= total(t);
      const access = tweenProp(t.entity, t.prop);
      access.set(finished ? (t.yoyo ? t.from : t.to) : t.from + (t.to - t.from) * t.ease(phase(t)));
      if (!finished) continue;
      this.tweens.splice(this.tweens.indexOf(t), 1);
      w.emit('tween_end', { entity: t.entity.id, prop: t.prop, id: t.id });
      if (t.onDone) {
        try {
          t.onDone();
        } catch (err) {
          t.onError?.(err);
        }
      }
    }
  }
}

/** Frames of one cycle (there, or there and back with yoyo). */
const cycle = (t: Tween) => Math.max(1, t.frames) * (t.yoyo ? 2 : 1);
const total = (t: Tween) => (t.frames === 0 ? 1 : cycle(t) * (t.repeat + 1));

/** Progress 0..1 of the current pass (going back on the second half of a yoyo cycle). */
function phase(t: Tween): number {
  const n = Math.max(1, t.frames);
  const pos = t.done % cycle(t);
  if (pos === 0) return t.yoyo ? 0 : 1;
  return pos <= n ? pos / n : 1 - (pos - n) / n;
}
