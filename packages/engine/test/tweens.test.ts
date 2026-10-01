import type { EntityInput, RuleInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game, type TweenOptions } from '../src';

function game(entities: EntityInput[], scripts: Record<string, string> = {}, rules: RuleInput[] = []) {
  return Game.fromRaw({ config: { name: 't', startScene: 'main', gravity: 0 }, scenes: { main: { id: 'main', entities, rules } }, scripts });
}

const box = (id: string, extra: EntityInput['components'] = {}): EntityInput => ({
  id,
  transform: { x: 100, y: 100 },
  components: { Sprite: { width: 20, height: 20 }, Text: { text: 'hi', screenSpace: false }, ...extra },
});
const e = (g: Game, id = 'b') => g.entity(id)!;

/** Starts a tween from a test (as a script would), on the next step. */
function tween(g: Game, id: string, o: TweenOptions) {
  g.world.tweens.start(e(g, id), o);
}

describe('tweens', () => {
  it('moves a property to its target over the duration with the chosen ease, then emits tween_end', () => {
    const g = game([box('b')]);
    tween(g, 'b', { prop: 'x', to: 200, ms: 1000, ease: 'linear' });
    g.step(30);
    expect(e(g).x).toBeCloseTo(150);
    expect(g.getState({ ids: ['b'] }).entities[0].tweens).toEqual([{ id: 'tween1', prop: 'x', to: 200, ms: 500 }]);
    g.step(30);
    expect(e(g).x).toBe(200);
    expect(g.events(0, 'tween_end')).toEqual([expect.objectContaining({ entity: 'b', prop: 'x', id: 'tween1' })]);
    expect(g.getState({ ids: ['b'] }).entities[0].tweens).toBeUndefined();

    const eased = game([box('b')]);
    tween(eased, 'b', { prop: 'y', to: 200, ms: 1000, ease: 'easeIn' });
    eased.step(30);
    expect(e(eased).y).toBeCloseTo(125); // halfway in time, a quarter of the way
    const out = game([box('b')]);
    tween(out, 'b', { prop: 'y', to: 200, ms: 1000, ease: 'easeOut' });
    out.step(30);
    expect(e(out).y).toBeCloseTo(175);
  });

  it('scale, rotation, opacity (Sprite and Text) and component fields', () => {
    const g = game([box('b')]);
    for (const [prop, to] of [['scale', 2], ['rotation', 90], ['opacity', 0], ['Text.fontSize', 32]] as const) tween(g, 'b', { prop, to, ms: 500 });
    g.advance(600);
    expect([e(g).scaleX, e(g).scaleY, e(g).rotation]).toEqual([2, 2, 90]);
    expect([e(g).components.Sprite!.opacity, e(g).components.Text!.opacity, e(g).components.Text!.fontSize]).toEqual([0, 0, 32]);
    expect(() => tween(g, 'b', { prop: 'colour', to: 1, ms: 1 })).toThrow(/cannot tween "colour"/);
    expect(() => tween(g, 'b', { prop: 'Sprite.color', to: 1, ms: 1 })).toThrow(/Sprite.color of "b" is not a number/);
    expect(() => tween(g, 'b', { prop: 'Body.vx', to: 1, ms: 1 })).toThrow(/has no Body/);
  });

  it('yoyo goes there and back; repeat plays more passes; -1 loops forever', () => {
    const g = game([box('b')]);
    tween(g, 'b', { prop: 'y', to: 120, ms: 500, ease: 'linear', yoyo: true, repeat: 1 });
    g.step(30);
    expect(e(g).y).toBe(120);
    g.step(30);
    expect(e(g).y).toBe(100);
    g.step(60);
    expect(e(g).y).toBe(100);
    expect(g.events(0, 'tween_end')).toHaveLength(1);

    const forever = game([box('b')]);
    tween(forever, 'b', { prop: 'rotation', to: 360, ms: 100, from: 0, repeat: -1, ease: 'linear' });
    forever.advance(10_000);
    expect(forever.getState({ ids: ['b'] }).entities[0].tweens).toEqual([{ id: 'tween1', prop: 'rotation', to: 360 }]);
    expect(forever.events(0, 'tween_end')).toEqual([]);
  });

  it('a new tween of the same property replaces the old one; stopping keeps the value; the entity owns them', () => {
    const g = game([box('b'), box('c')]);
    tween(g, 'b', { prop: 'x', to: 500, ms: 1000 });
    g.step(10);
    tween(g, 'b', { prop: 'scale', to: 3, ms: 100 });
    tween(g, 'b', { prop: 'scaleX', to: 0.5, ms: 100 }); // replaces the "scale" tween
    tween(g, 'b', { prop: 'x', to: 0, ms: 100, ease: 'linear' });
    g.step(3); // halfway through the 100 ms (6-frame) tweens
    expect(g.world.tweens.list(e(g)).map((t) => t.prop)).toEqual(['scaleX', 'x']);
    expect(e(g).scaleY).toBe(1);
    const x = e(g).x;
    expect(g.world.tweens.stop(e(g), 'x')).toBe(1);
    g.step(10);
    expect(e(g).x).toBe(x);

    tween(g, 'c', { prop: 'x', to: 0, ms: 1000 });
    e(g, 'c').enabled = false;
    g.step(30);
    expect(e(g, 'c').x).toBe(100); // waits while disabled
    e(g, 'c').destroyed = true;
    g.step(1);
    expect(g.world.tweens.list(e(g, 'c'))).toEqual([]);
  });
});

describe('tweens from scripts and data', () => {
  it('self.tween with onDone; errors in onDone are script errors', () => {
    const src = `function onStart(self, game) {
      self.tween('y', 50, 300, { ease: 'easeOut', onDone: () => { game.vars.done = game.frame; self.tween('opacity', 0, 100, { onDone: () => { throw new Error('oops'); } }); } });
    }`;
    const g = game([box('b', { Script: { src: 'scripts/s.js' } })], { 'scripts/s.js': src });
    g.advance(600);
    expect(g.world.vars.done).toBe(17); // started on frame 0, whose step already counts: 18 steps end on frame 17
    expect(e(g).y).toBe(50);
    expect(g.events(0, 'script_error')[0].message).toMatch(/onDone of tween "tween2" of "b": Error: oops/);
  });

  it('a "tween" action in a rule (after an interaction) and in a state enter', () => {
    const g = game(
      [box('btn', { Interactable: { via: ['click'] } }), box('ghost', { StateMachine: { initial: 'fading', states: { fading: { enter: [{ action: 'tween', target: '$self', prop: 'opacity', to: 0, ms: 500 }] } } } })],
      {},
      [{ id: 'pulse', when: { event: 'interact' }, do: [{ action: 'tween', target: '$entity', prop: 'scale', to: 1.2, ms: 100, yoyo: true, ease: 'easeOut' }] }],
    );
    g.perform([{ type: 'click', entity: 'btn' }, { type: 'wait', ms: 100 }]);
    expect(e(g, 'btn').scaleX).toBeGreaterThan(1.1);
    g.advance(200);
    expect(e(g, 'btn').scaleX).toBe(1);
    g.advance(400);
    expect(e(g, 'ghost').components.Sprite!.opacity).toBe(0);
  });

  it('replays exactly', () => {
    const run = () => {
      const g = game([box('b', { Script: { src: 'scripts/s.js' } })], {
        'scripts/s.js': "function onStart(self, game) { self.every(170, () => self.tween('x', game.randomInt(0, 300), 120, { ease: 'easeInOut' })); }",
      });
      g.advance(4000);
      return [e(g).x, g.events().length];
    };
    expect(run()).toEqual(run());
  });
});
