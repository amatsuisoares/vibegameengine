import type { EntityInput, RuleInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';

type Emitter = NonNullable<NonNullable<EntityInput['components']>['ParticleEmitter']>;

function game(entities: EntityInput[], opts: { scripts?: Record<string, string>; rules?: RuleInput[]; seed?: number } = {}) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0 }, scenes: { main: { id: 'main', entities, rules: opts.rules } }, scripts: opts.scripts },
    { seed: opts.seed ?? 1 },
  );
}
const fountain = (em: Emitter, extra: EntityInput['components'] = {}): EntityInput => ({
  id: 'fx',
  transform: { x: 100, y: 100 },
  components: { ParticleEmitter: em, ...extra },
});
const ps = (g: Game) => g.world.particles.particles;

describe('ParticleEmitter', () => {
  it('emits at its rate, up to max, and particles die after their lifetime', () => {
    const g = game([fountain({ rate: 20, lifeMs: 5000, jitter: 0 })]);
    g.advance(1000);
    expect(ps(g)).toHaveLength(20);
    expect(g.getState({ ids: ['fx'] }).entities[0].particles).toEqual({ alive: 20, emitting: true });
    const capped = game([fountain({ rate: 100, max: 30, lifeMs: 5000 })]);
    capped.advance(1000);
    expect(ps(capped)).toHaveLength(30);
    const short = game([fountain({ rate: 0, burst: 12, lifeMs: 300, jitter: 0 })]);
    short.step(1);
    expect(ps(short)).toHaveLength(12);
    expect(short.events(0, 'particles')).toEqual([expect.objectContaining({ entity: 'fx', count: 12 })]);
    short.advance(400);
    expect(ps(short)).toHaveLength(0);
  });

  it('moves particles by speed and angle, gravity and drag', () => {
    const up = game([fountain({ rate: 0, burst: 1, speed: 60, angle: -90, spread: 0, jitter: 0, lifeMs: 5000 })]);
    up.advance(1000);
    expect(ps(up)[0].x).toBeCloseTo(100);
    expect(ps(up)[0].y).toBeCloseTo(40, 0);
    const falling = game([fountain({ rate: 0, burst: 1, speed: 0, gravity: 100, jitter: 0, lifeMs: 5000 })]);
    falling.advance(1000);
    expect(ps(falling)[0].vy).toBeCloseTo(100, 0);
    const slowed = game([fountain({ rate: 0, burst: 1, speed: 100, angle: 0, spread: 0, drag: 2, jitter: 0, lifeMs: 5000 })]);
    slowed.advance(1000);
    expect(ps(slowed)[0].vx).toBeLessThan(20);
  });

  it('is reproducible from the seed and does not change the game\'s own random draws', () => {
    const shape = (seed: number) => {
      const g = game([fountain({ rate: 30 })], { seed });
      g.advance(800);
      return ps(g).map((p) => [Math.round(p.x * 100), Math.round(p.y * 100), p.color]);
    };
    expect(shape(4)).toEqual(shape(4));
    expect(shape(5)).not.toEqual(shape(4));
    const draws = (withFx: boolean) => {
      const g = game(withFx ? [fountain({ rate: 50 })] : []);
      g.advance(500);
      return [g.world.rng.next(), g.world.rng.next()];
    };
    expect(draws(true)).toEqual(draws(false));
  });
});

describe('particles from scripts and data', () => {
  it('self.particles bursts and toggles; game.emitParticles emits anywhere and validates its options', () => {
    const src = `
      function onStart(self, game) {
        game.vars.burst = self.particles.burst(8);
        self.particles.emitting = false;
        game.vars.hearts = game.emitParticles(300, 50, 5, { text: '♥', colors: ['#ff8fab'], gravity: -40 });
        try { game.emitParticles(0, 0, 5, { shape: 'star' }); } catch (e) { game.vars.err = e.message; }
      }`;
    const g = game([fountain({ rate: 50 }, { Script: { src: 'scripts/s.js' } })], { scripts: { 'scripts/s.js': src } });
    g.advance(500);
    expect(g.world.vars).toMatchObject({ burst: 8, hearts: 5 });
    expect(String(g.world.vars.err)).toMatch(/emitParticles: shape: /);
    expect(ps(g).filter((p) => p.text === '♥')).toHaveLength(5);
    expect(g.getState({ ids: ['fx'] }).entities[0].particles).toEqual({ alive: 8, emitting: false });
    expect(g.events(0, 'particles').map((e) => e.count)).toEqual([8, 5]);
  });

  it('a "burst" action puffs an emitter when something happens', () => {
    const g = game([fountain({ rate: 0, colors: ['#8a6a4a'] }, { Sprite: {}, Interactable: { via: ['click'] } })], {
      rules: [{ id: 'puff', when: { event: 'interact' }, do: [{ action: 'burst', target: '$entity', count: 15 }] }],
    });
    g.perform([{ type: 'click', entity: 'fx' }]);
    expect(ps(g)).toHaveLength(15);
    expect(ps(g).every((p) => p.color === '#8a6a4a')).toBe(true);
  });
});
