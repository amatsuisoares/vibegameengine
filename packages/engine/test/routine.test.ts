import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';

const HOUR = 3_600_000;

function game(entities: EntityInput[], opts: { scripts?: Record<string, string>; storage?: Record<string, unknown>; start?: string } = {}) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, entities } }, scripts: opts.scripts ?? {} },
    { seed: 1, storage: opts.storage, clock: { start: opts.start ?? '2026-03-10T09:00:00Z' } },
  );
}

/** A villager who works in the morning and sings in the evening (nothing pet-specific). */
const villager = (components: NonNullable<EntityInput['components']> = {}): EntityInput => ({
  id: 'npc',
  transform: { x: 50, y: 50 },
  components: { Sprite: {}, Routine: { slots: 8, halfLifeDays: 3, minEvidence: 3 }, Script: { src: 'scripts/v.js' }, ...components },
});

const live = `function onUpdate(self, game) {
  const h = Math.floor(game.clock.hour);
  if (h === game.vars.last) return;
  game.vars.last = h;
  if (h >= 9 && h < 12) self.routine.record('work');
  if (h >= 18 && h < 21) self.routine.record('sing');
  if (h === 10 && game.vars.day % 3 === 0) self.routine.record('sing'); // sometimes sings at work
}`;

/** Lives `days` days, one game hour per step. */
function liveDays(g: Game, days: number) {
  for (let d = 0; d < days; d++) {
    g.world.vars.day = d;
    for (let h = 0; h < 24; h++) {
      g.apply({ op: 'advanceClock', ms: HOUR });
      g.step(1);
    }
  }
}

describe('Routine', () => {
  it('learns what an entity does at each time of day; habit() and patterns() tell it back', () => {
    const g = game([villager()], { scripts: { 'scripts/v.js': live } });
    g.step(1);
    liveDays(g, 6);
    const e = g.entity('npc')!;
    expect(Object.keys(e.components.Routine!.values).sort()).toEqual(['sing', 'work']);
    // 09:00-12:00 is slot 3; 18:00-21:00 is slot 6.
    const w = e.components.Routine!.values;
    expect(w.work[3]).toBeGreaterThan(w.sing[3]);
    expect(w.sing[6]).toBeGreaterThan(0);
    expect(w.work[6]).toBe(0);

    const r = game([villager({ Routine: { values: e.components.Routine!.values, updatedAt: e.components.Routine!.updatedAt } })], {
      scripts: {
        'scripts/v.js': `function onStart(self, game) {
          game.vars.workAt10 = self.routine.habit('work', 10);
          game.vars.singAt19 = self.routine.habit('sing', 19);
          game.vars.workAt19 = self.routine.habit('work', 19);
          game.vars.night = self.routine.habit('work', 3);
          game.vars.peak = JSON.stringify(self.routine.peak('sing'));
          game.vars.patterns = JSON.stringify(self.routine.patterns().map((p) => [p.activity, p.from, p.to]));
        }`,
      },
    });
    r.step(1);
    expect(r.world.vars.workAt10).toBeGreaterThan(0.6);
    expect(r.world.vars.singAt19).toBe(1);
    expect(r.world.vars.workAt19).toBe(0);
    expect(r.world.vars.night).toBe(0); // nothing known at night
    expect(JSON.parse(String(r.world.vars.peak))).toMatchObject({ slot: 6, from: 18, to: 21 });
    expect(JSON.parse(String(r.world.vars.patterns))).toEqual(expect.arrayContaining([['work', 9, 12], ['sing', 18, 21]]));
  });

  it('habits fade with the half-life, so a changed routine takes over', () => {
    const g = game([villager({ Routine: { values: { work: [0, 0, 0, 8, 0, 0, 0, 0] }, updatedAt: Date.parse('2026-03-10T09:00:00Z'), halfLifeDays: 3 } })], {
      scripts: { 'scripts/v.js': `function onStart(self, game) { self.routine.record('nap'); }` },
      start: '2026-03-16T10:00:00Z', // 6 days later, in the morning slot
    });
    g.step(1);
    const w = g.entity('npc')!.components.Routine!.values;
    expect(w.work[3]).toBeCloseTo(8 * Math.pow(0.5, (6 * 24 + 1) / (3 * 24)), 2); // ~1.98
    expect(w.nap[3]).toBe(1);
  });

  it('habit() in expressions biases a UtilityAI; Persist keeps the routine across sessions', () => {
    const ai = { options: { work: { score: "0.5 + habit('work')" }, sing: { score: "0.5 + habit('sing')" } } };
    const values = { work: [0, 0, 0, 5, 0, 0, 0, 0], sing: [0, 0, 0, 0, 0, 0, 5, 0] };
    const at = (start: string) => {
      const g = game([villager({ Routine: { values }, UtilityAI: ai, Script: undefined })], { start });
      g.step(1);
      return g.getState({ ids: ['npc'] }).entities[0];
    };
    expect(at('2026-03-10T10:00:00Z').ai!.choice).toBe('work');
    expect(at('2026-03-10T19:00:00Z').ai!.choice).toBe('sing');
    expect(at('2026-03-10T19:00:00Z').habits).toEqual({ sing: 1 });

    const first = game([villager({ Persist: { key: 'v' } })], { scripts: { 'scripts/v.js': "function onStart(self) { self.routine.record('work', 2); }" } });
    first.step(1);
    expect((first.storage.get('v') as { routine: { values: Record<string, number[]> } }).routine.values.work[3]).toBe(2);
    const next = game([villager({ Persist: { key: 'v' }, Script: undefined })], { storage: first.storage.snapshot() });
    next.step(1);
    expect(next.entity('npc')!.components.Routine!.values.work[3]).toBe(2);
  });
});
