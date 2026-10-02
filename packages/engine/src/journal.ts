import type { Components } from '@vibe/shared';
import type { Entity } from './entity';

/**
 * Journal: the chronicle of one entity — what happened to it, in the game's own words. Each entry
 * has a category (the game's diary sections), a text, an importance and optionally a key: an entry
 * with a key is added once ("the first time it tasted an apple"), unless `replace` updates it. Past
 * the capacity, the least important entry goes (the oldest among equals), so a long life keeps its
 * milestones and drops small talk.
 */

type JournalData = NonNullable<Components['Journal']>;
export type JournalEntry = JournalData['entries'][number];

export interface JournalAdd {
  importance?: number;
  key?: string;
  /** With a key that already exists: update its text, importance and time instead of skipping. */
  replace?: boolean;
}

function journalOf(e: Entity): JournalData {
  const j = e.components.Journal;
  if (!j) throw new Error(`entity "${e.id}" has no Journal`);
  return j;
}

/** Adds an entry; returns it, or null when its key is already there (and not replaced). */
export function addEntry(e: Entity, now: number, category: string, text: string, opts: JournalAdd = {}): JournalEntry | null {
  if (typeof category !== 'string' || !category) throw new Error('journal.add: category must be a non-empty string');
  if (typeof text !== 'string' || !text) throw new Error('journal.add: text must be a non-empty string');
  const importance = opts.importance ?? 0.5;
  if (!Number.isFinite(importance)) throw new Error('journal.add: importance must be a number (0..1)');
  const j = journalOf(e);
  const key = opts.key === undefined || opts.key === null ? undefined : String(opts.key);
  const entry: JournalEntry = { t: now, category, text, importance: Math.max(0, Math.min(1, importance)), ...(key !== undefined && { key }) };
  if (key !== undefined) {
    const i = j.entries.findIndex((x) => x.key === key);
    if (i >= 0) {
      if (!opts.replace) return null;
      j.entries.splice(i, 1);
    }
  }
  j.entries.push(entry);
  while (j.entries.length > j.capacity) {
    let drop = 0;
    for (let i = 1; i < j.entries.length; i++) if (j.entries[i].importance < j.entries[drop].importance) drop = i;
    j.entries.splice(drop, 1);
  }
  return entry;
}

/** Entries (optionally of one category), newest first. */
export function journalEntries(e: Entity, q: { category?: string; limit?: number } = {}): JournalEntry[] {
  // Newest first; at the same clock time, the one added later first.
  const out = journalOf(e)
    .entries.map((x, i) => ({ x, i }))
    .filter(({ x }) => q.category === undefined || x.category === q.category)
    .sort((a, b) => b.x.t - a.x.t || b.i - a.i)
    .map(({ x }) => x);
  return (q.limit !== undefined ? out.slice(0, Math.max(0, q.limit)) : out).map((x) => ({ ...x }));
}

export const hasEntry = (e: Entity, key: string) => journalOf(e).entries.some((x) => x.key === key);

export function removeEntry(e: Entity, key: string): boolean {
  const j = journalOf(e);
  const i = j.entries.findIndex((x) => x.key === key);
  if (i < 0) return false;
  j.entries.splice(i, 1);
  return true;
}
