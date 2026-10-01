import type { Entity } from './entity';
import type { World } from './world';

const FIXED_DT = 1 / 60;

/**
 * Timers: run something after a delay or every period, counted in fixed frames (never the real
 * clock), so they replay exactly. One Scheduler per world (scene). Timers have an id — scheduling
 * the same id again restarts it — and may belong to an entity: they are dropped when it is
 * destroyed and wait while it is disabled. Due timers fire once per frame (after the rules and
 * state machines), in the order they were due; one that throws is reported through its onError.
 */

export interface TimerInfo {
  id: string;
  /** Time left until it fires, ms. */
  ms: number;
  /** Repeat period, ms (repeating timers only). */
  every?: number;
}

interface Timer {
  id: string;
  owner?: Entity;
  /** Frame it fires at. */
  at: number;
  /** Repeat period in frames. */
  every?: number;
  run: () => void;
  onError: (err: unknown) => void;
  /** Creation order, to break ties between timers due on the same frame. */
  seq: number;
}

export const msToFramesAtLeast1 = (ms: number) => Math.max(1, Math.round(ms / 1000 / FIXED_DT));
const framesToMs = (frames: number) => Math.round((frames * 1000) / 60);

export class Scheduler {
  private timers: Timer[] = [];
  private seq = 0;
  private auto = 0;

  constructor(private readonly world: World) {}

  /**
   * Schedules `run` after `ms` (at least the next frame); `every` repeats it. Returns the id.
   * An id is unique per owner (or among global timers): reusing it replaces the old timer.
   */
  schedule(opts: { id?: string; ms: number; every?: number; owner?: Entity; run: () => void; onError: (err: unknown) => void }): string {
    for (const [name, v] of [['ms', opts.ms], ['every', opts.every]] as const) {
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new Error(`timer ${name} must be a number >= 0 (got ${String(v)})`);
    }
    const id = opts.id ?? `timer${++this.auto}`;
    this.cancel(id, opts.owner);
    this.timers.push({
      id,
      owner: opts.owner,
      at: this.world.frame + msToFramesAtLeast1(opts.ms),
      every: opts.every === undefined ? undefined : msToFramesAtLeast1(opts.every),
      run: opts.run,
      onError: opts.onError,
      seq: ++this.seq,
    });
    return id;
  }

  /** Cancels the timer with this id (of this owner, or a global one). Returns whether it existed. */
  cancel(id: string, owner?: Entity): boolean {
    const before = this.timers.length;
    this.timers = this.timers.filter((t) => !(t.id === id && t.owner === owner));
    return this.timers.length < before;
  }

  /** Timers of an entity (or the global ones), soonest first. */
  list(owner?: Entity): TimerInfo[] {
    const f = this.world.frame;
    return this.timers
      .filter((t) => t.owner === owner)
      .sort((a, b) => a.at - b.at || a.seq - b.seq)
      .map((t) => ({ id: t.id, ms: framesToMs(Math.max(0, t.at - f)), ...(t.every !== undefined && { every: framesToMs(t.every) }) }));
  }

  /** Fires the timers due this frame. */
  run() {
    const w = this.world;
    this.timers = this.timers.filter((t) => !t.owner?.destroyed);
    for (const t of this.timers) if (t.owner && !t.owner.enabled && t.at <= w.frame) t.at = w.frame + 1; // waits while disabled
    const due = this.timers.filter((t) => t.at <= w.frame).sort((a, b) => a.at - b.at || a.seq - b.seq);
    for (const t of due) {
      if (w.status !== 'running') return;
      if (!this.timers.includes(t) || t.owner?.destroyed) continue; // cancelled by an earlier timer
      if (t.every !== undefined) t.at = w.frame + t.every;
      else this.timers.splice(this.timers.indexOf(t), 1);
      try {
        t.run();
      } catch (err) {
        t.onError(err);
      }
    }
  }
}

/** Per-entity cooldowns (self.cooldown): name -> frame it is ready again. */
export function cooldown(world: World, e: Entity, name: string, ms: number): boolean {
  const map = (e.cooldowns ??= {});
  if (world.frame < (map[name] ?? 0)) return false;
  map[name] = world.frame + Math.max(0, Math.round(ms / 1000 / FIXED_DT));
  return true;
}

/** Cooldowns still running, ms left by name. */
export function cooldownsLeft(world: World, e: Entity): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, at] of Object.entries(e.cooldowns ?? {})) if (at > world.frame) out[name] = framesToMs(at - world.frame);
  return out;
}
