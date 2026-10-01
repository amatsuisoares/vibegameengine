import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { evaluateExpr, Game, type GameOp } from '../src';

type SM = NonNullable<NonNullable<EntityInput['components']>['StateMachine']>;

function game(entities: EntityInput[], scripts: Record<string, string> = {}, prefabs: Record<string, unknown> = {}) {
  return Game.fromRaw({
    config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 },
    scenes: { main: { id: 'main', width: 400, height: 300, entities } },
    scripts,
    prefabs,
  });
}

const player = (x: number): EntityInput => ({ id: 'player', tags: ['player'], transform: { x, y: 150 }, components: { Sprite: { width: 20, height: 20 } } });
const machine = (sm: SM, extra: Partial<EntityInput> = {}): EntityInput => ({
  id: 'guard',
  transform: { x: 300, y: 150 },
  ...extra,
  components: { Sprite: { width: 20, height: 20, color: '#888888' }, StateMachine: sm, ...extra.components },
});
const changes = (g: Game) => g.events(0, 'state_change').map((e) => `${e.from}>${e.to}`);
const snap = (g: Game, id = 'guard') => g.getState({ ids: [id] }).entities[0];

/** idle <-> chase by distance to the player; each state sets the guard's color. */
const guard: SM = {
  initial: 'idle',
  states: {
    idle: {
      enter: [{ action: 'modify', target: '$self', component: 'Sprite', set: { color: '#888888' } }],
      transitions: [{ to: 'chase', when: "distance(self, 'player') < 100" }],
    },
    chase: {
      enter: [{ action: 'modify', target: '$self', component: 'Sprite', set: { color: '#ff0000' } }],
      exit: [{ action: 'addVar', var: 'chases', amount: 1 }],
      transitions: [{ to: 'idle', when: "distance(self, 'player') > 150" }],
    },
  },
};

describe('StateMachine', () => {
  it('starts in the initial state and changes state when a condition holds, running exit/enter actions', () => {
    const g = game([player(20), machine(guard)]);
    g.step(1);
    expect(snap(g)).toMatchObject({ state: 'idle', stateMs: 17 }); // entered on frame 0, now frame 1
    expect(changes(g)).toEqual(['null>idle']);

    g.entity('player')!.x = 220; // distance 80
    g.step(1);
    expect(snap(g).state).toBe('chase');
    expect(snap(g).prevState).toBe('idle');
    expect(g.entity('guard')!.components.Sprite!.color).toBe('#ff0000');

    g.entity('player')!.x = 120; // 180 > 150
    g.step(1);
    expect(changes(g)).toEqual(['null>idle', 'idle>chase', 'chase>idle']);
    expect(g.world.vars.chases).toBe(1);
    expect(g.entity('guard')!.components.Sprite!.color).toBe('#888888');
    expect(g.events(0, 'state_change')[1]).toMatchObject({ entity: 'guard', from: 'idle', to: 'chase' });
  });

  it('"after" waits for time in the state; stateMs counts it', () => {
    const g = game([machine({ initial: 'charge', states: { charge: { transitions: [{ to: 'fire', after: 500 }] }, fire: { transitions: [{ to: 'charge', after: 100 }] } } })]);
    g.advance(400);
    expect(snap(g)).toMatchObject({ state: 'charge', stateMs: 400 }); // entered on frame 0
    g.advance(200);
    expect(snap(g).state).toBe('fire');
    g.advance(500);
    expect(changes(g)).toEqual(['null>charge', 'charge>fire', 'fire>charge']);
  });

  it('event transitions match fields, with "$self" for this entity', () => {
    const sm: SM = {
      initial: 'sleeping',
      states: { sleeping: { transitions: [{ to: 'awake', event: 'interact', match: { entity: '$self' } }] }, awake: { transitions: [{ to: 'sleeping', after: 1000 }] } },
    };
    const g = game([machine(sm, { components: { Interactable: { via: ['click'] } } }), machine(sm, { id: 'other', transform: { x: 100, y: 150 } })]);
    g.perform([{ type: 'click', entity: 'guard' }]);
    expect(snap(g).state).toBe('awake');
    expect(snap(g, 'other').state).toBe('sleeping');
    g.advance(1100);
    expect(snap(g).state).toBe('sleeping');
  });

  it('transitions from any state come first; one transition per frame; transitions to the current state are ignored', () => {
    const sm: SM = {
      initial: 'a',
      transitions: [{ to: 'dead', when: 'vars.hp <= 0' }],
      states: { a: { transitions: [{ to: 'b' }] }, b: { transitions: [{ to: 'c' }] }, c: { transitions: [{ to: 'c' }] }, dead: {} },
    };
    const g = game([machine(sm)]);
    g.world.vars.hp = 1;
    g.step(3); // frame 0: enter a and a>b; frame 1: b>c
    expect(changes(g)).toEqual(['null>a', 'a>b', 'b>c']);
    g.world.vars.hp = 0;
    g.step(2);
    expect(changes(g).at(-1)).toBe('c>dead');
    expect(g.events(0, 'state_change')).toHaveLength(4); // "dead" to "dead" is ignored
  });

  it('enter actions can end the game and play sounds; emitted events carry the entity and state', () => {
    const g = Game.fromRaw({
      config: { name: 't', startScene: 'main', gravity: 0, assets: [{ id: 'sfx', type: 'audio', path: 'a.wav' }] },
      scenes: {
        main: {
          id: 'main',
          entities: [
            machine({
              initial: 'a',
              states: { a: { enter: [{ action: 'emit', event: 'hello' }, { action: 'playSound', asset: 'sfx' }], transitions: [{ to: 'b', after: 100 }] }, b: { enter: [{ action: 'win' }] } },
            }),
          ],
        },
      },
    });
    g.advance(300);
    expect(g.events(0, 'hello')[0]).toMatchObject({ entity: 'guard', state: 'a' });
    expect(g.events(0, 'sound')[0]).toMatchObject({ asset: 'sfx', cause: 'state:guard' });
    expect(g.status).toBe('won');
    expect(g.events(0, 'win')[0]).toMatchObject({ by: 'state', entity: 'guard', state: 'b' });
  });

  it('a failing condition disables that machine only, with state_error and a console error', () => {
    const g = game([machine({ initial: 'a', states: { a: { transitions: [{ to: 'b', when: 'nope > 1' }] }, b: {} } }), machine(guard, { id: 'ok' }), player(280)]);
    g.step(5);
    expect(g.status).toBe('running');
    expect(g.events(0, 'state_error')).toEqual([expect.objectContaining({ entity: 'guard', state: 'a', message: expect.stringMatching(/Unknown name "nope"/) })]);
    expect(g.console.read(0, 'error')).toHaveLength(1);
    expect(snap(g, 'ok').state).toBe('chase');
  });

  it('works on entities spawned from prefabs', () => {
    const g = game([], {}, { blinker: { components: { StateMachine: { initial: 'on', states: { on: { transitions: [{ to: 'off', after: 100 }] }, off: {} } } } } });
    g.world.spawn('blinker', 10, 10, 'b1');
    g.advance(300);
    expect(snap(g, 'b1').state).toBe('off');
  });
});

describe('StateMachine from scripts', () => {
  it('self.fsm reads and drives the machine; onStateChange sees every change, including the initial one', () => {
    const script = `
      function onStateChange(self, change, game) { game.vars.log = (game.vars.log || '') + change.from + '>' + change.to + ' '; }
      function onUpdate(self, game) {
        if (game.frame === 3) {
          game.vars.before = self.fsm.state + ':' + self.fsm.is('idle', 'x');
          game.vars.went = self.fsm.go('chase');
          game.vars.again = self.fsm.go('chase');
        }
        if (game.frame === 33) game.vars.time = self.fsm.time;
        if (game.frame === 40) self.fsm.go('nowhere');
      }`;
    const g = game([machine({ initial: 'idle', states: { idle: {}, chase: {} } }, { components: { Script: { src: 'scripts/s.js' } } })], { 'scripts/s.js': script });
    g.step(45);
    expect(g.world.vars).toMatchObject({ before: 'idle:true', went: true, again: false, log: 'null>idle idle>chase ', time: 0.5 });
    expect(snap(g)).toMatchObject({ state: 'chase', prevState: 'idle' });
    expect(g.events(0, 'script_error')[0].message).toMatch(/state "nowhere" does not exist \(states: idle, chase\)/);
  });

  it('go() before the machine first ran enters the initial state first', () => {
    const g = game([machine({ initial: 'a', states: { a: {}, b: {} } }, { components: { Script: { src: 'scripts/s.js' } } })], {
      'scripts/s.js': "function onStart(self) { self.fsm.go('b'); }",
    });
    g.step(2);
    expect(changes(g)).toEqual(['null>a', 'a>b']);
  });

  it('an endless chain of changes from onStateChange is stopped', () => {
    const g = game([machine({ initial: 'a', states: { a: {}, b: {} } }, { components: { Script: { src: 'scripts/s.js' } } })], {
      'scripts/s.js': "function onStateChange(self, c) { self.fsm.go(c.to === 'a' ? 'b' : 'a'); }",
    });
    g.step(2);
    expect(g.status).toBe('running');
    expect(g.events(0, 'script_error')[0].message).toMatch(/nested too deeply/);
  });
});

describe('StateMachine observation and determinism', () => {
  it('expressions read state, stateMs and distance', () => {
    const g = game([player(220), machine(guard)]);
    g.advance(500);
    const ok = (expr: string) => evaluateExpr(expr, { game: g }).value;
    expect(ok("entity('guard').state == 'chase'")).toBe(true);
    expect(ok("distance('guard', 'player')")).toBe(80);
    expect(ok("distance(entity('guard'), 'nope')")).toBe(null);
    expect(() => evaluateExpr('self.x', { game: g })).toThrow(/only exists in StateMachine and Interactable conditions/);
    expect(evaluateExpr('self.state', { game: g, self: 'guard' }).value).toBe('chase');
  });

  it('replaying the same ops gives the same state changes', () => {
    const make = () => game([{ ...player(140), components: { Sprite: { width: 20, height: 20 }, Body: { type: 'kinematic' } } }, machine(guard)]);
    const ops: GameOp[] = [];
    const a = make();
    for (let i = 0; i < 20; i++) {
      a.entity('player')!.components.Body!.vx = i % 8 < 4 ? 250 : -250;
      // Velocity changes are not ops: replay them through the same loop.
      ops.push({ op: 'step', frames: 10 });
      a.apply({ op: 'step', frames: 10 });
    }
    const b = make();
    for (let i = 0; i < 20; i++) {
      b.entity('player')!.components.Body!.vx = i % 8 < 4 ? 250 : -250;
      b.apply(ops[i]);
    }
    expect(changes(a).length).toBeGreaterThan(3);
    expect(b.events()).toEqual(a.events());
  });
});
