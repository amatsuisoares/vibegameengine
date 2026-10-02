import { describe, expect, it } from 'vitest';
import { captureHotState, describeHotRestore, Game, merge3, restoreHotState, type HotState } from '../src';
import { ground, player, readProjectDir } from './helpers';

type Raw = Record<string, any>;

/** A small project: player, a coin, an enemy with health, a state machine, rules and a prefab. */
function project(): Raw {
  return {
    config: { name: 'hot', startScene: 'main' },
    prefabs: { spark: { tags: ['spark'], components: { Sprite: { width: 4, height: 4, color: '#ff0000' } } } },
    scenes: {
      main: {
        id: 'main',
        width: 3000,
        vars: { coins: 0, lives: 3 },
        entities: [
          ground('floor', 0, 3000),
          player(100),
          { id: 'coin', tags: ['coin'], transform: { x: 160, y: 402 }, components: { Sprite: { width: 16, height: 16 }, Collider: { width: 16, height: 16, isTrigger: true }, Collectible: {} } },
          {
            id: 'lamp',
            transform: { x: 500, y: 300 },
            components: {
              Sprite: { width: 10, height: 10, color: '#888888' },
              Health: { max: 5 },
              StateMachine: { initial: 'off', states: { off: {}, on: {} } },
            },
          },
        ],
        rules: [
          { id: 'hello', when: { start: true }, do: [{ action: 'addVar', var: 'starts', amount: 1 }] },
          { id: 'rich', when: { expr: 'vars.coins >= 1' }, do: [{ action: 'addVar', var: 'richEdges', amount: 1 }] },
        ],
      },
      other: { id: 'other', entities: [player(50)] },
    },
  };
}

/** Plays a bit: the player walks right over the coin, the lamp is hurt and switched on, a spark spawns. */
function played(raw: Raw = project()) {
  const game = Game.fromRaw(raw, { seed: 7 });
  game.apply({ op: 'keyDown', key: 'ArrowRight' });
  game.step(40);
  game.apply({ op: 'keyUp', key: 'ArrowRight' });
  game.step(20);
  const lamp = game.entity('lamp')!;
  lamp.components.Health!.current = 2;
  lamp.fsm = { state: 'on', previous: 'off', since: game.frame };
  game.world.spawn('spark', 700, 200);
  game.world.rng.next();
  return game;
}

function reload(game: Game, raw: Raw, state?: HotState) {
  const s = state ?? captureHotState(game);
  const next = Game.fromRaw(raw, { seed: 7 });
  return { next, report: restoreHotState(next, s) };
}

describe('hot reload state', () => {
  it('merges three ways: running values where the files did not change, edits where they did', () => {
    expect(merge3(1, 1, 5)).toBe(5);
    expect(merge3(1, 2, 5)).toBe(2);
    expect(merge3({ a: 1, b: 1, gone: 1 }, { a: 1, b: 2, added: 0 }, { a: 7, b: 7, gone: 7, runtime: 7 })).toEqual({ a: 7, b: 2, added: 0, runtime: 7 });
    expect(merge3([1], [1, 2], [9])).toEqual([1, 2]);
  });

  it('keeps the running game when nothing changed (and plays on identically)', () => {
    const game = played();
    expect(game.world.vars.coins).toBe(1);
    const state = JSON.parse(JSON.stringify(captureHotState(game))) as HotState;
    const { next, report } = reload(game, project(), state);
    expect(report).toMatchObject({ scene: 'main', kept: 3, edited: [], added: [], removed: [], destroyed: ['coin'], spawned: 1 });
    expect(next.frame).toBe(game.frame);
    expect(next.entity('coin')).toBeUndefined();
    expect(next.entity('spark1')).toBeDefined();
    expect(next.world.vars).toEqual(game.world.vars);
    expect(next.entity('lamp')!.components.Health!.current).toBe(2);
    expect(next.getState({ ids: ['lamp'] }).entities[0].state).toBe('on');
    expect(next.world.rng.next()).toBe(game.world.rng.next());

    // Same state, same simulation afterwards; start and expression rules do not fire again.
    game.step(30);
    next.step(30);
    const pick = (g: Game) => g.getState().entities.map((e) => [e.id, e.x, e.y, e.vx]);
    expect(pick(next)).toEqual(pick(game));
    expect(next.world.vars).toMatchObject({ starts: 1, richEdges: 1 });
  });

  it('lets file edits win over the running values, field by field', () => {
    const game = played();
    const playerX = game.entity('player')!.x;
    const raw = project();
    const lamp = raw.scenes.main.entities[3];
    lamp.transform.x = 520; // moved in the viewport
    lamp.components.Sprite.color = '#ffff00'; // edited in the inspector
    raw.scenes.main.vars.lives = 5; // edited default
    raw.scenes.main.vars.bonus = 1; // new variable
    const { next, report } = reload(game, raw);
    expect(report.edited).toEqual(['lamp']);
    const l = next.entity('lamp')!;
    expect([l.x, l.y]).toEqual([520, 300]);
    expect(l.components.Sprite!.color).toBe('#ffff00');
    // Untouched values of the edited entity keep running.
    expect(l.components.Health!.current).toBe(2);
    expect(next.entity('player')!.x).toBe(playerX);
    expect(next.world.vars).toMatchObject({ coins: 1, lives: 5, bonus: 1 });
  });

  it('adds new entities, removes deleted ones and rebuilds spawned ones from their prefab', () => {
    const game = played();
    const raw = project();
    raw.scenes.main.entities.splice(3, 1); // lamp deleted
    raw.scenes.main.entities.push({ id: 'tree', transform: { x: 50, y: 50 }, components: { Sprite: {} } });
    raw.prefabs.spark.components.Sprite.color = '#00ff00';
    let { next, report } = reload(game, raw);
    expect(report).toMatchObject({ added: ['tree'], removed: ['lamp'], spawned: 1 });
    expect(next.entity('lamp')).toBeUndefined();
    const spark = next.entity('spark1')!;
    expect([spark.x, spark.y, spark.components.Sprite!.color]).toEqual([700, 200, '#00ff00']);

    delete raw.prefabs.spark;
    ({ next, report } = reload(game, raw));
    expect(report.droppedSpawned).toEqual(['spark1']);
    expect(next.entity('spark1')).toBeUndefined();
  });

  it('goes back to the scene that was running, or reports that it is gone', () => {
    const game = Game.fromRaw(project());
    game.loadScene('other');
    game.step(2);
    const { next, report } = reload(game, project());
    expect(report.scene).toBe('other');
    expect(next.world.scene.id).toBe('other');

    const raw = project();
    delete raw.scenes.other;
    const gone = reload(game, raw);
    expect(gone.report).toMatchObject({ sceneMissing: 'other', scene: 'main' });
    expect(describeHotRestore(gone.report)).toMatch(/no longer exists/);
  });

  it('keeps a state machine state only while the state exists', () => {
    const game = played();
    const raw = project();
    raw.scenes.main.entities[3].components.StateMachine.states = { off: {}, broken: {} };
    const { next } = reload(game, raw);
    expect(next.getState({ ids: ['lamp'] }).entities[0].state).toBe('off');
  });

  it('works on the demo platformer: progress survives an edit', () => {
    const raw = readProjectDir(new URL('../../../test-fixtures/demo-platformer', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) as Raw;
    const game = Game.fromRaw(raw, { seed: 3 });
    game.apply({ op: 'keyDown', key: 'ArrowRight' });
    game.step(120);
    const x = game.entity('player')!.x;
    raw.scenes.level1.entities.find((e: Raw) => e.id === 'coin2').transform.x = 1000;
    const { next, report } = reload(game, raw);
    expect(next.entity('player')!.x).toBe(x);
    expect(next.entity('coin2')!.x).toBe(1000);
    expect(report.edited).toEqual(['coin2']);
    expect(describeHotRestore(report)).toMatch(/^Hot reload: state kept in "level1" \(\d+ entities\); edited: coin2/);
  });
});
