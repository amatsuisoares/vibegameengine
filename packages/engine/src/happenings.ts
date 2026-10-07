import type { Components } from '@vibe/shared';
import { eventFits } from './desires';
import type { Entity } from './entity';
import { compileExpr, ExprError, type ExprScope } from './expr';
import type { Game } from './game';
import { Rng } from './rng';
import type { World } from './world';

/**
 * Happenings: random events that break the routine — a bird at the window, a butterfly, a free
 * sample at the door. The entity with the component is the "director": it holds a deck of cards
 * and the engine draws one every ~everyMinutes of game clock (each wait 0.5–1.5×), one at a time:
 *
 *   card      {id, weight (number or expression), when?, minutes, minRealSeconds?, cooldownMinutes,
 *              maxPerDay, endOn: [{event, match, outcome}]}
 *   draw      when the clock passed `next`, at least minGapRealSeconds of real time passed since the
 *              scene started or the last one ended (at 600× the clock flies, the player does not),
 *              the daily limit allows and `when` holds: the cards whose `when` holds, out of their
 *              cooldown and daily limit, weighted by `weight` (seeded RNG of their own, so adding a
 *              deck does not shift the game's random sequence)
 *   start     event "happening_start" {entity, id, kind, data}; the game shows it
 *   end       an event matching an endOn trigger (same rules as Desires.fulfillOn) ends it with that
 *              outcome; the script ends it with any outcome; or its time is up ("expired"):
 *              event "happening_end" {entity, id, kind, data, outcome, by, trigger?}
 *
 * The state (current, next, per-card history, today) lives in the component data, so Persist keeps
 * it. Scripts drive it with self.happenings (start a card now, end, update data); expressions read
 * happening([entity]) (the kind going on, or false).
 */

type HappeningsData = NonNullable<Components['Happenings']>;
type Card = HappeningsData['deck'][number];
type Current = NonNullable<HappeningsData['current']>;

const DAY_MS = 86_400_000;
/** Real ms between draw checks of an entity (expressions are not evaluated every frame). */
const CHECK_MS = 1000;

export interface HappeningView {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  since: number;
  until: number;
  /** Game-clock minutes left (0 when only the real-time minimum keeps it). */
  minutesLeft: number;
}

export interface HappeningHost {
  readonly seed: number;
  readonly clock: { readonly now: number };
  world(): World;
  game(): Game;
  ensure(e: Entity): void;
  touch(e: Entity): void;
}

function happeningsOf(e: Entity): HappeningsData {
  const h = e.components.Happenings;
  if (!h) throw new Error(`entity "${e.id}" has no Happenings`);
  return h;
}

const view = (c: Current, now: number): HappeningView => ({
  id: c.id,
  kind: c.kind,
  data: structuredClone(c.data),
  since: c.since,
  until: c.until,
  minutesLeft: Math.max(0, Math.round((c.until - now) / 6000) / 10),
});

/** Kind of the happening going on at this entity, or false. */
export function happeningOf(e: Entity): string | false {
  return e.components.Happenings?.current?.kind ?? false;
}

export function happeningView(e: Entity, now: number): HappeningView | null {
  const c = e.components.Happenings?.current;
  return c ? view(c, now) : null;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class HappeningRunner {
  private readonly compiled = new Map<string, (scope: ExprScope) => unknown>();
  private readonly rngs = new Map<string, Rng>();
  /** Per world (scene load): real ms of the last end per entity, and of the last draw check. */
  private session: { world: World; lastEnd: Map<string, number>; checked: Map<string, number>; realStart: Map<string, number> } | null = null;
  private seen: { world: World; emitted: number } | null = null;
  /** Entities whose deck failed (a bad expression): no more draws until the scene reloads. */
  private failed = new WeakSet<Entity>();

  constructor(private readonly host: HappeningHost) {}

  private get realMs() {
    return Math.round(this.host.world().time * 1000);
  }

  private get state() {
    const w = this.host.world();
    if (!this.session || this.session.world !== w) this.session = { world: w, lastEnd: new Map(), checked: new Map(), realStart: new Map() };
    return this.session;
  }

  private rng(e: Entity): Rng {
    let r = this.rngs.get(e.id);
    if (!r) this.rngs.set(e.id, (r = new Rng(hash(`${this.host.seed}:happenings:${e.id}:${this.host.clock.now}`))));
    return r;
  }

  private interval(e: Entity, h: HappeningsData): number {
    return Math.round(h.everyMinutes * (0.5 + this.rng(e).next()) * 60_000);
  }

  private eval(src: string, e: Entity, what: string): unknown {
    let fn = this.compiled.get(src);
    if (!fn) {
      fn = compileExpr(src);
      this.compiled.set(src, fn);
    }
    try {
      return fn({ game: this.host.game(), self: e.id });
    } catch (err) {
      const msg = err instanceof ExprError ? err.message : err instanceof Error ? err.message : String(err);
      throw new Error(`Happenings of "${e.id}", ${what} "${src}": ${msg}`);
    }
  }

  private weight(card: Card, e: Entity): number {
    const w = typeof card.weight === 'number' ? card.weight : Number(this.eval(card.weight, e, `card "${card.id}" weight`));
    return Number.isFinite(w) && w > 0 ? w : 0;
  }

  /** Cards that could be drawn now, with their weights (> 0). */
  candidates(e: Entity): { id: string; weight: number }[] {
    this.host.ensure(e);
    const h = happeningsOf(e);
    const now = this.host.clock.now;
    const day = Math.floor(now / DAY_MS);
    const out: { id: string; weight: number }[] = [];
    for (const card of h.deck) {
      const past = h.history[card.id];
      if (past && card.cooldownMinutes > 0 && now >= past.last && now - past.last < card.cooldownMinutes * 60_000) continue;
      if (past && card.maxPerDay > 0 && past.day === day && past.count >= card.maxPerDay) continue;
      if (card.when !== undefined && !this.eval(card.when, e, `card "${card.id}" when`)) continue;
      const weight = this.weight(card, e);
      if (weight > 0) out.push({ id: card.id, weight });
    }
    return out;
  }

  /** Starts a card now (a script, a test): skips the draw rules, not the one-at-a-time. */
  start(e: Entity, kind: string, data?: Record<string, unknown>): HappeningView | null {
    this.host.ensure(e);
    const h = happeningsOf(e);
    const card = h.deck.find((c) => c.id === kind);
    if (!card) throw new Error(`happenings.start: no card "${kind}" (deck: ${h.deck.map((c) => c.id).join(', ') || 'empty'})`);
    if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) throw new Error('happenings.start: data must be an object');
    if (h.current) return null;
    const now = this.host.clock.now;
    const day = Math.floor(now / DAY_MS);
    h.seq++;
    h.current = {
      id: `h${h.seq}`,
      kind,
      data: structuredClone(data ?? {}),
      since: now,
      until: now + card.minutes * 60_000,
      ...(card.minRealSeconds !== undefined && { minRealSeconds: card.minRealSeconds }),
      endOn: structuredClone(card.endOn),
    };
    h.today = h.today && h.today.day === day ? { day, count: h.today.count + 1 } : { day, count: 1 };
    const past = h.history[kind];
    h.history[kind] = { last: past?.last ?? now, day, count: past && past.day === day ? past.count + 1 : 1 };
    this.state.realStart.set(e.id, this.realMs);
    this.host.touch(e);
    this.host.world().emit('happening_start', { entity: e.id, id: h.current.id, kind, data: structuredClone(h.current.data) });
    return view(h.current, now);
  }

  /** Ends the happening going on (with an outcome); null if none. */
  end(e: Entity, outcome = 'ended', data?: Record<string, unknown>, by = 'script', trigger?: Record<string, unknown>): HappeningView | null {
    this.host.ensure(e);
    const h = happeningsOf(e);
    const c = h.current;
    if (!c) return null;
    if (data) Object.assign(c.data, structuredClone(data));
    const now = this.host.clock.now;
    delete h.current;
    const past = h.history[c.kind];
    if (past) past.last = now;
    h.next = now + this.interval(e, h);
    this.state.lastEnd.set(e.id, this.realMs);
    this.state.realStart.delete(e.id);
    this.host.touch(e);
    this.host.world().emit('happening_end', { entity: e.id, id: c.id, kind: c.kind, data: structuredClone(c.data), outcome: String(outcome), by, ...(trigger && { trigger }) });
    return view(c, now);
  }

  /** Merges data into the happening going on (what the game keeps with it). */
  update(e: Entity, data: Record<string, unknown>): HappeningView | null {
    this.host.ensure(e);
    const c = happeningsOf(e).current;
    if (!c) return null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('happenings.update: data must be an object');
    Object.assign(c.data, structuredClone(data));
    this.host.touch(e);
    return view(c, this.host.clock.now);
  }

  current(e: Entity): HappeningView | null {
    this.host.ensure(e);
    happeningsOf(e);
    return happeningView(e, this.host.clock.now);
  }

  /** Game-clock minutes until the next draw may happen (null while one goes on or before the first schedule). */
  nextIn(e: Entity): number | null {
    this.host.ensure(e);
    const h = happeningsOf(e);
    if (h.current || h.next === undefined) return null;
    return Math.max(0, Math.round((h.next - this.host.clock.now) / 6000) / 10);
  }

  /** Each frame, before scripts get the events: endings by the frame's events, by time, then draws. */
  run() {
    const w = this.host.world();
    if (!this.seen || this.seen.world !== w) this.seen = { world: w, emitted: w.emitted };
    const count = Math.min(w.emitted - this.seen.emitted, w.events.length);
    this.seen.emitted = w.emitted;
    const fresh = count > 0 ? w.events.slice(-count) : [];
    for (const e of w.entities) {
      const h = e.components.Happenings;
      if (!e.active || !h || this.failed.has(e)) continue;
      this.host.ensure(e);
      try {
        this.step(e, h, fresh);
      } catch (err) {
        this.failed.add(e);
        const message = err instanceof Error ? err.message : String(err);
        w.console.error(`${message}\n(happenings stopped until the scene reloads)`, 'happenings');
        w.emit('happening_error', { entity: e.id, message });
      }
    }
    // The events emitted here were already seen (scripts get them this frame).
    this.seen.emitted = w.emitted;
  }

  private step(e: Entity, h: HappeningsData, fresh: World['events']) {
    const now = this.host.clock.now;
    const st = this.state;
    const c = h.current;
    if (c) {
      for (const ev of fresh) {
        const t = c.endOn.find((x) => eventFits(ev, x, e.id));
        if (!t) continue;
        const { frame: _f, ...trigger } = ev;
        this.end(e, t.outcome, undefined, ev.type, trigger);
        return;
      }
      if (now < c.until) return;
      const started = st.realStart.get(e.id);
      if (c.minRealSeconds !== undefined && started !== undefined && this.realMs - started < c.minRealSeconds * 1000) return;
      this.end(e, 'expired', undefined, 'time');
      return;
    }
    const checked = st.checked.get(e.id);
    if (checked !== undefined && this.realMs - checked < CHECK_MS) return;
    st.checked.set(e.id, this.realMs);
    if (h.next === undefined) {
      h.next = now + this.interval(e, h);
      this.host.touch(e);
      return;
    }
    if (now < h.next || !h.deck.length) return;
    if (this.realMs - (st.lastEnd.get(e.id) ?? 0) < h.minGapRealSeconds * 1000) return;
    if (h.maxPerDay > 0 && h.today && h.today.day === Math.floor(now / DAY_MS) && h.today.count >= h.maxPerDay) return;
    if (h.when !== undefined && !this.eval(h.when, e, 'when')) return;
    const cards = this.candidates(e);
    if (!cards.length) return;
    let r = this.rng(e).next() * cards.reduce((s, x) => s + x.weight, 0);
    let pick = cards[cards.length - 1];
    for (const x of cards) {
      r -= x.weight;
      if (r < 0) {
        pick = x;
        break;
      }
    }
    this.start(e, pick.id);
  }
}
