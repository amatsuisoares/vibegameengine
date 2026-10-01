import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { ground, GROUND_TOP, player } from './helpers';

function scripted(entities: EntityInput[], scripts: Record<string, string>, seed = 1) {
  return Game.fromRaw(
    { config: { name: 'test', startScene: 'main' }, scenes: { main: { id: 'main', width: 3000, entities } }, scripts },
    { seed },
  );
}

const box = (id: string, x: number, src: string, props: Record<string, number | string | boolean> = {}, extra: EntityInput['components'] = {}): EntityInput => ({
  id,
  tags: ['box'],
  transform: { x, y: 100 },
  components: { Collider: { width: 16, height: 16, isTrigger: true }, Script: { src, props }, ...extra },
});

const errors = (g: Game) => g.console.read(0, 'error').map((e) => e.message);

describe('Script component', () => {
  it('runs onStart once and onUpdate every frame, with per-entity props and state', () => {
    const src = `
      let ticks = 0;                       // one copy per entity
      function onStart(self) { self.state.startX = self.x; }
      function onUpdate(self, game, dt) {
        ticks++;
        self.x += self.props.speed * dt;
        game.vars[self.id + '_ticks'] = ticks;
      }`;
    const game = scripted([box('a', 100, 'scripts/mover.js', { speed: 60 }), box('b', 500, 'scripts/mover.js', { speed: -120 })], {
      'scripts/mover.js': src,
    });
    game.step(60);
    expect(game.entity('a')!.x).toBeCloseTo(160, 5);
    expect(game.entity('b')!.x).toBeCloseTo(380, 5);
    expect(game.world.vars).toMatchObject({ a_ticks: 60, b_ticks: 60 });
    expect(errors(game)).toEqual([]);
  });

  it('calls onCollision once when a contact begins, on both sides', () => {
    const coinScript = `
      function onCollision(self, other, game) {
        if (!other.hasTag('player')) return;
        game.vars.bonus = (game.vars.bonus || 0) + self.props.value;
        game.emit('bonus', { by: other.id, value: self.props.value });
        self.destroy();
      }`;
    const playerScript = `function onCollision(self, other, game) { game.vars.touched = other.id; }`;
    const game = scripted(
      [
        player(100, GROUND_TOP - 16, { Script: { src: 'scripts/player.js' } }),
        ground('g', 0, 1000),
        { ...box('gem', 160, 'scripts/gem.js', { value: 5 }), transform: { x: 160, y: GROUND_TOP - 10 } },
      ],
      { 'scripts/gem.js': coinScript, 'scripts/player.js': playerScript },
    );
    game.perform([{ type: 'hold', key: 'D', ms: 800 }, { type: 'wait', ms: 500 }]);
    expect(game.world.vars.bonus).toBe(5);
    expect(game.world.vars.touched).toBe('gem');
    expect(game.entity('gem')).toBeUndefined();
    expect(game.events(0, 'bonus')).toEqual([{ frame: expect.any(Number), type: 'bonus', by: 'player', value: 5 }]);
  });

  it('reports runtime errors with file:line, disables the script and keeps the game running', () => {
    const src = ['function onUpdate(self, game) {', '  if (game.frame === 10) {', '    self.nope.boom();', '  }', '}'].join('\n');
    const game = scripted([box('a', 100, 'scripts/bad.js'), player(), ground('g', 0, 1000)], { 'scripts/bad.js': src });
    game.step(30);
    expect(game.status).toBe('running');
    const [err] = errors(game);
    expect(err).toContain('scripts/bad.js:3:');
    expect(err).toContain('in onUpdate of "a"');
    expect(err).toMatch(/TypeError: Cannot read properties of undefined/);
    expect(errors(game)).toHaveLength(1); // disabled: no error flood
    expect(game.events(0, 'script_error')[0]).toMatchObject({ entity: 'a', script: 'scripts/bad.js' });
  });

  it('reports syntax errors and missing velocity bodies clearly', () => {
    const game = scripted([box('a', 100, 'scripts/syntax.js'), box('b', 200, 'scripts/vel.js')], {
      'scripts/syntax.js': 'function onUpdate( {',
      'scripts/vel.js': 'function onStart(self) { self.vx = 10; }',
    });
    game.step(2);
    const errs = errors(game);
    expect(errs[0]).toMatch(/scripts\/syntax\.js: SyntaxError/);
    expect(errs[1]).toMatch(/scripts\/vel\.js:1:\d+ in onStart of "b": Error: entity "b" has no Body/);
  });

  it('is deterministic: Math.random is seeded and wall-clock time is hidden', () => {
    const src = `
      function onStart(self, game) {
        game.vars.r = Math.random();
        game.vars.n = game.randomInt(1, 6);
        game.vars.hidden = [typeof Date, typeof setTimeout, typeof process, typeof globalThis, typeof window].join(',');
      }`;
    const run = (seed: number) => {
      const g = scripted([box('a', 100, 'scripts/r.js')], { 'scripts/r.js': src }, seed);
      g.step(1);
      return g.world.vars;
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7).r).not.toBe(run(8).r);
    expect(run(1).hidden).toBe('undefined,undefined,undefined,undefined,undefined');
  });

  it('can read input, find entities, change components and end the game', () => {
    const src = `
      function onUpdate(self, game) {
        if (game.input.pressed('jump')) self.get('Sprite').color = '#ff0000';
        const p = game.find('player')[0];
        if (p && p.x > 300) game.win();
      }`;
    const game = scripted([box('judge', 50, 'scripts/judge.js', {}, { Sprite: { width: 8, height: 8 } }), player(), ground('g', 0, 1000)], {
      'scripts/judge.js': src,
    });
    game.perform([{ type: 'tap', key: 'Space' }]);
    expect(game.entity('judge')!.components.Sprite!.color).toBe('#ff0000');
    game.perform([{ type: 'hold', key: 'D', ms: 3000 }]);
    expect(game.status).toBe('won');
    expect(game.events(0, 'win')[0]).toMatchObject({ by: 'script' });
  });

  it('restart gives scripts fresh state', () => {
    const src = 'let n = 0; function onUpdate(self, game) { n++; game.vars.n = n; }';
    const game = scripted([box('a', 100, 'scripts/c.js')], { 'scripts/c.js': src });
    game.step(10);
    game.restart();
    game.step(3);
    expect(game.world.vars.n).toBe(3);
  });

  it('validation rejects a Script that points to a missing file', () => {
    expect(() => scripted([box('a', 1, 'scripts/missing.js')], {})).toThrow(/Script\.src: script file "scripts\/missing\.js" does not exist/);
    expect(() => scripted([box('a', 1, 'other/x.js')], { 'other/x.js': '' })).toThrow(/must be a \.js file in scripts\//);
  });
});
