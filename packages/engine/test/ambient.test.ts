import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { evaluateExpr } from '../src/expr';

/** A garden at night: a lantern (light, near), a fountain (noise, near, flat), the moon (light everywhere), a bench (comfort). */
function garden(extra: EntityInput[] = [], scripts: Record<string, string> = {}) {
  const entities: EntityInput[] = [
    { id: 'lantern', transform: { x: 100, y: 100 }, components: { Sprite: {}, Ambient: { emits: { light: 1 }, radius: 100 } } },
    { id: 'fountain', transform: { x: 300, y: 100 }, components: { Sprite: {}, Ambient: { emits: { noise: 0.5 }, radius: 50, falloff: 'none' } } },
    { id: 'moon', transform: { x: 0, y: 0 }, components: { Ambient: { emits: { light: 0.2 } } } },
    { id: 'bench', transform: { x: 150, y: 100 }, components: { Sprite: {}, Ambient: { emits: { comfort: 0.8 }, radius: 40 } } },
    ...extra,
  ];
  return Game.fromRaw({ config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, entities } }, scripts }, { seed: 1 });
}

describe('Ambient', () => {
  it('env at a point sums what reaches it: linear falloff, flat falloff, whole-scene emitters; disabled emits nothing', () => {
    const g = garden([{ id: 'cat', transform: { x: 150, y: 100 }, components: { Sprite: {}, Script: { src: 'scripts/c.js' } } }], {
      'scripts/c.js': 'function onUpdate(self, game) { game.vars.here = game.env(self); game.vars.far = game.env(390, 290); }',
    });
    g.step(1);
    expect(g.world.vars.here).toEqual({ light: 0.7, comfort: 0.8 }); // lantern half way (0.5) + moon 0.2
    expect(g.world.vars.far).toEqual({ light: 0.2 }); // only the moon
    expect(evaluateExpr("env('noise', 'fountain')", { game: g }).value).toBe(0.5);
    expect(evaluateExpr('env("noise", 340, 100)', { game: g }).value).toBe(0.5); // flat up to the radius
    expect(evaluateExpr("env('comfort', 'lantern')", { game: g }).value).toBe(0);
    g.entity('lantern')!.components.Ambient!.enabled = false;
    g.step(1);
    expect(g.world.vars.here).toEqual({ light: 0.2, comfort: 0.8 });
    expect(g.getState({ ids: ['lantern'] }).entities[0].ambient).toEqual({ emits: { light: 1 }, enabled: false, radius: 100 });
  });

  it('env(prop, target) lets a UtilityAI pick the place: the cosiest spot wins', () => {
    const spots: EntityInput[] = [
      { id: 'rock', tags: ['spot'], transform: { x: 380, y: 280 }, components: { Sprite: {} } },
      { id: 'seat', tags: ['spot'], transform: { x: 150, y: 100 }, components: { Sprite: {} } },
    ];
    const cat: EntityInput = {
      id: 'cat',
      transform: { x: 0, y: 0 },
      components: { Sprite: {}, UtilityAI: { options: { rest: { targets: { tag: 'spot' }, score: "0.1 + env('comfort', target) - env('light', target) * 0.2" } } } },
    };
    const g = garden([...spots, cat]);
    g.step(2);
    expect(g.getState({ ids: ['cat'] }).entities[0].ai).toMatchObject({ choice: 'rest', target: 'seat' });
  });
});
