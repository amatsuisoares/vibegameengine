import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { evaluateExpr } from '../src/expr';

const HOUR = 3_600_000;

function game(entities: EntityInput[], opts: { scripts?: Record<string, string>; storage?: Record<string, unknown> } = {}) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, entities } }, scripts: opts.scripts ?? {} },
    { seed: 1, storage: opts.storage, clock: { start: '2026-03-10T09:00:00Z' } },
  );
}

/** A fox that remembers who fed it and what scared it (nothing pet-specific). */
const fox = (components: NonNullable<EntityInput['components']> = {}): EntityInput => ({
  id: 'fox',
  transform: { x: 50, y: 50 },
  components: { Sprite: {}, Memory: { capacity: 5, halfLifeHours: 10, halfLives: { scared: 2 } }, Script: { src: 'scripts/f.js' }, ...components },
});

const api = `function onStart(self, game) { game.vars.ok = true; }`;
type Mem = { remember: Function; recall: Function; feeling: Function; forget: Function };
/** The fox's self.memory, as its script sees it. */
const mem = (g: Game) => (g as unknown as { scriptRunner: { api: { entity(e: unknown): { memory: Mem } } } }).scriptRunner.api.entity(g.entity('fox')).memory;
const after = (g: Game, hours: number) => {
  g.apply({ op: 'advanceClock', ms: hours * HOUR });
  g.step(1);
};

describe('Memory', () => {
  it('remembers experiences; strength fades with game-clock age (per-type half-life); feeling sums valence × strength', () => {
    const g = game([fox()], { scripts: { 'scripts/f.js': api } });
    g.step(1);
    const m = mem(g);
    expect(m.remember('fed', { subject: 'hunter', valence: 1, importance: 0.8, tags: ['food'] })).toMatchObject({ type: 'fed', subject: 'hunter', strength: 0.8, count: 1 });
    m.remember('scared', { subject: 'dog', valence: -1, importance: 0.9 });
    expect(m.feeling('hunter')).toBe(0.8);
    expect(m.feeling('dog')).toBe(-0.9);
    after(g, 2); // scared: half-life 2 h; fed: 10 h
    expect(m.feeling('dog')).toBeCloseTo(-0.45, 2);
    expect(m.feeling('hunter')).toBeCloseTo(0.8 * Math.pow(0.5, 0.2), 2);
    expect(m.recall().map((x: { type: string }) => x.type)).toEqual(['fed', 'scared']); // strongest first
    expect(m.recall({ tag: 'food' })).toHaveLength(1);
    expect(m.feeling('nobody')).toBe(0);
    expect(g.events(0, 'memory').map((e) => e.memory)).toEqual(['fed', 'scared']);
  });

  it('living it again reinforces the same memory (stronger, valence moves toward the new one) instead of adding another', () => {
    const g = game([fox()], { scripts: { 'scripts/f.js': api } });
    g.step(1);
    const m = mem(g);
    m.remember('ate', { subject: 'berry', valence: 0.4, importance: 0.4 });
    const again = m.remember('ate', { subject: 'berry', valence: 1, importance: 0.4 });
    expect(again).toMatchObject({ count: 2, strength: 0.5 }); // max(0.4, 0.4) + 0.4 / 4
    expect(again.valence).toBeCloseTo(0.7, 2);
    expect(g.entity('fox')!.components.Memory!.entries).toHaveLength(1);
    expect(g.events(0, 'memory').at(-1)).toMatchObject({ reinforced: true, count: 2 });
  });

  it('forgets weak memories and the weakest past the capacity (memory_forgotten); forget() drops on demand', () => {
    const g = game([fox()], { scripts: { 'scripts/f.js': api } });
    g.step(1);
    const m = mem(g);
    m.remember('scared', { subject: 'dog', valence: -1, importance: 0.5 });
    after(g, 12); // 0.5 × ½^6 < 0.05
    expect(m.recall({ type: 'scared' })).toEqual([]);
    expect(g.events(0, 'memory_forgotten')).toEqual([expect.objectContaining({ entity: 'fox', memory: 'scared', subject: 'dog' })]);
    for (let i = 0; i < 6; i++) m.remember('saw', { subject: `bird${i}`, importance: 0.2 + i * 0.1 });
    expect(g.entity('fox')!.components.Memory!.entries).toHaveLength(5);
    expect(m.recall({ subject: 'bird0' })).toEqual([]); // the weakest went first
    expect(m.forget({ type: 'saw' })).toBe(5);
    expect(() => m.remember('', {})).toThrow(/type must be a non-empty string/);
  });

  it('memory() in expressions, the snapshot shows the strongest, and Persist keeps memories across sessions', () => {
    const g = game([fox({ Persist: { key: 'fox' } })], { scripts: { 'scripts/f.js': api } });
    g.step(1);
    mem(g).remember('fed', { subject: 'hunter', valence: 1, importance: 0.6 });
    g.step(1);
    expect(evaluateExpr("memory('fox', 'hunter', 'fed')", { game: g }).value).toBe(0.6);
    expect(g.getState({ ids: ['fox'] }).entities[0].memories).toEqual([{ type: 'fed', subject: 'hunter', valence: 1, strength: 0.6, count: 1 }]);
    const again = game([fox({ Persist: { key: 'fox' } })], { scripts: { 'scripts/f.js': 'function onStart(self, game) { game.vars.f = self.memory.feeling("hunter"); }' }, storage: g.storage.snapshot() });
    again.step(1);
    expect(again.world.vars.f).toBe(0.6);
  });
});
