import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('animation through the agent tools', () => {
  it('shows the clip and frame in the state; frame events appear in the observations', async () => {
    const { ok, fail } = setup();
    await ok('create_game_object', {
      scene: 'level1',
      entity: {
        id: 'torch',
        transform: { x: 200, y: 300 },
        components: { Sprite: {}, Animator: { initial: 'burn', animations: { burn: { frames: [0, 1, 2], fps: 6, events: { '2': 'crackle' } } } } },
      },
    });
    await ok('run_game');
    const r = await ok<{ events: { type: string; entity?: string; frame?: number }[] }>('wait', { ms: 1000 });
    expect(r.events.filter((e) => e.type === 'crackle')).toEqual([expect.objectContaining({ entity: 'torch', frame: 2 }), expect.objectContaining({ frame: 2 })]);
    const s = await ok<{ entities: { anim?: { clip: string; frame: number } }[] }>('inspect_game_state', { ids: ['torch'] });
    expect(s.entities[0].anim).toEqual({ clip: 'burn', frame: 0 });
    const bad = await fail('modify_component', { scene: 'level1', id: 'torch', type: 'Animator', patch: { animations: { burn: { next: 'ash' } } } });
    expect(bad.details?.[0]).toContain('Animator.animations.burn.next: animation "ash" does not exist');
  });
});
