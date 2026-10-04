import type { Components } from '@vibe/shared';
import type { Entity } from './entity';

/**
 * Relationship: how bonded an individual is to someone ("player", another entity id...), 0..1.
 * Bonds are earned slowly: a gain is scaled by how far the bond still is from the top
 * (amount × (1 − value)), and gains for the same reason are capped per game-clock day (petting
 * fifty times in a row is worth what the cap allows). Without new gains the bond fades on the game
 * clock toward a floor — never below `keep` × the best it ever was, so a long friendship is not
 * lost in a week away. Crossing a threshold of `levels` is a "relationship_level" event.
 *
 *   add(subject, amount, {reason}) -> {subject, value, level, delta, from}   (negative amounts are losses, not capped)
 *   get(subject)                   -> 0..1 now (with fading), `initial` for a subject never seen
 *   level(subject)                 -> 0..levels.length (how many thresholds it reached)
 *   list()                         -> every subject with its value and level, strongest first
 *
 * Nothing runs per frame: fading is computed when asked and stored when the bond changes. The values
 * live in the component data (Relationship.values), so Persist keeps them and the snapshot, hot reload
 * and save slots see them. The engine never decides what a bond is worth: the game does.
 */

type RelationshipData = NonNullable<Components['Relationship']>;
type Bond = RelationshipData['values'][string];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export interface BondView {
  subject: string;
  value: number;
  level: number;
  /** Best value ever reached. */
  peak: number;
}

export interface BondChange extends BondView {
  /** What actually changed (after the scaling and the daily cap). */
  delta: number;
  /** Level before the change. */
  from: number;
}

function relationshipOf(e: Entity): RelationshipData {
  const r = e.components.Relationship;
  if (!r) throw new Error(`entity "${e.id}" has no Relationship`);
  return r;
}

export function bondLevel(r: RelationshipData, value: number): number {
  let n = 0;
  for (const t of r.levels) if (value >= t) n++;
  return n;
}

/** Value now: what is above the floor fades with the half-life since the last change. */
function faded(r: RelationshipData, b: Bond, now: number): number {
  const floor = Math.max(r.initial, b.peak * r.keep);
  if (b.value <= floor) return b.value;
  const hours = Math.max(0, now - b.t) / HOUR_MS;
  return floor + (b.value - floor) * 0.5 ** (hours / r.halfLifeHours);
}

export function bondOf(e: Entity, now: number, subject: string): number {
  const r = relationshipOf(e);
  const b = r.values[subject];
  return round4(b ? faded(r, b, now) : r.initial);
}

export function addBond(e: Entity, now: number, subject: string, amount: number, reason?: string): BondChange {
  if (typeof subject !== 'string' || !subject) throw new Error('relationship.add: subject must be a non-empty string');
  if (!Number.isFinite(amount)) throw new Error('relationship.add: amount must be a number');
  const r = relationshipOf(e);
  const b: Bond = r.values[subject] ?? { value: r.initial, peak: r.initial, t: now };
  const before = faded(r, b, now);
  let delta = amount > 0 ? amount * (1 - before) : amount;
  if (amount > 0 && reason !== undefined && r.dailyCaps[reason] !== undefined) {
    const day = Math.floor(now / DAY_MS);
    if (!b.today || b.today.day !== day) b.today = { day, gains: {} };
    const used = b.today.gains[reason] ?? 0;
    delta = Math.min(delta, Math.max(0, r.dailyCaps[reason] - used));
    b.today.gains[reason] = round4(used + delta);
  }
  const value = clamp01(before + delta);
  b.value = round4(value);
  b.peak = round4(Math.max(b.peak, value));
  b.t = now;
  r.values[subject] = b;
  return { subject, value: b.value, level: bondLevel(r, b.value), peak: b.peak, delta: round4(b.value - before), from: bondLevel(r, before) };
}

export function listBonds(e: Entity, now: number): BondView[] {
  const r = relationshipOf(e);
  return Object.entries(r.values)
    .map(([subject, b]) => {
      const value = round4(faded(r, b, now));
      return { subject, value, level: bondLevel(r, value), peak: b.peak };
    })
    .sort((a, b) => b.value - a.value);
}
