import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';

/** A dog learning what it likes from what happens to it (nothing pet-specific). */
function game(prefs: Record<string, unknown> = {}) {
  const dog: EntityInput = {
    id: 'dog',
    transform: { x: 0, y: 0 },
    components: {
      Sprite: {},
      Memory: {},
      Preferences: { values: { bath: { innate: 0.1, learned: 0, n: 0 }, bone: { innate: 0.3, learned: 0, n: 0 } }, learnRate: 0.1, learnFrom: { bathed: 1, scared: 2 }, ...prefs },
      Script: { src: 'scripts/d.js' },
    },
  };
  return Game.fromRaw({ config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, entities: [dog] } }, scripts: { 'scripts/d.js': '' } }, { seed: 1 });
}
type Api = { memory: { remember: Function }; prefs: { of: Function; learn: Function } };
const api = (g: Game) => (g as unknown as { scriptRunner: { api: { entity(e: unknown): Api } } }).scriptRunner.api.entity(g.entity('dog'));

describe('Preferences that change', () => {
  it('learnFrom: remembering an experience also teaches the preference (valence × weight); a level crossed is a preference_change', () => {
    const g = game();
    g.step(1);
    const d = api(g);
    d.memory.remember('bathed', { subject: 'bath', valence: 1 });
    expect(d.prefs.of('bath')).toBeCloseTo(0.2, 3); // 0.1 + 0.1 × 1
    expect(g.events(0, 'preference_change')).toEqual([expect.objectContaining({ entity: 'dog', subject: 'bath', from: 'neutral', to: 'like' })]);
    d.memory.remember('scared', { subject: 'bone', valence: -1 }); // weight 2, clamped to -1 → -0.1
    expect(d.prefs.of('bone')).toBeCloseTo(0.2, 3);
    d.memory.remember('played', { subject: 'bone', valence: 1 }); // not a teaching type
    expect(d.prefs.of('bone')).toBeCloseTo(0.2, 3);
    d.prefs.learn('bone', -1);
    expect(g.events(0, 'preference_change').at(-1)).toMatchObject({ subject: 'bone', from: 'like', to: 'neutral' });
  });

  it('what it learned about a thing counts in full over what its tags make it expect (a disliked kind of thing can still become liked)', () => {
    const g = game({ values: { carrot: { innate: -0.12, learned: 0, n: 0 }, crunchy: { innate: -0.3, learned: 0, n: 0 }, veggie: { innate: -0.15, learned: 0, n: 0 } }, subjectWeight: 0.4, tagBlend: 0.7 });
    g.step(1);
    const prefs = (g as unknown as { scriptRunner: { api: { entity(e: unknown): { prefs: { evaluate: Function; learn: Function } } } } }).scriptRunner.api.entity(g.entity('dog')).prefs;
    const carrot = () => prefs.evaluate('carrot', ['crunchy', 'veggie']);
    expect(carrot().level).toBe('dislike');
    for (let i = 0; i < 5; i++) prefs.learn('carrot', 1); // +0.5 (the most it can learn)
    // 0.4 × -0.12 + 0.6 × tags (-0.278) + 0.5 learned ≈ 0.29: liked (with learned weighted like the innate it stayed neutral)
    expect(carrot().score).toBeCloseTo(0.286, 2);
    expect(carrot().level).toBe('like');
  });

  it('learnFrom needs a Memory component', () => {
    expect(() =>
      Game.fromRaw({ config: { name: 't', startScene: 'main' }, scenes: { main: { id: 'main', entities: [{ id: 'x', transform: { x: 0, y: 0 }, components: { Preferences: { learnFrom: { a: 1 } } } }] } } }),
    ).toThrow(/learnFrom: learning from memories needs a Memory component/);
  });
});
