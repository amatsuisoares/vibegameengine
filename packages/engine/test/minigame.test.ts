import { describe, expect, it } from 'vitest';
import { captureHotState, Game, restoreHotState } from '../src';

type Raw = Record<string, any>;

/**
 * A town with a chest the player moved and a counter; a "fishing" minigame scene whose script reads its
 * params and ends with a result; the town's script turns the result into coins.
 */
function project(extra: { townRules?: unknown[]; fishRules?: unknown[] } = {}): Raw {
  return {
    config: { name: 'mg', startScene: 'town', gravity: 0, width: 400, height: 300 },
    scenes: {
      town: {
        id: 'town',
        vars: { visits: 0 },
        entities: [
          { id: 'chest', transform: { x: 50, y: 50 }, components: { Sprite: { width: 20, height: 20 } } },
          { id: 'keeper', transform: { x: 0, y: 0 }, components: { Script: { src: 'scripts/keeper.js' } } },
        ],
        rules: extra.townRules ?? [],
      },
      fishing: {
        id: 'fishing',
        entities: [{ id: 'rod', transform: { x: 200, y: 150 }, components: { Sprite: {}, Script: { src: 'scripts/rod.js' } } }],
        rules: extra.fishRules ?? [],
      },
    },
    scripts: {
      'scripts/keeper.js': `
        function onStart(self, game) { game.vars.starts = (game.vars.starts || 0) + 1; }
        function onEvent(self, ev, game) {
          if (ev.type === 'minigame_end' && ev.scene === 'fishing') game.vars.coins = (game.vars.coins || 0) + ev.result.fish * ev.params.prize;
        }`,
      'scripts/rod.js': `
        function onStart(self, game) { self.state.seen = game.minigame; game.vars.prize = game.minigame ? game.minigame.params.prize : -1; }
        function onClick(self, game) { game.endMinigame({ fish: 3 }); }`,
    },
  };
}

const fresh = (extra?: Parameters<typeof project>[0]) => Game.fromRaw(project(extra), { seed: 3 });

describe('Minigames (startMinigame / endMinigame)', () => {
  it('opens a scene with params and comes back to the caller exactly as it was, with the result in minigame_end', () => {
    const g = fresh();
    g.step(2);
    g.entity('chest')!.x = 120; // the player moved things around
    g.world.vars.visits = 4;
    g.startMinigame('fishing', { prize: 5 });
    expect(g.world.scene.id).toBe('town'); // at the end of the frame, like loadScene
    expect(g.events(0, 'minigame_start')[0]).toMatchObject({ scene: 'fishing', from: 'town', params: { prize: 5 } });
    g.step(2);
    expect(g.world.scene.id).toBe('fishing');
    expect(g.world.vars.prize).toBe(5);
    expect(g.getState().minigame).toEqual({ scene: 'fishing', from: 'town', params: { prize: 5 } });

    g.step(30);
    g.perform([{ type: 'click', entity: 'rod' }, { type: 'wait', ms: 50 }]);
    expect(g.world.scene.id).toBe('town');
    expect(g.entity('chest')!.x).toBe(120); // the caller came back as it was
    expect(g.world.vars.visits).toBe(4);
    expect(g.world.vars.coins).toBe(15); // its script got the result (3 fish × prize 5)
    expect(g.world.vars.starts).toBe(2); // scripts start again, like after a hot reload
    expect(g.events(0, 'minigame_end')[0]).toMatchObject({ scene: 'fishing', from: 'town', params: { prize: 5 }, result: { fish: 3 } });
    expect(g.events(0, 'minigame_end')[0].ms).toBeGreaterThan(500);
    expect(g.getState().minigame).toBeUndefined();
    expect(g.console.read(0, 'error')).toEqual([]);
  });

  it('checks its arguments: unknown scene, already in a minigame, not in one, non-JSON params', () => {
    const g = fresh();
    expect(() => g.startMinigame('nope')).toThrow(/does not exist/);
    expect(() => g.startMinigame('town')).toThrow(/current scene/);
    expect(() => g.endMinigame()).toThrow(/no minigame/);
    expect(() => g.startMinigame('fishing', { f: () => 1 } as never)).not.toThrow(); // functions are dropped by JSON
    expect(() => g.startMinigame('fishing')).toThrow(/already running/);
    g.step(1);
    expect(() => g.startMinigame('town')).toThrow(/already running/);
    const big = Game.fromRaw(project(), { seed: 3 });
    expect(() => big.startMinigame('fishing', { s: 'x'.repeat(70_000) })).toThrow(/too big/);
  });

  it('rule actions: startMinigame from the caller and endMinigame in the minigame (result for rules too)', () => {
    const g = fresh({
      townRules: [
        { id: 'go', when: { event: 'fish' }, do: [{ action: 'startMinigame', scene: 'fishing', params: { prize: 2 } }] },
        { id: 'back', when: { event: 'minigame_end' }, do: [{ action: 'addVar', var: 'returns', amount: 1 }] },
      ],
      fishRules: [{ id: 'done', when: { every: 500 }, do: [{ action: 'endMinigame', result: { fish: 1 } }] }],
    });
    g.step(1);
    g.world.emit('fish');
    g.step(2);
    expect(g.world.scene.id).toBe('fishing');
    g.advance(600);
    expect(g.world.scene.id).toBe('town');
    expect(g.world.vars.returns).toBe(1);
    expect(g.world.vars.coins).toBe(2);
  });

  it('hot reload and save slots keep the call: the minigame can still end and go back', () => {
    const g = fresh();
    g.step(1);
    g.entity('chest')!.x = 77;
    g.startMinigame('fishing', { prize: 1 });
    g.step(2);
    // A hot reload rebuilds the game from the files and restores the running state.
    const state = JSON.parse(JSON.stringify(captureHotState(g)));
    const next = fresh();
    restoreHotState(next, state);
    expect(next.world.scene.id).toBe('fishing');
    expect(next.minigame).toEqual({ scene: 'fishing', from: 'town', params: { prize: 1 } });
    next.saveSlot('mid');
    next.endMinigame({ fish: 2 });
    next.step(2); // back at the end of the frame; the caller's scripts see minigame_end in the next one
    expect(next.world.scene.id).toBe('town');
    expect(next.entity('chest')!.x).toBe(77);
    expect(next.world.vars.coins).toBe(2);
    // A slot saved during the minigame brings the call back too.
    next.loadSlot('mid');
    next.step(1);
    expect(next.world.scene.id).toBe('fishing');
    expect(next.minigame?.from).toBe('town');
    next.restart();
    expect(next.minigame).toBeNull();
  });
});
