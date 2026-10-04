import type { EntityInput } from '@vibe/shared';
import { parseProject } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { evaluateExpr } from '../src/expr';

const MIN = 60_000;

function game(entities: EntityInput[], storage?: Record<string, unknown>) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, entities } }, scripts: { 'scripts/o.js': '' } },
    { seed: 1, storage, clock: { start: '2026-03-10T09:00:00Z' } },
  );
}

/** A customer at a café who wants things (nothing pet-specific). */
const customer = (desires: Record<string, unknown> = {}, components: NonNullable<EntityInput['components']> = {}): EntityInput => ({
  id: 'customer',
  transform: { x: 50, y: 50 },
  components: { Sprite: {}, Desires: { max: 1, minGapMinutes: 10, maxPerDay: 3, ...desires }, Script: { src: 'scripts/o.js' }, ...components },
});

type Des = { start: Function; blocked: Function; fulfill: Function; cancel: Function; get: Function; list: Function };
type Api = { scriptRunner: { api: { entity(e: unknown): { desires: Des; persist: { reset(): void } }; game: { emit(t: string, d?: unknown): void } } } };
const api = (g: Game) => (g as unknown as Api).scriptRunner.api;
const des = (g: Game) => api(g).entity(g.entity('customer')).desires;

describe('Desires', () => {
  it('starts with a duration, blocks by max / gap / day, expires on the game clock', () => {
    const g = game([customer()]);
    g.step(1);
    const d = des(g);
    const tea = d.start({ kind: 'drink', subject: 'tea', minutes: 20, data: { icon: '🍵' } });
    expect(tea).toMatchObject({ id: 'd1', kind: 'drink', subject: 'tea', minutesLeft: 20, data: { icon: '🍵' } });
    expect(d.blocked()).toBe('max');
    expect(d.start({ kind: 'cake', minutes: 5 })).toBeNull();
    expect(evaluateExpr("wants('customer', 'drink')", { game: g }).value).toBe('tea');
    expect(evaluateExpr("wants('customer', 'cake')", { game: g }).value).toBe(false);
    expect(g.getState({ ids: ['customer'] }).entities[0].desires).toEqual([{ id: 'd1', kind: 'drink', subject: 'tea', minutesLeft: 20 }]);
    g.apply({ op: 'advanceClock', ms: 21 * MIN });
    g.step(1);
    expect(d.list()).toEqual([]);
    expect(g.events(0, 'desire_expired')).toMatchObject([{ entity: 'customer', id: 'd1', kind: 'drink', subject: 'tea' }]);
    // The gap counts from the end: right after it, a new one waits; force skips the wait.
    expect(d.blocked()).toBe('gap');
    expect(d.start({ kind: 'cake', minutes: 5 })).toBeNull();
    expect(d.start({ kind: 'cake', minutes: 5, force: true })).toMatchObject({ id: 'd2' });
    d.cancel('cake');
    g.apply({ op: 'advanceClock', ms: 11 * MIN });
    expect(d.start({ kind: 'cake', minutes: 5 })).toMatchObject({ id: 'd3' });
    d.cancel('d3');
    expect(g.events(0, 'desire_cancelled').map((e) => e.id)).toEqual(['d2', 'd3']);
    // Three a day at most.
    g.apply({ op: 'advanceClock', ms: 11 * MIN });
    expect(d.blocked()).toBe('day');
    g.apply({ op: 'advanceClock', ms: 24 * 60 * MIN });
    expect(d.blocked()).toBe(null);
    expect(() => d.start({ kind: 'x', minutes: 0 })).toThrow(/minutes must be a number > 0/);
  });

  it('a matching event fulfills it in the same frame ($self, array fields such as tags); scripts can fulfill it too', () => {
    const g = game([customer({ minGapMinutes: 0 })]);
    g.step(1);
    const d = des(g);
    d.start({ kind: 'snack', subject: 'sweet', minutes: 30, fulfillOn: { event: 'served', match: { to: '$self', tags: 'sweet' } } });
    const emit = (data: Record<string, unknown>) => api(g).game.emit('served', data);
    emit({ to: 'other', tags: ['sweet'] }); // someone else
    emit({ to: 'customer', tags: ['salty'] }); // not what it wants
    g.step(1);
    expect(d.list()).toHaveLength(1);
    emit({ to: 'customer', item: 'cookie', tags: ['sweet', 'crunchy'] });
    g.step(1);
    expect(d.list()).toEqual([]);
    const done = g.events(0, 'desire_fulfilled')[0];
    expect(done).toMatchObject({ entity: 'customer', kind: 'snack', subject: 'sweet', by: 'served', trigger: { type: 'served', item: 'cookie' } });
    // Scripts end it themselves when the game decides (by kind or id).
    d.start({ kind: 'company', minutes: 30 });
    expect(d.fulfill('company', { how: 'chat' })).toMatchObject({ kind: 'company' });
    expect(g.events(0, 'desire_fulfilled')[1]).toMatchObject({ kind: 'company', by: 'script', with: { how: 'chat' } });
    expect(d.fulfill('company')).toBeNull();
  });

  it('minRealSeconds: a fast clock does not take the desire away before the player could see it; nor does it rain desires', () => {
    const g = game([customer({ minGapMinutes: 0, minGapRealSeconds: 30, maxPerDay: 0 })]);
    g.step(1);
    const d = des(g);
    d.start({ kind: 'drink', minutes: 10, minRealSeconds: 5 });
    g.apply({ op: 'advanceClock', ms: 60 * MIN }); // the clock flew
    g.step(60);
    expect(d.list()).toHaveLength(1); // 1 s real: still there
    g.step(4 * 60 + 1);
    expect(d.list()).toEqual([]);
    expect(d.blocked()).toBe('gap'); // 30 real seconds since it ended
    g.step(30 * 60);
    expect(d.blocked()).toBe(null);
  });

  it('Persist keeps the desires (and the day count) across sessions; on return an overdue desire expires', () => {
    const g = game([customer({}, { Persist: { key: 'c' } })]);
    g.step(1);
    des(g).start({ kind: 'drink', subject: 'tea', minutes: 30 });
    g.step(1);
    const again = game([customer({}, { Persist: { key: 'c' } })], g.storage.snapshot());
    again.step(1);
    expect(des(again).list()).toMatchObject([{ id: 'd1', subject: 'tea' }]);
    expect(des(again).blocked()).toBe('max');
    const later = game([customer({}, { Persist: { key: 'c' } })], again.storage.snapshot());
    later.apply({ op: 'advanceClock', ms: 40 * MIN });
    later.step(1);
    expect(des(later).list()).toEqual([]);
    expect(later.events(0, 'desire_expired')).toHaveLength(1);
    api(later).entity(later.entity('customer')).persist.reset();
    expect(des(later).list()).toEqual([]);
  });

  const errorsOf = (raw: unknown) => { const r = parseProject(raw); return r.ok ? [] : r.errors; };

  it('validation: max at least 1; Persist with only Desires has something to keep', () => {
    const project = (d: Record<string, unknown>) => ({
      config: { name: 't', startScene: 'main' },
      scenes: { main: { id: 'main', entities: [{ id: 'k', components: { Desires: d, Persist: { key: 'k' } } }] } },
    });
    expect(errorsOf(project({ max: 0 })).join('\n')).toMatch(/max/);
    expect(errorsOf(project({}))).toEqual([]);
  });
});
