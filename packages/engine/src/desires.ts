import type { Components } from '@vibe/shared';
import type { Entity } from './entity';
import type { GameEvent, World } from './world';

/**
 * Desires: what an individual wants right now ({kind, subject, data}) — to eat fish, something
 * crunchy, to play, to be left alone. The game decides what it wants and how it shows; the engine
 * keeps the life cycle so every game gets the same rules:
 *
 *   start({kind, subject?, data?, minutes, minRealSeconds?, fulfillOn?, force?}) -> desire | null
 *       null when blocked (blocked() says why: "max" active at once, "gap" since the last one on
 *       the game clock or in real time, "day" limit); force skips the gap and the day limit.
 *   fulfill(id or kind, data?) / cancel(id or kind)  -> the desire that ended, or null
 *   list() / get(id or kind) / blocked()
 *
 * A desire ends by itself when an event matches one of its fulfillOn triggers ({event, match}: every
 * field of match equal in the event, "$self" = this entity's id, an array field such as tags matches
 * if it contains the value) — event "desire_fulfilled" — or when its game-clock time is up and, with
 * minRealSeconds, at least that much real time passed in the session (at 600× the clock flies, the
 * player does not) — event "desire_expired". Events emitted in a frame are matched in that same
 * frame, before scripts see them (onEvent gets the item and the fulfillment together).
 *
 * The desires live in the component data (Desires.active), so Persist keeps them across sessions.
 */

type DesiresData = NonNullable<Components['Desires']>;
type Desire = DesiresData['active'][number];
export type DesireTrigger = Desire['fulfillOn'][number];

const DAY_MS = 86_400_000;

export type DesireBlock = 'max' | 'gap' | 'day';

export interface DesireSpec {
  kind: string;
  subject?: string;
  data?: Record<string, unknown>;
  /** Game-clock minutes until it expires. */
  minutes: number;
  minRealSeconds?: number;
  fulfillOn?: DesireTrigger | DesireTrigger[];
  /** Skips the gap and the daily limit (not max). */
  force?: boolean;
}

export interface DesireView {
  id: string;
  kind: string;
  subject?: string;
  data: Record<string, unknown>;
  since: number;
  until: number;
  /** Game-clock minutes left (0 when only the real-time minimum keeps it). */
  minutesLeft: number;
}

export interface DesireHost {
  readonly clock: { readonly now: number };
  world(): World;
  /** Loads persisted data before reading, marks the entity to save after a change. */
  ensure(e: Entity): void;
  touch(e: Entity): void;
}

function desiresOf(e: Entity): DesiresData {
  const d = e.components.Desires;
  if (!d) throw new Error(`entity "${e.id}" has no Desires`);
  return d;
}

const view = (d: Desire, now: number): DesireView => ({
  id: d.id,
  kind: d.kind,
  ...(d.subject !== undefined && { subject: d.subject }),
  data: structuredClone(d.data),
  since: d.since,
  until: d.until,
  minutesLeft: Math.max(0, Math.round((d.until - now) / 6000) / 10),
});

/** Desire with this id, else the first of this kind ("*" = any). */
function find(c: DesiresData, ref: string): Desire | undefined {
  return c.active.find((d) => d.id === ref) ?? c.active.find((d) => ref === '*' || d.kind === ref);
}

export function eventFits(ev: GameEvent | Record<string, unknown>, t: DesireTrigger, selfId: string): boolean {
  if (ev.type !== t.event) return false;
  return Object.entries(t.match).every(([k, v]) => {
    const want = v === '$self' ? selfId : v;
    const got = (ev as Record<string, unknown>)[k];
    return Array.isArray(got) && !Array.isArray(want) ? got.includes(want) : got === want;
  });
}

/** Desire of this kind ("*" = any) the entity has now: its subject, true without one, false if none. */
export function wantsOf(e: Entity, kind: string): string | boolean {
  const d = e.components.Desires?.active.find((x) => kind === '*' || x.kind === kind);
  return d ? (d.subject ?? true) : false;
}

export function desireViews(e: Entity, now: number): DesireView[] {
  return (e.components.Desires?.active ?? []).map((d) => view(d, now));
}

export class DesireRunner {
  /** Real ms (frames × step) when each desire started in this session, by "entity/desire". */
  private readonly realStart = new Map<string, number>();
  /** Real ms of the last start or end per entity (not saved: a new session starts fresh). */
  private readonly lastReal = new Map<string, number>();
  private seen: { world: World; emitted: number } | null = null;

  constructor(private readonly host: DesireHost) {}

  private get realMs() {
    return Math.round(this.host.world().time * 1000);
  }

  blocked(e: Entity): DesireBlock | null {
    this.host.ensure(e);
    return this.check(e, desiresOf(e), false);
  }

  private check(e: Entity, c: DesiresData, force: boolean): DesireBlock | null {
    if (c.active.length >= c.max) return 'max';
    if (force) return null;
    const now = this.host.clock.now;
    if (c.maxPerDay > 0 && c.today && c.today.day === Math.floor(now / DAY_MS) && c.today.count >= c.maxPerDay) return 'day';
    if (c.last !== undefined && now >= c.last && now - c.last < c.minGapMinutes * 60_000) return 'gap';
    const real = this.lastReal.get(e.id);
    if (real !== undefined && this.realMs - real < c.minGapRealSeconds * 1000) return 'gap';
    return null;
  }

  start(e: Entity, spec: DesireSpec): DesireView | null {
    if (!spec || typeof spec !== 'object') throw new Error('desires.start: pass {kind, minutes, ...}');
    if (typeof spec.kind !== 'string' || !spec.kind) throw new Error('desires.start: kind must be a non-empty string');
    if (typeof spec.minutes !== 'number' || !(spec.minutes > 0)) throw new Error('desires.start: minutes must be a number > 0');
    if (spec.subject !== undefined && typeof spec.subject !== 'string') throw new Error('desires.start: subject must be a string');
    if (spec.minRealSeconds !== undefined && !(typeof spec.minRealSeconds === 'number' && spec.minRealSeconds >= 0)) throw new Error('desires.start: minRealSeconds must be a number >= 0');
    const triggers = spec.fulfillOn === undefined ? [] : Array.isArray(spec.fulfillOn) ? spec.fulfillOn : [spec.fulfillOn];
    for (const t of triggers) if (!t || typeof t.event !== 'string' || !t.event) throw new Error('desires.start: each fulfillOn needs an event');
    this.host.ensure(e);
    const c = desiresOf(e);
    if (this.check(e, c, !!spec.force)) return null;
    const now = this.host.clock.now;
    const day = Math.floor(now / DAY_MS);
    c.seq++;
    const d: Desire = {
      id: `d${c.seq}`,
      kind: spec.kind,
      ...(spec.subject !== undefined && { subject: spec.subject }),
      data: structuredClone(spec.data ?? {}),
      since: now,
      until: now + spec.minutes * 60_000,
      ...(spec.minRealSeconds !== undefined && { minRealSeconds: spec.minRealSeconds }),
      fulfillOn: triggers.map((t) => ({ event: t.event, match: structuredClone(t.match ?? {}) })),
    };
    c.active.push(d);
    c.today = c.today && c.today.day === day ? { day, count: c.today.count + 1 } : { day, count: 1 };
    c.last = now;
    this.realStart.set(`${e.id}/${d.id}`, this.realMs);
    this.lastReal.set(e.id, this.realMs);
    this.host.touch(e);
    this.host.world().emit('desire_start', { entity: e.id, ...this.payload(d) });
    return view(d, now);
  }

  private payload(d: Desire) {
    return { id: d.id, kind: d.kind, ...(d.subject !== undefined && { subject: d.subject }), data: structuredClone(d.data) };
  }

  private end(e: Entity, c: DesiresData, d: Desire, type: string, extra: Record<string, unknown> = {}) {
    c.active = c.active.filter((x) => x !== d);
    c.last = this.host.clock.now;
    this.realStart.delete(`${e.id}/${d.id}`);
    this.lastReal.set(e.id, this.realMs);
    this.host.touch(e);
    this.host.world().emit(type, { entity: e.id, ...this.payload(d), ...extra });
    return view(d, this.host.clock.now);
  }

  fulfill(e: Entity, ref: string, data?: Record<string, unknown>): DesireView | null {
    this.host.ensure(e);
    const c = desiresOf(e);
    const d = find(c, String(ref));
    return d ? this.end(e, c, d, 'desire_fulfilled', { by: 'script', ...(data && { with: structuredClone(data) }) }) : null;
  }

  cancel(e: Entity, ref: string): DesireView | null {
    this.host.ensure(e);
    const c = desiresOf(e);
    const d = find(c, String(ref));
    return d ? this.end(e, c, d, 'desire_cancelled') : null;
  }

  get(e: Entity, ref: string): DesireView | null {
    this.host.ensure(e);
    const d = find(desiresOf(e), String(ref));
    return d ? view(d, this.host.clock.now) : null;
  }

  list(e: Entity): DesireView[] {
    this.host.ensure(e);
    desiresOf(e);
    return desireViews(e, this.host.clock.now);
  }

  /** Each frame, before scripts get the events: fulfillment by the frame's events, then expiry. */
  run() {
    const w = this.host.world();
    if (!this.seen || this.seen.world !== w) this.seen = { world: w, emitted: w.emitted };
    const count = Math.min(w.emitted - this.seen.emitted, w.events.length);
    this.seen.emitted = w.emitted;
    const fresh = count > 0 ? w.events.slice(-count) : [];
    const now = this.host.clock.now;
    for (const e of w.entities) {
      if (!e.active || !e.components.Desires) continue;
      this.host.ensure(e);
      const c = e.components.Desires;
      if (!c.active.length) continue;
      for (const ev of fresh) {
        for (const d of [...c.active]) {
          const t = d.fulfillOn.find((x) => eventFits(ev, x, e.id));
          if (!t) continue;
          const { frame: _f, ...trigger } = ev;
          this.end(e, c, d, 'desire_fulfilled', { by: ev.type, trigger });
        }
      }
      for (const d of [...c.active]) {
        if (now < d.until) continue;
        const started = this.realStart.get(`${e.id}/${d.id}`);
        if (d.minRealSeconds !== undefined && started !== undefined && this.realMs - started < d.minRealSeconds * 1000) continue;
        this.end(e, c, d, 'desire_expired');
      }
    }
    // The events emitted here were already seen (scripts get them this frame).
    this.seen.emitted = w.emitted;
  }
}
