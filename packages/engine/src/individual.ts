import { MemoryEntrySchema, type Components } from '@vibe/shared';
import type { Entity } from './entity';
import { itemTags } from './items';
import { Rng } from './rng';
import type { GameStorage } from './storage';
import type { World } from './world';

/**
 * Individuals: what makes two entities with the same components different — and stay different
 * across sessions.
 *
 *   Traits       personality axes 0..1 (fixed, or drawn from ranges); stable
 *   Preferences  affinity -1..1 per subject (item id, tag, context) = innate + learned; innate values
 *                may lean on traits; learning moves slowly and is bounded
 *   Routine      habits by time of day (see routine.ts)
 *   Memory       experiences that fade and get reinforced (see memory.ts)
 *   Persist      keeps them in game.storage[key]: loaded before the entity's first onStart, drawn
 *                when missing, saved at the end of any frame in which they changed
 *
 * Generated values go into the component data itself (Traits.values, Preferences.values), so the
 * snapshot, hot reload and save slots see them like any other component value. Drawing uses its own
 * generator seeded from the game seed, the entity id and the calendar clock: reproducible in runs,
 * different for a pet created later in the same session, and it never shifts the game's RNG.
 *
 * Nothing here knows what a pet, hunger or an apple is: games give the axes and subjects meaning.
 */

export type PreferenceLevel = 'love' | 'like' | 'neutral' | 'dislike' | 'hate';

export interface Evaluation {
  /** Combined affinity -1..1 (0 when nothing about it is known). */
  score: number;
  level: PreferenceLevel;
  /** Whether the subject or any of the tags has an affinity. */
  known: boolean;
  /** The affinities that contributed (subject and tags). */
  parts: Record<string, number>;
}

/** Saved form in game.storage[Persist.key]. */
export interface PersistedIndividual {
  version: 1;
  traits?: Record<string, number>;
  preferences?: Record<string, { innate: number; learned: number; n: number }>;
  routine?: { values: Record<string, number[]>; updatedAt?: number };
  memory?: unknown[];
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Level of an affinity: ≥ 0.6 love · ≥ 0.2 like · > −0.2 neutral · > −0.6 dislike · else hate. */
export function preferenceLevel(score: number): PreferenceLevel {
  if (score >= 0.6) return 'love';
  if (score >= 0.2) return 'like';
  if (score > -0.2) return 'neutral';
  if (score > -0.6) return 'dislike';
  return 'hate';
}

/** A trait value; throws for an unknown axis (typos should not read as "average"). */
export function traitOf(e: Entity, axis: string): number {
  const t = e.components.Traits;
  if (!t) throw new Error(`entity "${e.id}" has no Traits`);
  const v = t.values[axis];
  if (v === undefined) throw new Error(`entity "${e.id}" has no trait "${axis}" (traits: ${Object.keys(t.values).join(', ') || 'none'})`);
  return v;
}

/** Affinity for a subject, innate + learned (0 = neutral or unknown). */
export function affinityOf(e: Entity, subject: string): number {
  const p = e.components.Preferences?.values[subject];
  return p ? round3(clamp(p.innate + p.learned, -1, 1)) : 0;
}

/**
 * How the entity feels about something: the subject's own affinity weighted (subjectWeight) with its
 * tags' — their mean, or blended toward the strongest feeling among them (tagBlend). Either side
 * alone counts fully when the other is unknown.
 */
export function evaluate(e: Entity, subject: string | null, tags: readonly string[] = []): Evaluation {
  const prefs = e.components.Preferences;
  const parts: Record<string, number> = {};
  const has = (s: string) => !!prefs && Object.hasOwn(prefs.values, s);
  const own = subject !== null && has(subject) ? affinityOf(e, subject) : null;
  if (own !== null) parts[subject!] = own;
  const tagValues: number[] = [];
  for (const t of tags) {
    if (!has(t) || Object.hasOwn(parts, t)) continue;
    parts[t] = affinityOf(e, t);
    tagValues.push(parts[t]);
  }
  let tagScore: number | null = null;
  if (tagValues.length) {
    const mean = tagValues.reduce((s, v) => s + v, 0) / tagValues.length;
    const strongest = tagValues.reduce((a, v) => (Math.abs(v) > Math.abs(a) ? v : a), 0);
    const b = prefs?.tagBlend ?? 0;
    tagScore = (1 - b) * mean + b * strongest;
  }
  const w = prefs?.subjectWeight ?? 0.6;
  const score = own !== null && tagScore !== null ? w * own + (1 - w) * tagScore : (own ?? tagScore ?? 0);
  const s = round3(score);
  return { score: s, level: preferenceLevel(s), known: own !== null || tagScore !== null, parts };
}

/**
 * One experience with a subject (outcome -1..1, e.g. a bad or a great reaction): the learned part
 * moves by learnRate × outcome, bounded by maxLearned. Returns the new affinity.
 */
export function learn(e: Entity, subject: string, outcome: number): number {
  const p = e.components.Preferences;
  if (!p) throw new Error(`entity "${e.id}" has no Preferences`);
  if (!Number.isFinite(outcome)) throw new Error(`learn("${subject}"): outcome must be a number`);
  const v = (p.values[subject] ??= { innate: 0, learned: 0, n: 0 });
  v.learned = round3(clamp(v.learned + p.learnRate * clamp(outcome, -1, 1), -p.maxLearned, p.maxLearned));
  v.n++;
  return affinityOf(e, subject);
}

/** How the entity feels about an item: by its id, its category and its tags. */
export function evaluateItem(e: Entity, item: { id: string; category: string; tags: readonly string[] }): Evaluation {
  return evaluate(e, item.id, itemTags(item));
}

/** 32-bit string hash (FNV-1a) for deriving generator seeds. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Draws the missing trait and preference values; returns the names it drew. */
export function generateMissing(c: Components, rng: Rng): string[] {
  const drawn: string[] = [];
  const t = c.Traits;
  if (t) {
    for (const [axis, g] of Object.entries(t.generate)) {
      if (t.values[axis] !== undefined) continue;
      t.values[axis] = round3(rng.range(g.min, g.max));
      drawn.push(axis);
    }
  }
  const p = c.Preferences;
  if (p) {
    for (const [subject, g] of Object.entries(p.generate)) {
      if (p.values[subject] !== undefined) continue;
      let v = rng.range(g.min, g.max);
      for (const [axis, weight] of Object.entries(g.traits)) v += weight * ((t?.values[axis] ?? 0.5) - 0.5) * 2;
      p.values[subject] = { innate: round3(clamp(v, -1, 1)), learned: 0, n: 0 };
      drawn.push(subject);
    }
  }
  return drawn;
}

export function persistedOf(c: Components): PersistedIndividual {
  const out: PersistedIndividual = { version: 1 };
  if (c.Traits) out.traits = { ...c.Traits.values };
  if (c.Preferences) out.preferences = structuredClone(c.Preferences.values);
  if (c.Routine) out.routine = { values: structuredClone(c.Routine.values), ...(c.Routine.updatedAt !== undefined && { updatedAt: c.Routine.updatedAt }) };
  if (c.Memory) out.memory = structuredClone(c.Memory.entries);
  return out;
}

/** Copies saved values over the component data (unknown saved axes/subjects are kept too). */
function applyPersisted(c: Components, saved: unknown): boolean {
  if (!saved || typeof saved !== 'object' || (saved as PersistedIndividual).version !== 1) return false;
  const s = saved as PersistedIndividual;
  if (c.Traits && s.traits) {
    for (const [axis, v] of Object.entries(s.traits)) if (typeof v === 'number' && Number.isFinite(v)) c.Traits.values[axis] = clamp(v, 0, 1);
  }
  if (c.Preferences && s.preferences) {
    for (const [subject, v] of Object.entries(s.preferences)) {
      if (!v || typeof v !== 'object') continue;
      const innate = Number(v.innate);
      const learned = Number(v.learned);
      c.Preferences.values[subject] = {
        innate: Number.isFinite(innate) ? clamp(innate, -1, 1) : 0,
        learned: Number.isFinite(learned) ? clamp(learned, -1, 1) : 0,
        n: Number.isInteger(v.n) && v.n >= 0 ? v.n : 0,
      };
    }
  }
  if (c.Routine && s.routine && typeof s.routine === 'object') {
    for (const [activity, w] of Object.entries(s.routine.values ?? {})) {
      if (Array.isArray(w)) c.Routine.values[activity] = w.map((v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0));
    }
    if (typeof s.routine.updatedAt === 'number') c.Routine.updatedAt = s.routine.updatedAt;
  }
  if (c.Memory && Array.isArray(s.memory)) {
    const ok = MemoryEntrySchema.array().safeParse(s.memory.filter((x) => MemoryEntrySchema.safeParse(x).success));
    if (ok.success) c.Memory.entries = ok.data;
  }
  return true;
}

export interface IndividualHost {
  readonly seed: number;
  readonly storage: GameStorage;
  readonly clock: { readonly now: number };
}

/** Sets up and saves the individuals of one world (created per scene load). */
export class IndividualRunner {
  private readonly ready = new WeakSet<Entity>();
  private readonly dirty = new Set<Entity>();
  private resets = 0;
  /** Values the entity was authored with (before loading and drawing), for reset. */
  private readonly authored = new WeakMap<Entity, { traits?: Record<string, number>; preferences?: PersistedIndividual['preferences']; routine?: Record<string, number[]>; memory?: unknown[] }>();

  constructor(
    private readonly world: World,
    private readonly host: IndividualHost,
  ) {}

  /** Start of the frame, before any onStart: entities not set up yet are loaded or drawn. */
  init() {
    for (const e of this.world.entities) if (e.active) this.ensure(e);
  }

  /** Loads the persisted values, draws what is missing (once per entity and scene). */
  ensure(e: Entity) {
    if (this.ready.has(e)) return;
    const c = e.components;
    if (!c.Traits && !c.Preferences && !c.Routine && !c.Memory) return;
    this.ready.add(e);
    this.authored.set(e, { traits: c.Traits && { ...c.Traits.values }, preferences: c.Preferences && structuredClone(c.Preferences.values), routine: c.Routine && structuredClone(c.Routine.values), memory: c.Memory && structuredClone(c.Memory.entries) });
    const key = c.Persist?.key;
    const loaded = key !== undefined && applyPersisted(c, this.host.storage.get(key));
    const rng = new Rng(hash(`${this.host.seed}:${e.id}:${this.host.clock.now}`));
    const drawn = generateMissing(c, rng);
    this.world.emit('individual', { entity: e.id, ...(key !== undefined && { key }), loaded, drawn });
    if (key !== undefined && (!loaded || drawn.length)) this.dirty.add(e);
  }

  /** Something changed (a script set a trait, learned a preference): save at the end of the frame. */
  touch(e: Entity) {
    this.ensure(e);
    if (e.components.Persist) this.dirty.add(e);
  }

  /** Saves now (self.persist.save()). */
  save(e: Entity) {
    this.ensure(e);
    this.dirty.delete(e);
    const key = e.components.Persist?.key;
    if (key === undefined) throw new Error(`entity "${e.id}" has no Persist`);
    this.host.storage.set(key, persistedOf(e.components));
  }

  /**
   * Forgets the individual (self.persist.reset()): the scene's authored values come back, the
   * generated ones are drawn again (a new individual) and saved. `preset.traits` fixes some axes
   * before the draw, so preferences that lean on them follow (an heir, a migrated save).
   */
  reset(e: Entity, preset: { traits?: Record<string, number> } = {}) {
    this.ensure(e);
    const c = e.components;
    const authored = this.authored.get(e);
    if (c.Traits) c.Traits.values = { ...(authored?.traits ?? {}) };
    for (const [axis, v] of Object.entries(preset.traits ?? {})) {
      if (!c.Traits) throw new Error(`entity "${e.id}" has no Traits`);
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`persist.reset: trait "${axis}" must be a number`);
      c.Traits.values[axis] = clamp(v, 0, 1);
    }
    if (c.Preferences) c.Preferences.values = structuredClone(authored?.preferences ?? {});
    if (c.Routine) {
      c.Routine.values = structuredClone(authored?.routine ?? {});
      delete c.Routine.updatedAt;
    }
    if (c.Memory) c.Memory.entries = structuredClone((authored?.memory ?? []) as typeof c.Memory.entries);
    const key = c.Persist?.key;
    if (key !== undefined) this.host.storage.remove(key);
    this.dirty.delete(e);
    this.resets++;
    // A new draw: the reset count makes it differ from the first one at the same clock time.
    const rng = new Rng(hash(`${this.host.seed}:${e.id}:${this.host.clock.now}:reset${this.resets}`));
    const drawn = generateMissing(c, rng);
    this.world.emit('individual', { entity: e.id, ...(key !== undefined && { key }), loaded: false, drawn, reset: true });
    if (key !== undefined) this.dirty.add(e);
  }

  /** End of the frame: writes what changed. */
  flush() {
    for (const e of this.dirty) {
      const key = e.components.Persist?.key;
      if (key === undefined || e.destroyed) continue;
      try {
        this.host.storage.set(key, persistedOf(e.components));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.world.console.error(`Persist of "${e.id}": ${message}`, 'persist');
        this.world.emit('persist_error', { entity: e.id, key, message });
      }
    }
    this.dirty.clear();
  }
}
