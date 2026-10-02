import { describe, expect, it } from 'vitest';
import { Game, MAX_SLOTS, type SaveSlot } from '../src';
import { ground, player } from './helpers';

type Raw = Record<string, any>;

function project(): Raw {
  return {
    config: { name: 'slots', startScene: 'main' },
    scripts: {
      'scripts/saver.js': `function onUpdate(self, game) {
  if (game.frame === 5) game.saveSlot('auto', 'Automático');
  if (game.frame === 6) game.storage.set('seen', game.listSlots().map((s) => s.name + ':' + s.scene + ':' + (s.label || '')));
}`,
    },
    scenes: {
      main: {
        id: 'main',
        width: 3000,
        vars: { coins: 0 },
        entities: [
          ground('floor', 0, 3000),
          player(100),
          { id: 'coin', transform: { x: 160, y: 402 }, components: { Collider: { width: 16, height: 16, isTrigger: true }, Collectible: {} } },
          { id: 'lamp', transform: { x: 500, y: 300 }, components: { StateMachine: { initial: 'off', states: { off: {}, on: {} } } } },
        ],
      },
      cave: { id: 'cave', entities: [player(40)] },
    },
  };
}

const walk = (g: Game, frames: number) => {
  g.apply({ op: 'keyDown', key: 'ArrowRight' });
  g.step(frames);
  g.apply({ op: 'keyUp', key: 'ArrowRight' });
};

describe('save slots', () => {
  it('saves the running game and its storage, and loads it back (time keeps going forward)', () => {
    const g = Game.fromRaw(project());
    walk(g, 40);
    g.step(20);
    g.storage.set('lives', 2);
    g.entity('lamp')!.fsm = { state: 'on', previous: 'off', since: g.frame - 30 };
    const saved = { x: g.entity('player')!.x, frame: g.frame };
    g.saveSlot('s1', 'Fase 1');
    expect(g.events(0, 'slot_saved')).toMatchObject([{ slot: 's1' }]);
    expect(g.listSlots()).toEqual([{ name: 's1', label: 'Fase 1', savedAt: g.clock.now, scene: 'main' }]);
    expect(g.getState().slots).toHaveLength(1);

    // Play on: more progress, then load.
    walk(g, 60);
    g.storage.set('lives', 0);
    g.entity('lamp')!.fsm = { state: 'off', previous: 'on', since: g.frame };
    expect(g.loadSlot('s1')).toBe(true);
    // Loading waits for the end of the frame.
    expect(g.entity('player')!.x).not.toBe(saved.x);
    const before = g.frame;
    g.step(1);
    expect(g.frame).toBe(before + 1);
    expect(g.entity('player')!.x).toBeCloseTo(saved.x, 0);
    expect(g.world.vars.coins).toBe(1);
    expect(g.entity('coin')).toBeUndefined();
    expect(g.storage.get('lives')).toBe(2);
    const lamp = g.getState({ ids: ['lamp'] }).entities[0];
    expect(lamp.state).toBe('on');
    // Time in state as when it was saved (30 frames = 500 ms), shifted to the new frame.
    expect(lamp.stateMs).toBe(500);
    expect(g.events(0, 'slot_loaded')).toMatchObject([{ slot: 's1', scene: 'main' }]);
    expect(g.loadSlot('nope')).toBe(false);
  });

  it('goes back to the scene of the slot', () => {
    const g = Game.fromRaw(project());
    g.loadScene('cave');
    g.step(2);
    g.saveSlot('caverna');
    g.loadScene('main');
    g.step(2);
    g.loadSlot('caverna');
    g.step(1);
    expect(g.world.scene.id).toBe('cave');
  });

  it('is reachable from scripts, rules and expressions', () => {
    const raw = project();
    raw.scenes.main.entities.push({ id: 'saver', components: { Script: { src: 'scripts/saver.js' } } });
    raw.scenes.main.rules = [
      { id: 'save', when: { expr: 'vars.coins >= 1' }, do: [{ action: 'saveSlot', slot: 'coin', label: 'Moeda' }] },
      { id: 'load', when: { event: 'reload' }, if: "hasSlot('coin')", do: [{ action: 'loadSlot', slot: 'coin' }] },
      { id: 'missing', when: { event: 'reload' }, do: [{ action: 'loadSlot', slot: 'ghost' }] },
      { id: 'drop', when: { event: 'drop' }, do: [{ action: 'deleteSlot', slot: 'auto' }] },
    ];
    const g = Game.fromRaw(raw);
    g.step(8);
    expect(g.storage.get('seen')).toEqual(['auto:main:Automático']);
    walk(g, 40);
    expect(g.listSlots().map((s) => s.name)).toEqual(['auto', 'coin']);
    g.world.emit('reload');
    g.step(1);
    expect(g.events(0, 'slot_loaded')).toMatchObject([{ slot: 'coin' }]);
    expect(g.console.read().some((e) => e.message.includes('loadSlot: slot "ghost" does not exist'))).toBe(true);
    g.world.emit('drop');
    g.step(1);
    expect(g.listSlots().map((s) => s.name)).toEqual(['coin']);
  });

  it('persists through the host: slots survive in a new game, where file edits win', () => {
    let stored: Record<string, SaveSlot> = {};
    const g = Game.fromRaw(project(), { onSlotsChange: (s) => (stored = s) });
    walk(g, 40);
    g.saveSlot('s1');
    const x = g.entity('player')!.x;
    const json = JSON.parse(JSON.stringify(stored));

    const raw = project();
    raw.scenes.main.entities[3].transform.x = 600; // the lamp was moved in the files since
    const next = Game.fromRaw(raw, { slots: json });
    expect(next.listSlots().map((s) => s.name)).toEqual(['s1']);
    next.loadSlot('s1');
    next.step(1);
    expect(next.entity('player')!.x).toBeCloseTo(x, 0);
    expect(next.entity('lamp')!.x).toBe(600);
    expect(next.world.vars.coins).toBe(1);
  });

  it('validates names, limits the number of slots and resets on restart', () => {
    const g = Game.fromRaw(project(), { slots: {} });
    expect(() => g.saveSlot('bad name')).toThrow(/invalid slot name/);
    for (let i = 0; i < MAX_SLOTS; i++) g.saveSlot(`s${i}`);
    expect(() => g.saveSlot('one-more')).toThrow(/too many save slots/);
    g.saveSlot('s0', 'overwrite is fine');
    expect(g.deleteSlot('s1')).toBe(true);
    expect(g.deleteSlot('s1')).toBe(false);
    g.restart();
    expect(g.listSlots()).toEqual([]);
  });

  it('is deterministic: the same play and load give the same game', () => {
    const play = () => {
      const g = Game.fromRaw(project(), { seed: 9 });
      walk(g, 30);
      g.saveSlot('a');
      walk(g, 50);
      g.loadSlot('a');
      g.step(30);
      return g.getState().entities.map((e) => [e.id, e.x, e.y, e.vx]);
    };
    expect(play()).toEqual(play());
  });
});
