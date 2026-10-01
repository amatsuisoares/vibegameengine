import type { EntityInput, SceneInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { ground, GROUND_TOP, player, trigger } from './helpers';

type Rules = SceneInput['rules'];

function withRules(entities: EntityInput[], rules: Rules, vars: Record<string, number | string | boolean> = {}) {
  return Game.fromRaw({ config: { name: 'test', startScene: 'main' }, scenes: { main: { id: 'main', width: 3000, vars, entities, rules } } });
}

const coin = (id: string, x: number) => trigger(id, x, GROUND_TOP - 16, { Collectible: {} }, 16, 16);
const door = (enabled = true): EntityInput => ({
  id: 'door',
  enabled,
  transform: { x: 400, y: GROUND_TOP - 40 },
  components: { Sprite: { width: 16, height: 80 }, Collider: { width: 16, height: 80 } },
});
const hud: EntityInput = { id: 'msg', transform: { x: 10, y: 10 }, components: { Text: { text: '' } } };
const rules = (g: Game) => g.events(0, 'rule').map((e) => e.rule);

describe('scene rules', () => {
  it('opens a door when the coin count reaches 2 (expr trigger fires once, on the edge)', () => {
    const game = withRules([player(), ground('g', 0, 1000), coin('c1', 150), coin('c2', 200), door()], [
      { id: 'open', when: { expr: 'vars.coins >= 2' }, do: [{ action: 'setEnabled', target: 'door', enabled: false }, { action: 'emit', event: 'door_opened' }] },
    ]);
    game.perform([{ type: 'hold', key: 'D', ms: 600 }]);
    expect(game.world.vars.coins).toBe(2);
    expect(game.entity('door')!.enabled).toBe(false);
    game.perform([{ type: 'hold', key: 'D', ms: 1500 }]);
    expect(game.entity('player')!.x).toBeGreaterThan(420); // walked through the open door
    expect(rules(game)).toEqual(['open']);
    expect(game.events(0, 'door_opened')).toHaveLength(1);
  });

  it('reacts to zones (enter), with $by, conditions and once', () => {
    const game = withRules(
      [player(), ground('g', 0, 2000), trigger('zone', 300, GROUND_TOP - 40, {}, 40, 80), hud],
      [
        { id: 'hello', when: { enter: 'zone' }, do: [{ action: 'setText', target: 'msg', text: 'Bem-vindo!' }, { action: 'damage', target: '$by' }] },
        { id: 'rich', when: { enter: 'zone' }, if: 'vars.coins > 0', do: [{ action: 'win' }] },
        { id: 'first', when: { enter: 'zone' }, once: true, do: [{ action: 'addVar', var: 'visits', amount: 1 }] },
      ],
    );
    game.perform([{ type: 'hold', key: 'D', ms: 1500 }]);
    expect(game.entity('msg')!.components.Text!.text).toBe('Bem-vindo!');
    expect(game.entity('player')!.health).toBe(2);
    expect(game.status).toBe('running'); // "rich" condition was false
    expect(game.world.vars.visits).toBe(1);
    game.perform([{ type: 'hold', key: 'A', ms: 1500 }, { type: 'hold', key: 'D', ms: 1500 }]);
    expect(game.world.vars.visits).toBe(1); // once
    expect(rules(game).filter((r) => r === 'hello')).toHaveLength(3); // right, back left, right again
  });

  it('chains events (custom events emitted by rules fire other rules), start and timers', () => {
    const game = withRules([player(), ground('g', 0, 1000), coin('c1', 150), hud], [
      { id: 'intro', when: { start: true }, do: [{ action: 'setText', target: 'msg', text: 'Go!' }, { action: 'setVar', var: 'phase', value: 'play' }] },
      // $by = the collector ("by" of the collect event)
      { id: 'got', when: { event: 'collect', match: { entity: 'c1' } }, do: [{ action: 'emit', event: 'bonus' }, { action: 'modify', target: '$by', component: 'Sprite', set: { color: '#00ff00' } }] },
      { id: 'bonus', when: { event: 'bonus' }, do: [{ action: 'addVar', var: 'score', amount: 50 }] },
      { id: 'tick', when: { every: 500 }, do: [{ action: 'addVar', var: 'ticks', amount: 1 }] },
    ]);
    game.step(1);
    expect(game.world.vars.phase).toBe('play');
    expect(game.entity('msg')!.components.Text!.text).toBe('Go!');
    game.perform([{ type: 'hold', key: 'D', ms: 1000 }]);
    expect(game.world.vars.score).toBe(50); // from the chained "bonus" event
    expect(game.entity('player')!.components.Sprite!.color).toBe('#00ff00');
    expect(game.world.vars.ticks).toBe(2);
    expect(rules(game)).toEqual(['intro', 'got', 'bonus', 'tick', 'tick']); // bonus: the frame after got
    expect(game.events(0, 'rule_error')).toEqual([]);
  });

  it('reports and disables a failing rule without stopping the game', () => {
    const game = withRules([player(), ground('g', 0, 1000), hud], [
      { id: 'bad', when: { every: 100 }, do: [{ action: 'modify', target: 'player', component: 'Text', set: { text: 'x' } }] },
      { id: 'badExpr', when: { expr: "entity('player').x > ghost" }, do: [{ action: 'win' }] },
    ]);
    game.step(30);
    expect(game.status).toBe('running');
    const errs = game.console.read(0, 'error').map((e) => e.message);
    expect(errs).toHaveLength(2);
    expect(errs[0]).toMatch(/Rule "badExpr": expression .*: /);
    expect(errs[1]).toMatch(/Rule "bad": entity "player" has no Text component/);
    expect(game.events(0, 'rule_error').map((e) => e.rule)).toEqual(['badExpr', 'bad']);
  });

  it('validates rule references', () => {
    const bad = () =>
      withRules([player()], [
        { id: 'r', when: { enter: 'nozone' }, do: [{ action: 'destroy', target: 'ghost' }, { action: 'loadScene', scene: 'level9' }] },
        { id: 'r', when: { start: true }, do: [{ action: 'destroy', target: '$by' }] },
      ]);
    expect(bad).toThrow(/rules\(r\)\.when\.enter: entity "nozone" does not exist/);
    expect(bad).toThrow(/rules\(r\)\.do\[0\]\.target: entity "ghost" does not exist/);
    expect(bad).toThrow(/rules\(r\)\.do\[1\]\.scene: scene "level9" does not exist/);
    expect(bad).toThrow(/duplicate rule id "r"/);
    expect(bad).toThrow(/"\$by" only works with "enter" and "event" triggers/);
  });
});
