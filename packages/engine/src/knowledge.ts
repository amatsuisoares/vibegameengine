import type { Components } from '@vibe/shared';
import type { Entity } from './entity';

/**
 * Knowledge: what the PLAYER knows about an entity (not what the entity knows). The game reports
 * evidence for keys it chooses ("likes:apple", "trait:curious:high") each time the player could have
 * seen it; evidence grows into levels — possible → observed → confirmed — at the component's
 * thresholds, and each level gained is a "discovery" event. A diary built on it never reveals a
 * preference or a trait the player has not had a chance to see.
 *
 *   observe(key, weight = 1) -> {key, level, evidence, discovered}   (negative weight takes evidence back)
 *   level(key)               -> 'unknown' | 'possible' | 'observed' | 'confirmed'
 *   list({prefix, minLevel}) -> known keys, most evidence first
 */

type KnowledgeData = NonNullable<Components['Knowledge']>;

export const KNOWLEDGE_LEVELS = ['unknown', 'possible', 'observed', 'confirmed'] as const;
export type KnowledgeLevel = (typeof KNOWLEDGE_LEVELS)[number];

export interface KnowledgeView {
  key: string;
  level: KnowledgeLevel;
  evidence: number;
  /** Game clock (ms) of the first and the last evidence. */
  first: number;
  last: number;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

function knowledgeOf(e: Entity): KnowledgeData {
  const k = e.components.Knowledge;
  if (!k) throw new Error(`entity "${e.id}" has no Knowledge`);
  return k;
}

export function levelIndex(k: KnowledgeData, evidence: number): number {
  return evidence >= k.confirmed ? 3 : evidence >= k.observed ? 2 : evidence >= k.possible ? 1 : 0;
}

export function knowledgeLevel(e: Entity, key: string): KnowledgeLevel {
  const k = knowledgeOf(e);
  return KNOWLEDGE_LEVELS[levelIndex(k, k.values[key]?.evidence ?? 0)];
}

export function observeKnowledge(e: Entity, now: number, key: string, weight = 1): KnowledgeView & { discovered: boolean; from: KnowledgeLevel } {
  if (typeof key !== 'string' || !key) throw new Error('knowledge.observe: key must be a non-empty string');
  if (!Number.isFinite(weight)) throw new Error('knowledge.observe: weight must be a number');
  const k = knowledgeOf(e);
  const v = k.values[key] ?? { evidence: 0, first: now, last: now };
  const before = levelIndex(k, v.evidence);
  v.evidence = round3(Math.max(0, v.evidence + weight));
  v.last = now;
  k.values[key] = v;
  const after = levelIndex(k, v.evidence);
  return { key, level: KNOWLEDGE_LEVELS[after], evidence: v.evidence, first: v.first, last: v.last, discovered: after > before, from: KNOWLEDGE_LEVELS[before] };
}

export function listKnowledge(e: Entity, q: { prefix?: string; minLevel?: KnowledgeLevel } = {}): KnowledgeView[] {
  const k = knowledgeOf(e);
  const min = Math.max(1, KNOWLEDGE_LEVELS.indexOf(q.minLevel ?? 'possible'));
  const out: KnowledgeView[] = [];
  for (const [key, v] of Object.entries(k.values)) {
    if (q.prefix !== undefined && !key.startsWith(q.prefix)) continue;
    const i = levelIndex(k, v.evidence);
    if (i >= min) out.push({ key, level: KNOWLEDGE_LEVELS[i], evidence: v.evidence, first: v.first, last: v.last });
  }
  return out.sort((a, b) => b.evidence - a.evidence || a.first - b.first);
}
