import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type Obs = { events: { type: string; entity?: string; drop?: string | null; clicks?: number }[] };

describe('mouse control tools', () => {
  it('move over an entity, press/release, drag between points and entities, double click', async () => {
    const { ok, fail } = setup();
    await ok('modify_game_object', { scene: 'level1', id: 'coin1', patch: { tags: ['coin', 'draggable', 'clickable'] } });
    await ok('run_game');

    const moved = await ok<{ mouse: { x: number; y: number } }>('move_mouse', { entity: 'coin1' });
    expect(moved.mouse).toMatchObject({ x: 400, y: 390 });
    expect((await ok<{ target: { id: string } }>('get_mouse_target')).target.id).toBe('coin1');

    const dbl = await ok<Obs>('click_mouse', { entity: 'coin1', double: true });
    expect(dbl.events.filter((e) => e.type === 'click').map((e) => e.clicks ?? 1)).toEqual([1, 2]);

    const drag = await ok<Obs>('drag_mouse', { from: { entity: 'coin1' }, to: { x: 300, y: 300 }, ms: 200 });
    expect(drag.events.filter((e) => e.type.startsWith('drag_'))).toEqual([
      expect.objectContaining({ type: 'drag_start', entity: 'coin1' }),
      expect.objectContaining({ type: 'drag_end', entity: 'coin1', drop: null }),
    ]);
    const coin = await ok<{ entities: { x: number; y: number }[] }>('inspect_game_state', { ids: ['coin1'] });
    expect(coin.entities[0]).toMatchObject({ x: 300, y: 300 });

    // Press and release by hand: the mouse state shows the held button.
    expect(await ok('press_mouse', { x: 300, y: 300 })).toEqual({ mouse: { x: 300, y: 300, buttons: ['left'] } });
    await ok('move_mouse', { x: 350, y: 300 });
    await ok('wait', { ms: 100 });
    expect((await ok<{ drag: { entity: string } }>('get_mouse_target')).drag.entity).toBe('coin1');
    expect(await ok('release_mouse', {})).toEqual({ mouse: { x: 350, y: 300, buttons: [] } });

    expect((await fail('move_mouse', { x: 3 })).error).toBe('Give x and y, or entity');
    expect((await fail('drag_mouse', { from: { x: 1 }, to: { entity: 'coin1' } })).error).toBe('from: give x and y, or entity');
  });
});
