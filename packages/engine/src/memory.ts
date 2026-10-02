import type { Components } from '@vibe/shared';
import type { Entity } from './entity';

/**
 * Memory: what happened to an individual and how it felt. Each memory is {type, subject?, tags,
 * valence -1..1, importance 0..1}; its strength is importance × ½^(age / half-life), with the age
 * counted on the game clock from the last time it happened. Living the same thing again (same type
 * and subject) reinforces that memory instead of adding another: it gets stronger and its valence
 * moves toward the new one. Weak memories are forgotten (event "memory_forgotten"), and past the
 * capacity the weakest goes first.
 *
 *   remember(type, {subject, tags, valence, importance})  -> the memory as it is now
 *   recall({type, subject, tag, minStrength, limit})       -> memories, strongest first, with strength
 *   feeling(subject, type?)                                 -> Σ valence × strength, -1..1 (0 = nothing remembered)
 *   forget({type, subject})                                 -> how many were dropped
 *
 * Nothing runs per frame: strength is computed when asked and forgetting happens on remember/recall.
 * The memories live in the component data (Memory.entries), so Persist keeps them and the snapshot,
 * hot reload and save slots see them. The engine never decides what is worth remembering: the game does.
 */

type MemoryData = NonNullable<Components['Memory']>;
type Entry = MemoryData['entries'][number];

const HOUR_MS = 3_600_000;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface MemoryView {
  type: string;
  subject?: string;
  tags: string[];
  valence: number;
  importance: number;
  /** Strength now (importance faded by age), 0..1. */
  strength: number;
  count: number;
  /** Game clock (ms) of the first and the last time. */
  t: number;
  last: number;
}

export interface RememberInput {
  subject?: string;
  tags?: string[];
  valence?: number;
  importance?: number;
}

export interface RecallQuery {
  type?: string;
  subject?: string;
  tag?: string;
  minStrength?: number;
  limit?: number;
}

/** Where forgotten memories are reported (the world's event bus). */
export type ForgetReporter = (entry: Entry) => void;

function memoryOf(e: Entity): MemoryData {
  const m = e.components.Memory;
  if (!m) throw new Error(`entity "${e.id}" has no Memory`);
  return m;
}

export function strengthOf(m: MemoryData, entry: Entry, now: number): number {
  const half = (m.halfLives[entry.type] ?? m.halfLifeHours) * HOUR_MS;
  const age = Math.max(0, now - entry.last);
  return round3(entry.importance * Math.pow(0.5, age / half));
}

const view = (m: MemoryData, entry: Entry, now: number): MemoryView => ({
  type: entry.type,
  ...(entry.subject !== undefined && { subject: entry.subject }),
  tags: [...entry.tags],
  valence: entry.valence,
  importance: entry.importance,
  strength: strengthOf(m, entry, now),
  count: entry.count,
  t: entry.t,
  last: entry.last,
});

/** Drops memories below minStrength, then the weakest past the capacity. */
function prune(m: MemoryData, now: number, report?: ForgetReporter) {
  const kept: Entry[] = [];
  for (const entry of m.entries) {
    if (strengthOf(m, entry, now) < m.minStrength) report?.(entry);
    else kept.push(entry);
  }
  if (kept.length > m.capacity) {
    kept.sort((a, b) => strengthOf(m, b, now) - strengthOf(m, a, now));
    for (const entry of kept.splice(m.capacity)) report?.(entry);
  }
  m.entries = kept;
}

export function remember(e: Entity, now: number, type: string, input: RememberInput = {}, report?: ForgetReporter): { memory: MemoryView; reinforced: boolean } {
  if (typeof type !== 'string' || !type) throw new Error('memory.remember: type must be a non-empty string');
  const valence = input.valence ?? 0;
  const importance = input.importance ?? 0.5;
  if (!Number.isFinite(valence)) throw new Error('memory.remember: valence must be a number (-1..1)');
  if (!Number.isFinite(importance)) throw new Error('memory.remember: importance must be a number (0..1)');
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some((t) => typeof t !== 'string'))) throw new Error('memory.remember: tags must be an array of strings');
  const subject = input.subject === undefined || input.subject === null ? undefined : String(input.subject);
  const v = clamp(valence, -1, 1);
  const imp = clamp(importance, 0, 1);
  const m = memoryOf(e);
  prune(m, now, report);
  const same = subject !== undefined ? m.entries.find((x) => x.type === type && x.subject === subject) : undefined;
  if (same) {
    // Again: stronger (from what is left of it, plus a quarter of the new one) and the feeling moves toward the new one.
    const left = strengthOf(m, same, now);
    same.valence = round3(clamp((same.valence * left + v * imp) / Math.max(1e-6, left + imp), -1, 1));
    same.importance = round3(Math.min(1, Math.max(left, imp) + imp * 0.25));
    same.last = now;
    same.count++;
    for (const t of input.tags ?? []) if (!same.tags.includes(t)) same.tags.push(t);
    return { memory: view(m, same, now), reinforced: true };
  }
  const entry: Entry = { type, ...(subject !== undefined && { subject }), tags: [...(input.tags ?? [])], valence: round3(v), importance: round3(imp), t: now, last: now, count: 1 };
  m.entries.push(entry);
  prune(m, now, report);
  return { memory: view(m, entry, now), reinforced: false };
}

function matches(entry: Entry, q: RecallQuery): boolean {
  if (q.type !== undefined && entry.type !== q.type) return false;
  if (q.subject !== undefined && entry.subject !== q.subject) return false;
  if (q.tag !== undefined && !entry.tags.includes(q.tag)) return false;
  return true;
}

/** Memories matching the query, strongest first. With `readOnly` nothing is forgotten (snapshots). */
export function recall(e: Entity, now: number, q: RecallQuery = {}, report?: ForgetReporter, readOnly = false): MemoryView[] {
  const m = memoryOf(e);
  if (!readOnly) prune(m, now, report);
  const min = Math.max(q.minStrength ?? 0, readOnly ? m.minStrength : 0);
  const out = m.entries.filter((x) => matches(x, q)).map((x) => view(m, x, now)).filter((x) => x.strength >= min);
  out.sort((a, b) => b.strength - a.strength || b.last - a.last);
  return q.limit !== undefined ? out.slice(0, Math.max(0, q.limit)) : out;
}

/** How the entity feels about a subject from what it remembers: Σ valence × strength, -1..1. */
export function feelingOf(e: Entity, now: number, subject: string, type?: string): number {
  const m = memoryOf(e);
  let sum = 0;
  for (const x of m.entries) if (x.subject === subject && (type === undefined || x.type === type)) sum += x.valence * strengthOf(m, x, now);
  return round3(clamp(sum, -1, 1));
}

export function forget(e: Entity, q: { type?: string; subject?: string } = {}): number {
  const m = memoryOf(e);
  const before = m.entries.length;
  m.entries = m.entries.filter((x) => !matches(x, q));
  return before - m.entries.length;
}
