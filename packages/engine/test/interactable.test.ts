import type { EntityInput, ProjectInput, RuleInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game, type GameOp } from '../src';

type Extra = { scripts?: Record<string, string>; rules?: RuleInput[]; vars?: Record<string, number>; config?: Partial<ProjectInput['config']> };

function game(entities: EntityInput[], extra: Extra = {}) {
  return Game.fromRaw({
    config: {
      name: 't',
      startScene: 'main',
      gravity: 0,
      width: 400,
      height: 300,
      assets: [{ id: 'sfx_door', type: 'audio', path: 'door.wav' }],
      ...extra.config,
    },
    scenes: { main: { id: 'main', width: 400, height: 300, vars: extra.vars, rules: extra.rules, entities } },
    scripts: extra.scripts,
  });
}

const player = (x: number, components: EntityInput['components'] = {}): EntityInput => ({
  id: 'player',
  tags: ['player'],
  transform: { x, y: 150 },
  components: { Sprite: { width: 20, height: 20 }, Collider: { width: 20, height: 20 }, ...components },
});

/** A 40x40 door at (200, 150): its box spans x 180..220. */
const door = (interactable: NonNullable<EntityInput['components']>['Interactable'] = {}, extra: Partial<EntityInput> = {}): EntityInput => ({
  id: 'door',
  transform: { x: 200, y: 150 },
  ...extra,
  components: { Sprite: { width: 40, height: 40 }, Interactable: { action: 'open', label: 'Abrir', ...interactable }, ...extra.components },
});

const kinds = (g: Game, type: string) => g.events(0, type).map(({ frame: _f, type: _t, ...rest }) => rest);

describe('Interactable: keyboard', () => {
  it('the interaction key uses the nearest interactable in range; out of range nothing happens', () => {
    const g = game([player(100), door()]); // gap 70 > range 32
    g.perform([{ type: 'tap', key: 'E' }]);
    expect(g.events(0, 'interact')).toEqual([]);
    expect(g.world.interactFocus).toBeNull();

    g.entity('player')!.x = 160; // player box ends at 170: gap 10
    g.step(1);
    expect(g.world.interactFocus).toEqual({ entity: 'door', by: 'player' });
    g.perform([{ type: 'tap', key: 'E' }]);
    expect(kinds(g, 'interact')).toEqual([{ entity: 'door', action: 'open', via: 'key', by: 'player', label: 'Abrir' }]);
    expect(g.getState({ ids: ['door'] }).entities[0].interactable).toEqual({
      action: 'open',
      label: 'Abrir',
      via: ['click', 'key'],
      enabled: true,
      uses: 1,
      inRange: ['player'],
    });
  });

  it('picks the closest of several interactables, and only actors with actorTags count', () => {
    const g = game([
      player(160),
      door(),
      { id: 'lever', transform: { x: 120, y: 150 }, components: { Sprite: { width: 10, height: 10 }, Interactable: { action: 'pull' } } },
      { id: 'npc', tags: ['npc'], transform: { x: 240, y: 150 }, components: { Sprite: { width: 20, height: 20 } } },
    ]);
    g.perform([{ type: 'tap', key: 'E' }]); // lever gap 25, door gap 10
    expect(kinds(g, 'interact').map((e) => e.entity)).toEqual(['door']);
    expect(g.getState({ ids: ['door'] }).entities[0].interactable!.inRange).toEqual(['player']); // the npc is not an actor
  });

  it('uses a custom key or action, and projects with their own actions keep working', () => {
    const g = game([player(160), door({ key: 'use' })], { config: { actions: { use: ['F'] } } });
    g.perform([{ type: 'tap', key: 'E' }]);
    expect(g.events(0, 'interact')).toEqual([]);
    g.perform([{ type: 'tap', key: 'F' }]);
    expect(g.events(0, 'interact')).toHaveLength(1);
  });
});

describe('Interactable: mouse', () => {
  it('a click on the entity interacts (no actor, no range); a disabled one lets the click through', () => {
    const g = game([
      player(20),
      { id: 'floor', tags: ['clickable'], transform: { x: 200, y: 150 }, components: { Sprite: { width: 400, height: 300, layer: -1 } } },
      door(),
    ]);
    g.perform([{ type: 'click', entity: 'door' }]);
    expect(kinds(g, 'click').map((e) => e.entity)).toEqual(['door']);
    expect(kinds(g, 'interact')).toEqual([{ entity: 'door', action: 'open', via: 'click', label: 'Abrir' }]);

    g.entity('door')!.components.Interactable!.enabled = false;
    g.perform([{ type: 'click', x: 200, y: 150 }]);
    expect(kinds(g, 'click').map((e) => e.entity)).toEqual(['door', 'floor']);
    expect(g.events(0, 'interact')).toHaveLength(1);
  });

  it('is not clickable without "click" in via', () => {
    const g = game([door({ via: ['key'] })]);
    g.perform([{ type: 'click', entity: 'door' }]);
    expect(g.events(0, 'click')).toEqual([]);
    expect(g.events(0, 'interact')).toEqual([]);
  });

  it('a click on an entity aims at where it is on screen (camera) and refuses entities off screen', () => {
    const g = Game.fromRaw({
      config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 },
      scenes: { main: { id: 'main', width: 2000, height: 300, camera: { x: 300 }, entities: [door({}, { transform: { x: 500, y: 150 } }), door({}, { id: 'far', transform: { x: 1500, y: 150 } })] } },
    });
    expect(g.screenPointOf('door')).toEqual({ x: 200, y: 150 });
    expect(g.expand({ type: 'click', entity: 'door' })[0]).toEqual({ op: 'mouseMove', x: 200, y: 150 });
    expect(() => g.perform([{ type: 'click', entity: 'far' }])).toThrow(/off screen/);
    expect(() => g.perform([{ type: 'click', entity: 'nope' }])).toThrow(/does not exist/);
  });
});

describe('Interactable: rules', () => {
  it('cooldown, once and condition block attempts with a reason', () => {
    const g = game([player(160), door({ cooldownMs: 500 }), door({ action: 'take', once: true }, { id: 'key1', transform: { x: 120, y: 150 } })]);
    g.perform([{ type: 'tap', key: 'E' }, { type: 'tap', key: 'E' }]);
    expect(kinds(g, 'interact_blocked')).toEqual([{ entity: 'door', action: 'open', via: 'key', by: 'player', reason: 'cooldown', cooldownMs: 450 }]);
    g.perform([{ type: 'wait', ms: 500 }, { type: 'tap', key: 'E' }]);
    expect(g.events(0, 'interact')).toHaveLength(2);

    const once = game([player(160), door({ once: true })]);
    once.perform([{ type: 'tap', key: 'E' }, { type: 'tap', key: 'E' }]);
    expect(once.events(0, 'interact')).toHaveLength(1);
    expect(once.getState({ ids: ['door'] }).entities[0].interactable).toMatchObject({ enabled: false, uses: 1 });

    const locked = game([player(160), door({ condition: 'vars.keys >= 1' })], { vars: { keys: 0 } });
    locked.perform([{ type: 'tap', key: 'E' }]);
    expect(kinds(locked, 'interact_blocked').map((e) => e.reason)).toEqual(['condition']);
    locked.world.vars.keys = 1;
    locked.perform([{ type: 'tap', key: 'E' }]);
    expect(locked.events(0, 'interact')).toHaveLength(1);
  });

  it('a failing condition blocks with reason "error" and logs once', () => {
    const g = game([player(160), door({ condition: 'nope > 1' })]);
    g.perform([{ type: 'tap', key: 'E' }, { type: 'tap', key: 'E' }]);
    expect(kinds(g, 'interact_blocked').map((e) => e.reason)).toEqual(['error', 'error']);
    expect(g.console.read(0, 'error').map((l) => l.message)).toEqual([expect.stringMatching(/Interactable of "door": condition .*Unknown name "nope"/)]);
    expect(g.status).toBe('running');
  });

  it('"enter" fires when an actor comes within range, once per approach', () => {
    const g = game([player(100, { Body: { type: 'kinematic', vx: 120 } }), door({ via: ['enter'], range: 0 })]);
    g.perform([{ type: 'wait', ms: 500 }]); // player box reaches 170: not touching yet
    expect(g.events(0, 'interact')).toEqual([]);
    g.perform([{ type: 'wait', ms: 500 }]); // and passes through the door
    expect(kinds(g, 'interact')).toEqual([{ entity: 'door', action: 'open', via: 'enter', by: 'player', label: 'Abrir' }]);
    g.perform([{ type: 'wait', ms: 1000 }]); // still overlapping or leaving: no repeat
    expect(g.events(0, 'interact')).toHaveLength(1);
    const p = g.entity('player')!;
    p.components.Body!.vx = -120;
    g.perform([{ type: 'wait', ms: 1500 }]); // back through the door
    expect(g.events(0, 'interact')).toHaveLength(2);
  });

  it('rules react to "interact" with $by (the actor) and $entity (the interactable)', () => {
    const g = game(
      [player(160, { Health: { max: 3, current: 1 } }), door({ action: 'pickup' }, { id: 'potion' })],
      {
        rules: [
          { id: 'drink', when: { event: 'interact', match: { action: 'pickup' } }, do: [{ action: 'heal', target: '$by', amount: 2 }, { action: 'destroy', target: '$entity' }] },
        ],
      },
    );
    g.perform([{ type: 'tap', key: 'E' }]);
    expect(g.entity('player')!.health).toBe(3);
    expect(g.entity('potion')).toBeUndefined();
  });

  it('plays its sound on success', () => {
    const g = game([player(160), door({ sound: 'sfx_door' })]);
    g.perform([{ type: 'tap', key: 'E' }]);
    expect(kinds(g, 'sound')).toEqual([{ asset: 'sfx_door', volume: 1, cause: 'interact:door' }]);
  });
});

describe('Interactable: scripts', () => {
  it('onInteract gets the actor; game.interact checks tags and range; nearbyInteractables lists what is in reach', () => {
    const doorScript = `function onInteract(self, by, game, info) {
      game.vars.log = (game.vars.log || '') + info.action + ':' + info.via + ':' + (by ? by.id : 'mouse') + ' ';
    }`;
    const npcScript = `function onUpdate(self, game) {
      if (game.frame !== 2) return;
      game.vars.near = game.nearbyInteractables(self).map((n) => n.id + '@' + n.distance).join(',');
      const far = game.interact('door', self);
      self.x = 230;
      const asNpc = game.interact('door', 'npc');
      const ok = game.interact('door', self.id === 'npc' ? undefined : self);
      game.vars.results = [far.reason, asNpc.ok, ok.ok].join(',');
    }`;
    const g = game(
      [
        { id: 'npc', tags: ['npc'], transform: { x: 300, y: 150 }, components: { Sprite: { width: 20, height: 20 }, Script: { src: 'scripts/npc.js' } } },
        door({ actorTags: ['npc'] }, { components: { Script: { src: 'scripts/door.js' } } }),
      ],
      { scripts: { 'scripts/door.js': doorScript, 'scripts/npc.js': npcScript } },
    );
    g.step(4);
    expect(g.world.vars.near).toBe(''); // gap 70 > 32
    expect(g.world.vars.results).toBe('range,true,true');
    expect(g.world.vars.log).toBe('open:script:npc open:script:mouse ');
    g.perform([{ type: 'click', entity: 'door' }]);
    expect(g.world.vars.log).toBe('open:script:npc open:script:mouse open:click:mouse ');
    expect(g.getState({ ids: ['door'] }).entities[0].interactable!.uses).toBe(3);
  });

  it('an onInteract that interacts with itself is stopped and reported', () => {
    const g = game([door({}, { components: { Script: { src: 'scripts/loop.js' } } })], {
      scripts: { 'scripts/loop.js': "function onInteract(self, by, game) { game.interact('door'); }" },
    });
    g.perform([{ type: 'click', entity: 'door' }]);
    expect(g.status).toBe('running');
    expect(g.events(0, 'script_error')[0].message).toMatch(/nested too deeply/);
  });
});

describe('Interactable: observation and determinism', () => {
  it('expressions see the interactable state', async () => {
    const { evaluateExpr } = await import('../src');
    const g = game([player(160), door({ cooldownMs: 1000 })]);
    g.perform([{ type: 'tap', key: 'E' }]);
    expect(evaluateExpr("entity('door').interactable.uses == 1 && entity('door').interactable.cooldownMs > 0", { game: g }).value).toBe(true);
    expect(evaluateExpr("events('interact')", { game: g }).value).toBe(1);
  });

  it('replaying the same ops gives the same interactions', () => {
    const make = () => game([player(100, { Body: { type: 'kinematic', vx: 60 } }), door({ cooldownMs: 200 })]);
    const ops: GameOp[] = [];
    const a = make();
    for (let i = 0; i < 12; i++) {
      for (const op of a.expand(i % 3 === 0 ? { type: 'click', entity: 'door' } : { type: 'tap', key: 'E' })) {
        ops.push(op);
        a.apply(op);
      }
      ops.push({ op: 'step', frames: 7 });
      a.apply({ op: 'step', frames: 7 });
    }
    const b = make();
    for (const op of ops) b.apply(op);
    expect(b.events()).toEqual(a.events());
    expect(a.events(0, 'interact').length).toBeGreaterThan(2);
    expect(a.events(0, 'interact_blocked').length).toBeGreaterThan(0);
  });
});
