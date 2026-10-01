import type { EntityInput, RuleInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';

function game(entities: EntityInput[], scripts: Record<string, string> = {}, rules: RuleInput[] = []) {
  return Game.fromRaw({
    config: { name: 't', startScene: 'main', gravity: 0 },
    scenes: { main: { id: 'main', entities, rules } },
    scripts,
  });
}

const scripted = (id: string, src: string, extra: Partial<EntityInput> = {}): EntityInput => ({
  id,
  transform: { x: 50, y: 50 },
  ...extra,
  components: { Sprite: {}, Script: { src }, ...extra.components },
});
const log = (g: Game) => String(g.world.vars.log ?? '');

describe('script timers', () => {
  it('after fires once at its time (in frames), every repeats, cancel stops, the same id restarts', () => {
    const src = `
      function add(game, s) { game.vars.log = (game.vars.log || '') + s + '@' + game.frame + ' '; }
      function onStart(self, game) {
        self.after(500, () => add(game, 'once'));
        self.every(250, () => add(game, 'tick'), 'ticker');
        self.after(1000, () => add(game, 'late'), 'late');
        self.after(100, () => self.after(1000, () => add(game, 'late2'), 'late')); // restarts "late"
        self.after(700, () => self.cancel('ticker'));
      }`;
    const g = game([scripted('a', 'scripts/a.js')], { 'scripts/a.js': src });
    g.step(1);
    expect(g.getState({ ids: ['a'] }).entities[0].timers!.map((t) => t.id)).toEqual(['timer2', 'ticker', 'timer1', 'timer3', 'late']); // soonest first
    g.advance(2000);
    // onStart runs on frame 0: 500 ms = 30 frames -> frame 30; ticks every 15 frames until cancelled at 42.
    expect(log(g)).toBe('tick@15 once@30 tick@30 late2@66 ');
    expect(g.getState({ ids: ['a'] }).entities[0].timers).toBeUndefined();
  });

  it('timers belong to their entity: dropped when it is destroyed, waiting while it is disabled', () => {
    const src = "function onStart(self, game) { self.after(200, () => { game.vars[self.id] = game.frame; }); }";
    const g = game([scripted('gone', 'scripts/t.js'), scripted('napping', 'scripts/t.js')], { 'scripts/t.js': src });
    g.step(1);
    g.entity('gone')!.destroyed = true;
    g.entity('napping')!.enabled = false;
    g.advance(500);
    expect(g.world.vars).not.toHaveProperty('gone');
    expect(g.world.vars).not.toHaveProperty('napping');
    g.entity('napping')!.enabled = true;
    g.step(2);
    expect(g.world.vars.napping).toBe(31);
  });

  it('cooldown answers whether an action may happen again, and shows in the state', () => {
    const src = `function onUpdate(self, game) {
      if (game.frame % 10 === 0 && self.cooldown('bark', 500)) game.vars.log = (game.vars.log || '') + game.frame + ' ';
    }`;
    const g = game([scripted('dog', 'scripts/d.js')], { 'scripts/d.js': src });
    g.step(5);
    expect(g.getState({ ids: ['dog'] }).entities[0].cooldowns).toEqual({ bark: 417 });
    g.advance(2000);
    expect(log(g)).toBe('0 30 60 90 120 ');
  });

  it('an error in a callback is a script error of its entity', () => {
    const g = game([scripted('a', 'scripts/a.js')], { 'scripts/a.js': 'function onStart(self) { self.after(100, () => { throw new Error("boom"); }); }' });
    g.advance(500);
    expect(g.status).toBe('running');
    expect(g.events(0, 'script_error')[0].message).toMatch(/timer "timer1" of "a": Error: boom/);
    const bad = game([scripted('b', 'scripts/b.js')], { 'scripts/b.js': 'function onStart(self) { self.after(-1, () => {}); }' });
    bad.step(1);
    expect(bad.events(0, 'script_error')[0].message).toMatch(/timer ms must be a number >= 0 \(got -1\)/);
  });

  it('replays exactly', () => {
    const src = `function onStart(self, game) { self.every(130, () => { game.vars.n = (game.vars.n || 0) + game.randomInt(1, 6); }); }`;
    const run = () => {
      const g = game([scripted('a', 'scripts/a.js')], { 'scripts/a.js': src });
      g.advance(5000);
      return [g.world.vars.n, g.frame];
    };
    expect(run()).toEqual(run());
  });
});

describe('"after" actions in rules and states', () => {
  it('a rule delays actions, keeps $by, and cancelTimer stops a pending one', () => {
    const g = game(
      [
        { id: 'hero', tags: ['player'], transform: { x: 0, y: 0 }, components: { Health: { max: 5, current: 1 } } },
        { id: 'door', transform: { x: 0, y: 0 }, components: { Sprite: {} } },
      ],
      {},
      [
        { id: 'key', when: { event: 'gotKey' }, do: [{ action: 'after', ms: 1000, id: 'open', do: [{ action: 'setEnabled', target: 'door', enabled: false }, { action: 'heal', target: '$by', amount: 2 }] }] },
        { id: 'alarm', when: { event: 'alarm' }, do: [{ action: 'cancelTimer', id: 'open' }] },
      ],
    );
    g.world.emit('gotKey', { by: 'hero' });
    g.advance(500);
    expect(g.entity('door')!.enabled).toBe(true);
    g.advance(600);
    expect(g.entity('door')!.enabled).toBe(false);
    expect(g.entity('hero')!.health).toBe(3);

    g.entity('door')!.enabled = true;
    g.world.emit('gotKey', { by: 'hero' });
    g.advance(500);
    g.world.emit('alarm');
    g.advance(1000);
    expect(g.entity('door')!.enabled).toBe(true);
  });

  it('a state schedules with $self; the timer goes with the entity', () => {
    const fuse = (id: string): EntityInput => ({
      id,
      transform: { x: 0, y: 0 },
      components: {
        StateMachine: { initial: 'lit', states: { lit: { enter: [{ action: 'after', ms: 300, do: [{ action: 'emit', event: 'boom' }, { action: 'destroy', target: '$self' }] }] } } },
      },
    });
    const g = game([fuse('f1'), fuse('f2')]);
    g.step(1);
    expect(g.getState({ ids: ['f1'] }).entities[0].timers).toEqual([{ id: 'timer1', ms: 283 }]);
    g.entity('f2')!.destroyed = true;
    g.advance(500);
    expect(g.events(0, 'boom')).toEqual([expect.objectContaining({ entity: 'f1', state: 'lit' })]);
    expect(g.entity('f1')).toBeUndefined();
  });
});
