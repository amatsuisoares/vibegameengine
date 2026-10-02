import type { EntityInput, SceneInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { evaluate, Game, learn, preferenceLevel } from '../src';

type C = NonNullable<EntityInput['components']>;

const CLOCK = { start: '2026-03-10T10:00:00Z' };

/** A villager NPC (nothing pet-specific): personality, tastes, kept under storage "villager". */
function villager(components: C = {}, id = 'npc'): EntityInput {
  return {
    id,
    transform: { x: 100, y: 100 },
    components: {
      Sprite: {},
      Traits: { generate: { bravery: {}, greed: { min: 0.2, max: 0.4 } }, values: { honesty: 0.9 } },
      Preferences: {
        values: { gold: { innate: 0.8 } },
        generate: { danger: { min: -0.2, max: 0.2, traits: { bravery: 1 } }, fish: {}, spicy: {} },
      },
      ...components,
    },
  };
}

function game(
  entities: EntityInput[],
  opts: { seed?: number; storage?: Record<string, unknown>; scripts?: Record<string, string>; scenes?: SceneInput[]; clock?: { start: string } } = {},
) {
  const scenes: Record<string, SceneInput> = { main: { id: 'main', width: 400, height: 300, entities } };
  for (const s of opts.scenes ?? []) scenes[s.id] = s;
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes, scripts: opts.scripts ?? {} },
    { seed: opts.seed ?? 1, storage: opts.storage, clock: opts.clock ?? CLOCK },
  );
}

const snap = (g: Game, id = 'npc') => g.getState({ ids: [id] }).entities[0];

describe('Traits', () => {
  it('draws missing axes within their ranges before the first onStart, keeps authored ones, and shows them in the snapshot', () => {
    const seen: Record<string, number>[] = [];
    const g = game([villager({ Script: { src: 'scripts/v.js' } })], { scripts: { 'scripts/v.js': 'function onStart(self) { console.log(JSON.stringify(self.traits.all())); }' } });
    g.step(1);
    const t = snap(g).traits!;
    expect(t.honesty).toBe(0.9);
    expect(t.bravery).toBeGreaterThanOrEqual(0);
    expect(t.bravery).toBeLessThanOrEqual(1);
    expect(t.greed).toBeGreaterThanOrEqual(0.2);
    expect(t.greed).toBeLessThanOrEqual(0.4);
    seen.push(t);
    expect(g.console.read(0).some((l) => l.message.includes(`"bravery":${t.bravery}`))).toBe(true); // onStart already saw them
    expect(g.events(0, 'individual')[0]).toMatchObject({ entity: 'npc', loaded: false, drawn: ['bravery', 'greed', 'danger', 'fish', 'spicy'] });
  });

  it('is reproducible for the same seed and clock, differs with another seed or a later birth, and never shifts the game RNG', () => {
    const traitsOf = (seed: number, clock = CLOCK) => {
      const g = game([villager()], { seed, clock });
      g.step(1);
      return snap(g).traits;
    };
    expect(traitsOf(1)).toEqual(traitsOf(1));
    expect(traitsOf(1)).not.toEqual(traitsOf(2));
    expect(traitsOf(1)).not.toEqual(traitsOf(1, { start: '2026-03-11T10:00:00Z' }));

    const rolls = (entities: EntityInput[]) => {
      const g = game([...entities, { id: 'dice', transform: { x: 0, y: 0 }, components: { Script: { src: 'scripts/d.js' } } }], {
        scripts: { 'scripts/d.js': 'function onStart(self, game) { game.vars.roll = game.random(); }' },
      });
      g.step(1);
      return g.world.vars.roll;
    };
    expect(rolls([villager()])).toBe(rolls([]));
  });

  it('scripts read and set traits; unknown axes are errors, not "average"', () => {
    const g = game([villager({ Script: { src: 'scripts/v.js' } })], {
      scripts: {
        'scripts/v.js': `function onStart(self, game) {
          self.traits.set('bravery', 1.7);
          game.vars.b = self.traits.get('bravery');
          game.vars.has = self.traits.has('nope');
          self.traits.get('nope');
        }`,
      },
    });
    g.step(1);
    expect(g.world.vars).toMatchObject({ b: 1, has: false });
    expect(g.console.read(0, 'error')[0].message).toMatch(/no trait "nope" \(traits: .*bravery/);
  });
});

describe('Preferences', () => {
  it('draws innate affinities with trait influence and clamps them', () => {
    const brave = game([villager({ Traits: { values: { bravery: 1, greed: 0.3 } } })]);
    const coward = game([villager({ Traits: { values: { bravery: 0, greed: 0.3 } } })]);
    brave.step(1);
    coward.step(1);
    expect(snap(brave).prefs!.danger).toBeGreaterThanOrEqual(0.8); // [-0.2, 0.2] + 1 × (1 - 0.5) × 2
    expect(snap(coward).prefs!.danger).toBeLessThanOrEqual(-0.8);
    expect(snap(brave).prefs!.gold).toBe(0.8); // authored
  });

  it('evaluates a subject with its tags: weighted, either side alone, unknown = neutral', () => {
    const g = game([
      villager({
        Preferences: { values: { apple: { innate: -0.5 }, fruit: { innate: 1 }, sweet: { innate: 0.5 } }, subjectWeight: 0.6 },
      }),
    ]);
    g.step(1);
    const e = g.entity('npc')!;
    expect(evaluate(e, 'apple', ['fruit', 'sweet'])).toEqual({
      score: 0, // 0.6 × -0.5 + 0.4 × 0.75
      level: 'neutral',
      known: true,
      parts: { apple: -0.5, fruit: 1, sweet: 0.5 },
    });
    expect(evaluate(e, 'pear', ['fruit', 'crunchy'])).toMatchObject({ score: 1, level: 'love', known: true, parts: { fruit: 1 } });
    expect(evaluate(e, 'apple')).toMatchObject({ score: -0.5, level: 'dislike' });
    expect(evaluate(e, 'rock', ['hard'])).toEqual({ score: 0, level: 'neutral', known: false, parts: {} });
    expect([0.6, 0.2, 0.19, -0.19, -0.2, -0.6, -0.61].map(preferenceLevel)).toEqual(['love', 'like', 'neutral', 'neutral', 'dislike', 'hate', 'hate']);
  });

  it('learns slowly and within bounds: one experience nudges, many shift, none rewrites', () => {
    const g = game([villager({ Preferences: { values: { milk: { innate: -0.4 } }, learnRate: 0.05, maxLearned: 0.5 } })]);
    g.step(1);
    const e = g.entity('npc')!;
    expect(learn(e, 'milk', 1)).toBe(-0.35);
    for (let i = 0; i < 100; i++) learn(e, 'milk', 1);
    expect(e.components.Preferences!.values.milk).toEqual({ innate: -0.4, learned: 0.5, n: 101 });
    expect(learn(e, 'jazz', -1)).toBe(-0.05); // new subject: starts neutral
  });

  it('scripts evaluate and learn; expressions read trait() and likes() (self or another entity)', () => {
    const g = game(
      [
        villager({
          Traits: { values: { bravery: 0.8, greed: 0.3 } },
          Preferences: { values: { gold: { innate: 0.8 }, danger: { innate: -0.3 }, fish: { innate: 0 }, spicy: { innate: 0 } } },
          Script: { src: 'scripts/v.js' },
          UtilityAI: { options: { hoard: { score: "likes('gold') * trait('greed')" }, fight: { score: "trait('bravery') + likes('danger')" } } },
        }),
        { id: 'judge', transform: { x: 0, y: 0 }, components: { UtilityAI: { options: { trust: { score: "trait('npc', 'bravery')" } } } } },
      ],
      { scripts: { 'scripts/v.js': "function onStart(self, game) { const r = self.prefs.evaluate('gold', ['shiny']); game.vars.level = r.level; game.vars.after = self.prefs.learn('danger', -1); }" } },
    );
    g.step(1);
    expect(g.world.vars).toMatchObject({ level: 'love', after: -0.35 });
    expect(snap(g).ai!.scores).toEqual({ hoard: 0.24, fight: 0.45 });
    expect(snap(g, 'judge').ai!.scores).toEqual({ trust: 0.8 });
  });
});

describe('Persist', () => {
  it('saves the individual, and a later session (any seed) gets the same one back', () => {
    const first = game([villager({ Persist: { key: 'villager' } })], { seed: 7 });
    first.step(1);
    const saved = first.storage.get('villager') as { version: number; traits: Record<string, number>; preferences: Record<string, unknown> };
    expect(saved.version).toBe(1);
    expect(saved.traits).toEqual(snap(first).traits);
    expect(Object.keys(saved.preferences).sort()).toEqual(['danger', 'fish', 'gold', 'spicy']);

    const later = game([villager({ Persist: { key: 'villager' } })], { seed: 99, storage: first.storage.snapshot() });
    later.step(1);
    expect(snap(later).traits).toEqual(snap(first).traits);
    expect(snap(later).prefs).toEqual(snap(first).prefs);
    expect(later.events(0, 'individual')[0]).toMatchObject({ key: 'villager', loaded: true, drawn: [] });
  });

  it('saves learned changes at the end of the frame, survives scene changes, and draws only what a newer game version added', () => {
    const scripts = { 'scripts/v.js': "function onClick(self) { self.prefs.learn('fish', 1); self.traits.set('greed', 0.9); }" };
    const v = villager({ Persist: { key: 'villager' }, Script: { src: 'scripts/v.js' }, Collider: { width: 40, height: 40 } });
    const g = game([v], { scripts, scenes: [{ id: 'town', entities: [villager({ Persist: { key: 'villager' } })] }] });
    g.step(1);
    const fishBefore = snap(g).prefs!.fish;
    g.perform([{ type: 'click', entity: 'npc' }, { type: 'wait', ms: 50 }]);
    const saved = g.storage.get('villager') as { traits: Record<string, number>; preferences: Record<string, { learned: number; n: number }> };
    expect(saved.traits.greed).toBe(0.9);
    expect(saved.preferences.fish).toMatchObject({ learned: 0.05, n: 1 });
    g.apply({ op: 'loadScene', scene: 'town' });
    g.step(1);
    expect(snap(g).traits!.greed).toBe(0.9);
    expect(snap(g).prefs!.fish).toBe(Math.round((fishBefore + 0.05) * 1000) / 1000);

    // A newer version of the game adds an axis and a subject: only those are drawn; the rest is kept.
    const newer = villager({ Persist: { key: 'villager' }, Traits: { generate: { bravery: {}, greed: {}, curiosity: {} }, values: { honesty: 0.9 } } });
    newer.components!.Preferences!.generate!.music = {};
    const next = game([newer], { storage: g.storage.snapshot() });
    next.step(1);
    expect(next.events(0, 'individual')[0]).toMatchObject({ loaded: true, drawn: ['curiosity', 'music'] });
    expect(snap(next).traits!.greed).toBe(0.9);
    expect(Object.keys((next.storage.get('villager') as { traits: object }).traits)).toContain('curiosity');
  });

  it('reset forgets the individual: a new one is drawn and saved', () => {
    const g = game([villager({ Persist: { key: 'villager' }, Script: { src: 'scripts/v.js' }, Collider: { width: 40, height: 40 } })], {
      scripts: { 'scripts/v.js': "function onClick(self) { self.persist.reset(); }" },
    });
    g.step(1);
    const before = snap(g).traits!;
    g.perform([{ type: 'click', entity: 'npc' }, { type: 'wait', ms: 50 }]);
    const after = snap(g).traits!;
    expect(after.honesty).toBe(0.9); // authored stays
    expect(after.bravery).not.toBe(before.bravery);
    expect((g.storage.get('villager') as { traits: object }).traits).toEqual(after);
    expect(g.events(0, 'individual').at(-1)).toMatchObject({ reset: true });
  });

  it('save slots bring the individual back as it was', () => {
    const g = game([villager({ Persist: { key: 'villager' }, Script: { src: 'scripts/v.js' }, Collider: { width: 40, height: 40 } })], {
      scripts: { 'scripts/v.js': "function onStart(self, game) { game.saveSlot('a'); } function onClick(self, game) { self.traits.set('bravery', 0); self.persist.save(); game.loadSlot('a'); }" },
    });
    g.step(2);
    const before = snap(g).traits!.bravery;
    g.perform([{ type: 'click', entity: 'npc' }, { type: 'wait', ms: 50 }]);
    expect(snap(g).traits!.bravery).toBe(before);
  });

  it('validation: trait influences need existing axes, Persist needs something to keep, ranges need min <= max', () => {
    expect(() => game([villager({ Preferences: { generate: { x: { traits: { nope: 1 } } } } })])).toThrow(/Preferences\.generate\.x\.traits\.nope: trait "nope" does not exist/);
    expect(() => game([{ id: 'n', transform: { x: 0, y: 0 }, components: { Preferences: { generate: { x: { traits: { a: 1 } } } } } }])).toThrow(/the entity has no Traits/);
    expect(() => game([{ id: 'n', transform: { x: 0, y: 0 }, components: { Persist: { key: 'k' } } }])).toThrow(/Persist: nothing to keep/);
    expect(() => game([villager({ Traits: { generate: { a: { min: 0.8, max: 0.2 } } } })])).toThrow(/min must be <= max/);
  });
});

describe('Persist reset with a preset', () => {
  it('fixes some axes before drawing, so preferences that lean on them follow', () => {
    const g = game([villager({ Persist: { key: 'villager' }, Script: { src: 'scripts/v.js' }, Collider: { width: 40, height: 40 } })], {
      scripts: { 'scripts/v.js': "function onClick(self) { self.persist.reset({ traits: { bravery: 1 } }); }" },
    });
    g.step(1);
    g.perform([{ type: 'click', entity: 'npc' }, { type: 'wait', ms: 50 }]);
    expect(snap(g).traits!.bravery).toBe(1);
    expect(snap(g).prefs!.danger).toBeGreaterThanOrEqual(0.8);
    expect((g.storage.get('villager') as { traits: Record<string, number> }).traits.bravery).toBe(1);
  });
});
