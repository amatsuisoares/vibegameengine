import { Game } from '@vibe/engine';
import { describe, expect, it } from 'vitest';
import {
  buildDrawList,
  dragDelta,
  dragView,
  frameEntity,
  GAME_CAMERA_COLOR,
  MAX_ZOOM,
  MIN_ZOOM,
  offsetDrawList,
  panView,
  pickAt,
  Runtime,
  SELECTION_COLOR,
  selectionBox,
  viewToWorld,
  worldToView,
  zoomViewAt,
} from '../src';
import { demoProject, fakeCanvas, project } from './helpers';

describe('editor viewport', () => {
  it('zooms around the pointer and pans with the drag', () => {
    const view = { x: 100, y: 50, zoom: 1 };
    const before = viewToWorld(view, 200, 120);
    const zoomed = zoomViewAt(view, 200, 120, 2);
    expect(zoomed.zoom).toBe(2);
    // The world point under the pointer stays under it.
    expect(viewToWorld(zoomed, 200, 120)).toEqual(before);
    expect(worldToView(zoomed, before.x, before.y)).toEqual({ x: 200, y: 120 });
    expect(zoomViewAt(view, 0, 0, 1000).zoom).toBe(MAX_ZOOM);
    expect(zoomViewAt(view, 0, 0, 0.0001).zoom).toBe(MIN_ZOOM);

    // Dragging right by 40 screen px at zoom 2 shows what is 20 world px to the left.
    expect(panView(zoomed, 40, -10)).toEqual({ x: zoomed.x - 20, y: zoomed.y + 5, zoom: 2 });
    expect(dragDelta({ x: 0, y: 0, zoom: 2 }, { x: 10, y: 10 }, { x: 51, y: 0 })).toEqual({ dx: 21, dy: -5 });
  });

  it('draws the world through the editor camera without moving the game camera', () => {
    const game = new Game(demoProject());
    const camera = { ...game.world.camera };
    const coin = buildDrawList(game.world).find((c) => c.id === 'coin1')!;
    const view = { x: 300, y: 300, zoom: 2 };
    const moved = buildDrawList(game.world, view).find((c) => c.id === 'coin1')!;
    expect(moved.x).toBeCloseTo((400 - 300) * 2);
    expect(moved.kind === 'sprite' && moved.w).toBe(32);
    expect(coin.x).toBeCloseTo(400 - camera.x);
    expect(game.world.camera).toEqual(camera);
    expect(selectionBox(game.world, 'coin1', view)).toMatchObject({ x: (392 - 300) * 2, w: 32 });
  });

  it('picks the topmost entity under the pointer, and the selected one on its outline', () => {
    const p = project(
      [
        { id: 'back', transform: { x: 100, y: 100 }, components: { Sprite: { width: 100, height: 100, layer: 0 } } },
        { id: 'front', transform: { x: 100, y: 100 }, components: { Sprite: { width: 20, height: 20, layer: 5 } } },
        { id: 'hidden', enabled: false, transform: { x: 300, y: 100 }, components: { Sprite: { width: 20, height: 20 } } },
        { id: 'logic', transform: { x: 200, y: 200 }, components: {} },
      ],
      { camera: { x: 0, y: 0 } },
    );
    const game = new Game(p);
    const view = { x: 0, y: 0, zoom: 1 };
    expect(pickAt(game, view, 100, 100)).toBe('front');
    expect(pickAt(game, view, 70, 70)).toBe('back');
    expect(pickAt(game, view, 300, 100)).toBeNull();
    expect(pickAt(game, view, 200, 200)).toBeNull();
    // A disabled entity is not drawn, but once selected (in the hierarchy) it can be grabbed.
    expect(pickAt(game, view, 300, 100, 'hidden')).toBe('hidden');
    // The selected entity wins over what is drawn on top of it.
    expect(pickAt(game, view, 100, 100, 'back')).toBe('back');
    // Through a zoomed / panned view.
    expect(pickAt(game, { x: 50, y: 50, zoom: 2 }, 100, 100)).toBe('front');
  });

  it('frames the selected entity', () => {
    const game = new Game(demoProject());
    const v = frameEntity(game.world, 'coin2', { x: 0, y: 0, zoom: 2 })!;
    expect(viewToWorld(v, 400, 225)).toEqual({ x: 1100, y: 318 });
    expect(frameEntity(game.world, 'ghost', v)).toBeNull();
  });

  it('previews a drag by moving draw commands, not the entity', () => {
    const game = new Game(demoProject());
    const cmds = buildDrawList(game.world);
    const drag = { id: 'coin1', dx: 10, dy: -5 };
    const out = offsetDrawList(cmds, drag, 2);
    const a = cmds.find((c) => c.id === 'coin1')!;
    const b = out.find((c) => c.id === 'coin1')!;
    expect([b.x - a.x, b.y - a.y]).toEqual([20, -10]);
    expect(out.find((c) => c.id === 'player')).toBe(cmds.find((c) => c.id === 'player'));
    expect(offsetDrawList(cmds, { id: 'coin1', dx: 0, dy: 0 }, 1)).toBe(cmds);
    const view = { x: 0, y: 0, zoom: 1 };
    expect(selectionBox(game.world, 'coin1', dragView(view, drag))!.x).toBe(selectionBox(game.world, 'coin1', view)!.x + 10);
    expect(game.world.get('coin1')!.x).toBe(400);
  });

  it('is drawn by the runtime with its gizmos, leaving the simulation alone', () => {
    const { canvas, ops, calls } = fakeCanvas();
    const runtime = new Runtime(canvas, demoProject(), { paused: true });
    const state = JSON.stringify(runtime.game.getState());
    runtime.selected = 'coin1';
    runtime.editor = { view: { x: 0, y: 0, zoom: 0.5 }, drag: { id: 'coin1', dx: 8, dy: 0 } };
    runtime.render();
    const texts = calls('fillText').map((a) => a[0]);
    expect(texts).toContain('cena level1 2400×450');
    expect(texts).toContain('câmera do jogo');
    expect(texts).toContain('Editando · zoom 50%');
    expect(texts).toContain('(408, 390)  Δ +8, 0');
    expect(ops).toContainEqual({ op: 'set', prop: 'strokeStyle', value: GAME_CAMERA_COLOR });
    expect(ops).toContainEqual({ op: 'set', prop: 'strokeStyle', value: SELECTION_COLOR });
    expect(JSON.stringify(runtime.game.getState())).toBe(state);

    // Out of edit mode: no gizmos.
    runtime.editor = null;
    const n = ops.length;
    runtime.render();
    expect(ops.slice(n).some((o) => o.op === 'fillText' && o.args[0] === 'câmera do jogo')).toBe(false);
  });
});
