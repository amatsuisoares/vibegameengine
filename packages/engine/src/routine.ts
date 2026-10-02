import type { Components } from '@vibe/shared';
import type { Entity } from './entity';

/**
 * Routine: habits learned from what an entity actually does. The day is split into `slots` by the
 * local clock hour; each record adds weight to (activity, slot of now), and all weights fade with a
 * half-life in days of game clock, so a routine follows the entity as it changes — no script tells
 * it "play after lunch", it just ends up doing so.
 *
 *   habit(activity, hour?)  share of that activity among everything done in that slot, 0..1
 *   peak(activity)          the slot it is done most, with its hours
 *   patterns()              stable habits: slots where an activity has enough weight and share
 *
 * The weights live in the component data (Routine.values), so Persist keeps them and the snapshot,
 * hot reload and save slots see them. Decay is applied lazily, on each record.
 */

type RoutineData = NonNullable<Components['Routine']>;

const DAY_MS = 24 * 3_600_000;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

export interface Habit {
  activity: string;
  slot: number;
  /** Hours the slot covers, e.g. 15 and 18. */
  from: number;
  to: number;
  /** Share of the slot (0..1). */
  share: number;
  /** Weight behind it. */
  weight: number;
}

export interface RoutineClock {
  readonly now: number;
  /** Local hour 0..24. */
  readonly hour: number;
}

function routineOf(e: Entity): RoutineData {
  const r = e.components.Routine;
  if (!r) throw new Error(`entity "${e.id}" has no Routine`);
  return r;
}

export const slotOf = (r: RoutineData, hour: number) => Math.min(r.slots - 1, Math.floor((((hour % 24) + 24) % 24) / (24 / r.slots)));
const hoursOf = (r: RoutineData, slot: number) => ({ from: round3(slot * (24 / r.slots)), to: round3((slot + 1) * (24 / r.slots)) });

/** Fades every weight by the time since the last update. */
function decay(r: RoutineData, now: number) {
  if (r.updatedAt !== undefined && now > r.updatedAt) {
    const k = Math.pow(0.5, (now - r.updatedAt) / (r.halfLifeDays * DAY_MS));
    for (const [a, w] of Object.entries(r.values)) {
      r.values[a] = w.map((v) => round3(v * k));
      if (r.values[a].every((v) => v < 0.001)) delete r.values[a];
    }
  }
  r.updatedAt = Math.max(now, r.updatedAt ?? now);
}

/** The entity did `activity` now (weight: how much it counts, e.g. 1 per time or minutes spent). */
export function recordActivity(e: Entity, clock: RoutineClock, activity: string, weight = 1) {
  if (typeof activity !== 'string' || !activity) throw new Error('routine.record: activity must be a non-empty string');
  if (!Number.isFinite(weight) || weight <= 0) throw new Error('routine.record: weight must be a number > 0');
  const r = routineOf(e);
  decay(r, clock.now);
  const w = r.values[activity] ?? [];
  while (w.length < r.slots) w.push(0);
  w.length = r.slots;
  w[slotOf(r, clock.hour)] = round3(w[slotOf(r, clock.hour)] + weight);
  r.values[activity] = w;
}

/** Share of `activity` among what was done in the slot of `hour`, 0..1 (0 when nothing is known). */
export function habitOf(e: Entity, activity: string, hour: number): number {
  const r = routineOf(e);
  const s = slotOf(r, hour);
  let total = 0;
  for (const w of Object.values(r.values)) total += w[s] ?? 0;
  return total > 0 ? round3((r.values[activity]?.[s] ?? 0) / total) : 0;
}

/** The slot an activity is done most, or null. */
export function peakOf(e: Entity, activity: string): { slot: number; from: number; to: number; weight: number } | null {
  const r = routineOf(e);
  const w = r.values[activity];
  if (!w?.some((v) => v > 0)) return null;
  const slot = w.indexOf(Math.max(...w));
  return { slot, ...hoursOf(r, slot), weight: w[slot] };
}

/** Stable habits: (activity, slot) with weight >= minEvidence and at least `minShare` of that slot. */
export function patternsOf(e: Entity, minShare = 0.4): Habit[] {
  const r = routineOf(e);
  const out: Habit[] = [];
  for (let slot = 0; slot < r.slots; slot++) {
    let total = 0;
    for (const w of Object.values(r.values)) total += w[slot] ?? 0;
    if (total <= 0) continue;
    for (const [activity, w] of Object.entries(r.values)) {
      const weight = w[slot] ?? 0;
      const share = weight / total;
      if (weight >= r.minEvidence && share >= minShare) out.push({ activity, slot, ...hoursOf(r, slot), share: round3(share), weight: round3(weight) });
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}
