import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { ground, GROUND_TOP, player, trigger } from './helpers';

const GOOMBA = {
  tags: ['enemy'],
  components: { Sprite: { width: 28, height: 24, color: '#aa5500' }, Body: {}, Collider: { width: 28, height: 24 }, Patrol: { speed: 40 }, Damage: {}, Stompable: {} },
};

function game(entities: EntityInput[], extra: Record<string, unknown> = {}) {
  return Game.fromRaw({
    config: { name: 't', startScene: 'main' },
    scenes: { main: { id: 'main', width: 3000, entities, ...(extra.scene as object) } },
    prefabs: { goomba: GOOMBA, coin: { tags: ['coin'], components: { Collider: { width: 16, height: 16, isTrigger: true }, Collectible: {} } } },
    ...(extra.scripts ? { scripts: extra.scripts } : {}),
  });
}

describe('prefabs', () => {
  it('instances take the prefab and override only what they set', () => {
    const g = game([
      ground('g', 0, 2000),
      { id: 'e1', prefab: 'goomba', transform: { x: 400, y: GROUND_TOP - 12 } },
      { id: 'e2', prefab: 'goomba', transform: { x: 800, y: GROUND_TOP - 12 }, components: { Patrol: { speed: 120 }, Stompable: null } } as unknown as EntityInput,
    ]);
    const e1 = g.entity('e1')!;
    const e2 = g.entity('e2')!;
    expect(e1.tags.has('enemy')).toBe(true);
    expect(e1.components.Patrol!.speed).toBe(40);
    expect(e1.components.Sprite!.color).toBe('#aa5500');
    expect(e2.components.Patrol!.speed).toBe(120); // merged
    expect(e2.components.Stompable).toBeUndefined(); // null removes
    expect(e2.components.Damage).toBeDefined();
  });

  it('rejects unknown prefabs', () => {
    expect(() => game([{ id: 'x', prefab: 'nope' }])).toThrow(/scenes\.main\.entities\(x\)\.prefab: prefab "nope" does not exist/);
  });

  it('rules and scripts spawn prefabs at runtime', () => {
    const g = game(
      [
        player(),
        ground('g', 0, 2000),
        trigger('zone', 300, GROUND_TOP - 40, {}, 40, 80),
        { id: 'spawner', components: { Script: { src: 'scripts/spawner.js' } } },
      ],
      {
        scene: {
          rules: [
            { id: 'ambush', when: { enter: 'zone' }, once: true, do: [{ action: 'spawn', prefab: 'goomba', at: '$by', x: 200, y: 0, id: 'ambusher' }] },
          ],
        },
        scripts: {
          'scripts/spawner.js': `function onStart(self, game) {
            for (let i = 0; i < 3; i++) game.spawn('coin', 150 + i * 30, ${GROUND_TOP - 16});
          }`,
        },
      },
    );
    g.step(1);
    expect(g.getState({ tags: ['coin'] }).entities.map((e) => e.id)).toEqual(['coin1', 'coin2', 'coin3']);
    g.perform([{ type: 'hold', key: 'D', ms: 1200 }]);
    expect(g.world.vars.coins).toBe(3); // spawned coins work like scene coins
    const ambusher = g.entity('ambusher')!;
    expect(ambusher.components.Patrol).toBeDefined();
    const spawn = g.events(0, 'spawn').find((e) => e.entity === 'ambusher')!;
    expect(spawn.prefab).toBe('goomba');
    expect(spawn.x).toBeGreaterThan(450); // 200 px ahead of the player when it entered
    g.restart();
    expect(g.entity('ambusher')).toBeUndefined(); // spawned entities are not part of the scene
  });
});
