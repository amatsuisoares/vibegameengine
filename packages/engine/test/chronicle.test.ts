import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { evaluateExpr } from '../src/expr';

function game(entities: EntityInput[], storage?: Record<string, unknown>) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, entities } }, scripts: { 'scripts/o.js': '' } },
    { seed: 1, storage, clock: { start: '2026-03-10T09:00:00Z' } },
  );
}

/** An owl the player gets to know (nothing pet-specific). */
const owl = (components: NonNullable<EntityInput['components']> = {}): EntityInput => ({
  id: 'owl',
  transform: { x: 50, y: 50 },
  components: { Sprite: {}, Knowledge: { possible: 1, observed: 3, confirmed: 5 }, Journal: { capacity: 3 }, Script: { src: 'scripts/o.js' }, ...components },
});

type Api = { knowledge: { observe: Function; level: Function; list: Function }; journal: { add: Function; entries: Function; has: Function; remove: Function } };
const api = (g: Game) => (g as unknown as { scriptRunner: { api: { entity(e: unknown): Api } } }).scriptRunner.api.entity(g.entity('owl'));

describe('Knowledge', () => {
  it('evidence grows into possible / observed / confirmed, each level gained is a discovery; negative weight takes it back', () => {
    const g = game([owl()]);
    g.step(1);
    const k = api(g).knowledge;
    expect(k.level('likes:mice')).toBe('unknown');
    expect(k.observe('likes:mice')).toMatchObject({ level: 'possible', discovered: true, from: 'unknown' });
    k.observe('likes:mice', 1);
    expect(k.observe('likes:mice')).toMatchObject({ level: 'observed', evidence: 3, discovered: true });
    expect(k.observe('likes:mice', 1.5)).toMatchObject({ level: 'observed', discovered: false });
    expect(k.observe('likes:mice', 1)).toMatchObject({ level: 'confirmed' });
    k.observe('night:owl', 0.5);
    expect(k.list().map((x: { key: string }) => x.key)).toEqual(['likes:mice']); // below "possible": not known yet
    expect(k.list({ prefix: 'night', minLevel: 'unknown' })).toEqual([]);
    expect(k.observe('likes:mice', -10)).toMatchObject({ level: 'unknown', evidence: 0 });
    expect(g.events(0, 'discovery').map((e) => e.level)).toEqual(['possible', 'observed', 'confirmed']);
    expect(() => k.observe('')).toThrow(/key must be a non-empty string/);
  });

  it('knows() in expressions and the snapshot show the levels; Persist keeps them', () => {
    const g = game([owl({ Persist: { key: 'owl' } })]);
    g.step(1);
    api(g).knowledge.observe('shy', 3);
    g.step(1);
    expect(evaluateExpr("knows('owl', 'shy')", { game: g }).value).toBe(2);
    expect(g.getState({ ids: ['owl'] }).entities[0].knowledge).toEqual({ shy: 'observed' });
    const again = game([owl({ Persist: { key: 'owl' } })], g.storage.snapshot());
    again.step(1);
    expect(api(again).knowledge.level('shy')).toBe('observed');
  });
});

describe('Journal', () => {
  it('adds entries newest first; a key is written once (unless replace); past the capacity the least important goes', () => {
    const g = game([owl({ Persist: { key: 'owl' } })]);
    g.step(1);
    const j = api(g).journal;
    expect(j.add('firsts', 'Caught its first mouse.', { key: 'first:mouse', importance: 0.9 })).toMatchObject({ category: 'firsts', importance: 0.9 });
    expect(j.add('firsts', 'Caught a mouse again.', { key: 'first:mouse' })).toBeNull();
    g.apply({ op: 'advanceClock', ms: 60_000 });
    j.add('days', 'Slept all day.', { importance: 0.2 });
    g.apply({ op: 'advanceClock', ms: 60_000 });
    j.add('days', 'Hooted at the moon.', { importance: 0.4 });
    g.apply({ op: 'advanceClock', ms: 60_000 });
    j.add('days', 'Met a cat.', { importance: 0.6 });
    expect(j.entries().map((x: { text: string }) => x.text)).toEqual(['Met a cat.', 'Hooted at the moon.', 'Caught its first mouse.']);
    expect(j.entries({ category: 'firsts' })).toHaveLength(1);
    j.add('firsts', 'Caught its first BIG mouse.', { key: 'first:mouse', replace: true, importance: 1 });
    expect(j.entries({ limit: 1 })[0].text).toBe('Caught its first BIG mouse.');
    expect(j.has('first:mouse')).toBe(true);
    g.step(1);
    expect(g.getState({ ids: ['owl'] }).entities[0].journal).toEqual({ count: 3, last: ['Caught its first BIG mouse.', 'Met a cat.', 'Hooted at the moon.'] });
    expect(g.events(0, 'journal').map((e) => e.category)).toEqual(['firsts', 'days', 'days', 'days', 'firsts']);
    const again = game([owl({ Persist: { key: 'owl' } })], g.storage.snapshot());
    again.step(1);
    expect(api(again).journal.entries()).toHaveLength(3);
    expect(api(again).journal.remove('first:mouse')).toBe(true);
  });
});
