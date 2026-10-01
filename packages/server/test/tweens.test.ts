import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('tweens through the agent tools', () => {
  it('a rule tweens on an event; the agent sees the tween running and its end', async () => {
    const { ok } = setup();
    await ok('create_game_object', { scene: 'level1', entity: { id: 'sign', transform: { x: 200, y: 300 }, components: { Sprite: {} } } });
    await ok('set_rule', {
      scene: 'level1',
      rule: { id: 'float', when: { start: true }, do: [{ action: 'tween', target: 'sign', prop: 'y', to: 280, ms: 1000, yoyo: true, repeat: -1, ease: 'easeInOut' }] },
    });
    await ok('run_game');
    await ok('wait', { ms: 500 });
    const s = await ok<{ entities: { y: number; tweens?: unknown }[] }>('inspect_game_state', { ids: ['sign'] });
    expect(s.entities[0].tweens).toEqual([{ id: 'tween1', prop: 'y', to: 280 }]);
    expect(s.entities[0].y).toBeCloseTo(290, 0);
  });
});
