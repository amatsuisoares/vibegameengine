import { describe, expect, it } from 'vitest';
import { setupWithShots } from './helpers';

type Obs = {
  game: { frame: number; status: string; scene: string; clock: string; vars: Record<string, unknown> };
  players?: { id: string; x: number }[];
  entities?: { id: string; screen?: { x: number; y: number; w: number; h: number } }[];
  entityCount?: number;
  input: { keysDown: string[]; mouse: { x: number; y: number; world: { x: number; y: number }; buttons: string[]; hovered?: string | null; target?: string | null } };
  camera: { x: number; y: number };
  events: { type: string }[];
  console: unknown[];
  screenshot?: { path?: string; frame?: number; error?: string };
  images?: { path: string }[];
};

describe('observe', () => {
  it('returns state, players, on-screen entities, input, camera, new events and a screenshot in one call', async () => {
    const { ok } = setupWithShots();
    await ok('run_game');
    await ok('perform_inputs', { steps: [{ type: 'hold', key: 'D', ms: 2500 }, { type: 'mouseMove', x: 100, y: 50 }, { type: 'keyDown', key: 'D' }] });
    const o = await ok<Obs>('observe');
    expect(o.game).toMatchObject({ frame: 150, status: 'running', scene: 'level1', vars: { coins: 1 } });
    expect(o.players!.map((p) => p.id)).toEqual(['player']);
    expect(o.camera.x).toBeGreaterThan(0); // the camera follows the player
    const ids = o.entities!.map((e) => e.id);
    expect(ids).toContain('player');
    expect(ids).not.toContain('flag'); // far to the right, off screen
    expect(o.entityCount).toBeGreaterThan(ids.length);
    expect(o.entities!.find((e) => e.id === 'player')!.screen).toMatchObject({ w: 24, h: 32 });
    expect(o.input).toEqual({ keysDown: ['D'], mouse: { x: 100, y: 50, world: { x: o.camera.x + 100, y: o.camera.y + 50 }, buttons: [], hovered: null, target: null } });
    expect(o.screenshot).toMatchObject({ frame: 150, path: expect.stringMatching(/^\.vibe\/runs\//) });
    expect(o.images).toHaveLength(1);

    // Events are incremental, like after any action: the coin was already reported by perform_inputs.
    expect(o.events).toEqual([]);
    await ok('wait', { ms: 100 });
    const again = await ok<Obs>('observe', { screenshot: false, entities: 'none' });
    expect(again.entities).toBeUndefined();
    expect(again.screenshot).toBeUndefined();
    expect(again.images).toBeUndefined();
    expect(again.game.frame).toBe(156); // observing does not advance time
  });

  it('lists every entity on request and reports a failed screenshot without failing', async () => {
    const { ok, host } = setupWithShots();
    await ok('run_game');
    const all = await ok<Obs>('observe', { entities: 'all', screenshot: false });
    expect(all.entities!.length).toBe(all.entityCount);
    host['screenshotter' as never] = { shoot: () => Promise.reject(new Error('no browser')) } as never;
    const o = await ok<Obs>('observe');
    expect(o.screenshot).toEqual({ error: 'no browser' });
  });

  it('get_mouse_target and observe say what is under the mouse and what a click would reach', async () => {
    const { ok } = setupWithShots();
    await ok('create_component', { scene: 'level1', id: 'coin1', type: 'Interactable', data: { action: 'pick', via: ['click'] } });
    await ok('run_game');
    const seen = await ok<Obs>('observe', { screenshot: false });
    const coin = seen.entities!.find((e) => e.id === 'coin1')!.screen!;
    await ok('move_mouse', { x: coin.x + coin.w / 2, y: coin.y + coin.h / 2 });
    const t = await ok<{ target: { id: string; interactable: { ready: boolean } }; hovered: { id: string }; under: string[] }>('get_mouse_target');
    expect(t.target).toMatchObject({ id: 'coin1', distance: 0, clickable: true, handlers: ['interactable'], interactable: { action: 'pick', ready: true } });
    expect(t.hovered.id).toBe('coin1');
    const o = await ok<Obs>('observe', { screenshot: false, entities: 'none' });
    expect(o.input.mouse).toMatchObject({ hovered: 'coin1', target: 'coin1' });

    await ok('move_mouse', { x: coin.x + coin.w / 2 + 40, y: coin.y + coin.h / 2 });
    const miss = await ok<{ target: null; nearest: { id: string; distance: number } }>('get_mouse_target');
    expect(miss.target).toBeNull();
    expect(miss.nearest).toMatchObject({ id: 'coin1', distance: 32 });
  });
});
