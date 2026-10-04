import type { EntityInput } from '@vibe/shared';
import { parseProject } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { evaluateExpr } from '../src/expr';

const HOUR = 3_600_000;

function game(entities: EntityInput[], storage?: Record<string, unknown>) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, entities } }, scripts: { 'scripts/o.js': '' } },
    { seed: 1, storage, clock: { start: '2026-03-10T09:00:00Z' } },
  );
}

/** A shopkeeper who warms up to the player (nothing pet-specific). */
const keeper = (components: NonNullable<EntityInput['components']> = {}): EntityInput => ({
  id: 'keeper',
  transform: { x: 50, y: 50 },
  components: { Sprite: {}, Relationship: { initial: 0.2, levels: [0.4, 0.7], halfLifeHours: 10, keep: 0.5, dailyCaps: { chat: 0.05 } }, Script: { src: 'scripts/o.js' }, ...components },
});

type Rel = { add: Function; get: Function; level: Function; list: Function };
const rel = (g: Game) => (g as unknown as { scriptRunner: { api: { entity(e: unknown): { relationship: Rel } } } }).scriptRunner.api.entity(g.entity('keeper')).relationship;

describe('Relationship', () => {
  it('gains shrink near the top, a reason is capped per day, losses are not; crossing a threshold is an event', () => {
    const g = game([keeper()]);
    g.step(1);
    const r = rel(g);
    expect(r.get('player')).toBe(0.2); // never met: initial
    expect(r.add('player', 0.5, { reason: 'gift' })).toMatchObject({ value: 0.6, delta: 0.4, level: 1, from: 0 }); // 0.5 × (1 − 0.2)
    expect(r.add('player', 0.5, { reason: 'gift' })).toMatchObject({ value: 0.8, delta: 0.2, level: 2, from: 1 }); // 0.5 × (1 − 0.6): harder near the top
    // Chatting all day adds at most its cap.
    let chat = 0;
    for (let i = 0; i < 20; i++) chat += r.add('player', 0.1, { reason: 'chat' }).delta;
    expect(chat).toBeCloseTo(0.05, 4);
    g.apply({ op: 'advanceClock', ms: 24 * HOUR });
    expect(r.add('player', 0.1, { reason: 'chat' }).delta).toBeGreaterThan(0); // a new day
    expect(r.add('player', -0.5).value).toBeLessThan(0.4);
    expect(g.events(0, 'relationship_level').map((e) => [e.from, e.level])).toEqual([[0, 1], [1, 2], [1, 0]]); // a day later it had already faded below the top level
    expect(() => r.add('', 1)).toThrow(/subject must be a non-empty string/);
  });

  it('without contact it fades toward keep × the best it was, never below; bond() and the snapshot read it', () => {
    const g = game([keeper()]);
    g.step(1);
    const r = rel(g);
    r.add('player', 1); // 0.2 → 1
    expect(r.get('player')).toBe(1);
    g.apply({ op: 'advanceClock', ms: 10 * HOUR }); // one half-life: floor 0.5 + (1 − 0.5) / 2
    expect(r.get('player')).toBeCloseTo(0.75, 3);
    g.apply({ op: 'advanceClock', ms: 30 * 24 * HOUR });
    expect(r.get('player')).toBeCloseTo(0.5, 3); // a month away: still half the best
    expect(r.level('player')).toBe(1);
    expect(evaluateExpr("bond('keeper', 'player')", { game: g }).value).toBeCloseTo(0.5, 3);
    expect(evaluateExpr("bond('keeper', 'stranger')", { game: g }).value).toBe(0.2);
    expect(g.getState({ ids: ['keeper'] }).entities[0].bonds).toEqual({ player: { value: 0.5, level: 1 } });
    expect(r.list()).toMatchObject([{ subject: 'player', value: 0.5, peak: 1 }]);
  });

  it('Persist keeps the bonds (and today\'s caps) across sessions; a reset forgets them', () => {
    const g = game([keeper({ Persist: { key: 'keeper' } })]);
    g.step(1);
    rel(g).add('player', 0.3, { reason: 'chat' }); // capped at 0.05
    g.step(1);
    const again = game([keeper({ Persist: { key: 'keeper' } })], g.storage.snapshot());
    again.step(1);
    expect(rel(again).get('player')).toBeCloseTo(0.25, 4);
    expect(rel(again).add('player', 0.3, { reason: 'chat' }).delta).toBe(0); // the cap of today came along
    (again as unknown as { scriptRunner: { api: { entity(e: unknown): { persist: { reset(): void } } } } }).scriptRunner.api.entity(again.entity('keeper')).persist.reset();
    expect(rel(again).get('player')).toBe(0.2);
  });

  const errorsOf = (raw: unknown) => { const r = parseProject(raw); return r.ok ? [] : r.errors; };

  it('validation: levels must be ascending; Persist with only a Relationship has something to keep', () => {
    const project = (rel: Record<string, unknown>) => ({
      config: { name: 't', startScene: 'main' },
      scenes: { main: { id: 'main', entities: [{ id: 'k', components: { Relationship: rel, Persist: { key: 'k' } } }] } },
    });
    expect(errorsOf(project({ levels: [0.5, 0.2] })).join('\n')).toMatch(/levels must be ascending/);
    expect(errorsOf(project({}))).toEqual([]);
  });
});
