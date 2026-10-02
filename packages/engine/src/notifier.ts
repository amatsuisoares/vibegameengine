import type { GameStorage } from './storage';
import type { World } from './world';

/**
 * Notifier: the observations a game shows the player ("Mimi seems hungry."), with the rules that
 * keep them from piling up, so every system that wants to say something goes through one place:
 *
 *   game.notify(kind, text, {cooldownMs, realCooldownMs, priority, entity, data}) -> shown?
 *
 * - cooldownMs: the same kind is not repeated within this much GAME clock (survives sessions);
 * - realCooldownMs: nor within this much REAL time (at 600× the clock flies, the player does not);
 * - priority (default 1): within config.notifications.minGapMs (real) of the last one shown,
 *   background notifications (priority 0) and those of lower priority than it are dropped.
 *
 * Shown ones become the event "notification" {kind, text, priority, entity?, ...data} (what the game's
 * UI displays) and go to a log kept in storage with the clock cooldowns ("vibe.notifications").
 */

export const NOTIFICATIONS_KEY = 'vibe.notifications';

export interface NotifyOptions {
  cooldownMs?: number;
  realCooldownMs?: number;
  priority?: number;
  entity?: string;
  data?: Record<string, unknown>;
}

export interface NotificationEntry {
  /** Game clock (ms). */
  t: number;
  kind: string;
  text: string;
  entity?: string;
}

interface Saved {
  cooldowns: Record<string, number>;
  log: NotificationEntry[];
}

export interface NotifierHost {
  readonly storage: GameStorage;
  readonly clock: { readonly now: number };
  /** Real (simulated) time in ms since the game started: frames × fixed step. */
  realMs(): number;
  world(): World;
  config(): { minGapMs: number; logSize: number };
}

const finiteOpt = (v: unknown, what: string) => {
  if (v === undefined) return 0;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`notify: ${what} must be a number >= 0`);
  return v;
};

export class Notifier {
  /** Real-time cooldowns (not saved: a new session starts fresh). */
  private readonly realAt = new Map<string, number>();
  private last: { at: number; priority: number } | null = null;

  constructor(private readonly host: NotifierHost) {}

  private saved(): Saved {
    const v = this.host.storage.get(NOTIFICATIONS_KEY) as Partial<Saved> | undefined;
    return { cooldowns: v && typeof v.cooldowns === 'object' && v.cooldowns ? { ...v.cooldowns } : {}, log: Array.isArray(v?.log) ? [...v.log] : [] };
  }

  notify(kind: string, text: string, options: NotifyOptions = {}): boolean {
    if (typeof kind !== 'string' || !kind) throw new Error('notify: kind must be a non-empty string');
    if (typeof text !== 'string' || !text) throw new Error('notify: text must be a non-empty string');
    const cooldown = finiteOpt(options.cooldownMs, 'cooldownMs');
    const realCooldown = finiteOpt(options.realCooldownMs, 'realCooldownMs');
    const priority = options.priority ?? 1;
    if (typeof priority !== 'number' || !Number.isFinite(priority)) throw new Error('notify: priority must be a number');
    const now = this.host.clock.now;
    const real = this.host.realMs();
    const s = this.saved();
    const lastClock = s.cooldowns[kind];
    if (cooldown > 0 && lastClock !== undefined && now >= lastClock && now - lastClock < cooldown) return false;
    const lastReal = this.realAt.get(kind);
    if (realCooldown > 0 && lastReal !== undefined && real - lastReal < realCooldown) return false;
    const gap = this.host.config().minGapMs;
    if (gap > 0 && this.last && real - this.last.at < gap && (priority <= 0 || priority < this.last.priority)) return false;

    s.cooldowns[kind] = now;
    this.realAt.set(kind, real);
    this.last = { at: real, priority };
    const entry: NotificationEntry = { t: now, kind, text, ...(options.entity !== undefined && { entity: String(options.entity) }) };
    s.log.push(entry);
    const size = this.host.config().logSize;
    if (s.log.length > size) s.log.splice(0, s.log.length - size);
    this.host.storage.set(NOTIFICATIONS_KEY, s);
    this.host.world().emit('notification', { ...(options.data ?? {}), kind, text, priority, ...(entry.entity !== undefined && { entity: entry.entity }) });
    return true;
  }

  /** The last `n` notifications shown (oldest first), optionally of one entity. */
  log(n?: number, entity?: string): NotificationEntry[] {
    const all = this.saved().log.filter((x) => entity === undefined || x.entity === entity);
    return n === undefined ? all : all.slice(-Math.max(0, n));
  }

  /** Forgets the log and the cooldowns (e.g. a new individual starts). */
  clear() {
    this.host.storage.remove(NOTIFICATIONS_KEY);
    this.realAt.clear();
    this.last = null;
  }
}
