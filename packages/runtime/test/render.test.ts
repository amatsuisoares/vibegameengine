import { Game } from '@vibe/engine';
import { describe, expect, it } from 'vitest';
import {
  buildDrawList,
  DEBUG_COLORS,
  MISSING_ASSET_COLOR,
  NAV_PATH_COLOR,
  paint,
  paintDebug,
  paintStatusOverlay,
  type AssetResolver,
  type SpriteCmd,
  type TextCmd,
} from '../src';
import { demoProject, project, recordingContext } from './helpers';

const box = (id: string, x: number, y: number, sprite: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id,
  transform: { x, y, ...(extra.transform as object) },
  components: { Sprite: { width: 20, height: 10, ...sprite } },
  ...extra,
});

describe('buildDrawList', () => {
  it('converts world positions to screen positions using the camera', () => {
    const game = new Game(project([box('a', 150, 100)], { camera: { x: 100, y: 20, clampToBounds: false } }));
    const [cmd] = buildDrawList(game.world) as SpriteCmd[];
    expect(cmd).toMatchObject({ kind: 'sprite', id: 'a', x: 50, y: 80, w: 20, h: 10 });
  });

  it('applies zoom, scale, rotation (degrees) and flips', () => {
    const e = box('a', 50, 50, { flipX: true }, { transform: { scaleX: -2, scaleY: 3, rotation: 90 } });
    const game = new Game(project([e], { camera: { zoom: 2, clampToBounds: false } }));
    const [cmd] = buildDrawList(game.world) as SpriteCmd[];
    expect(cmd.w).toBe(80);
    expect(cmd.h).toBe(60);
    expect(cmd.rotation).toBeCloseTo(Math.PI / 2);
    expect(cmd.flipX).toBe(false); // flipX and a negative scaleX cancel out
    expect(cmd.flipY).toBe(false);
  });

  it('sorts by layer and keeps scene order within a layer', () => {
    const game = new Game(project([box('top', 10, 10, { layer: 5 }), box('a', 10, 10), box('b', 10, 10), box('under', 10, 10, { layer: -1 })]));
    expect(buildDrawList(game.world).map((c) => c.id)).toEqual(['under', 'a', 'b', 'top']);
  });

  it('skips disabled, invisible, transparent and off-screen sprites', () => {
    const game = new Game(
      project([
        box('shown', 10, 10),
        box('disabled', 10, 10, {}, { enabled: false }),
        box('hidden', 10, 10, { visible: false }),
        box('clear', 10, 10, { opacity: 0 }),
        box('far', 1500, 10),
        box('edge', 405, 10),
      ]),
    );
    expect(buildDrawList(game.world).map((c) => c.id)).toEqual(['shown', 'edge']);
  });

  it('expands text placeholders; HUD text stays fixed while world text follows the camera', () => {
    const hud = { id: 'hud', transform: { x: 8, y: 8 }, components: { Text: { text: 'Coins: {coins}\nHP {p.health}' } } };
    const sign = { id: 'sign', transform: { x: 300, y: 100 }, components: { Text: { text: 'Hi', screenSpace: false, fontSize: 10 } } };
    const p = { id: 'p', transform: { x: 50, y: 50 }, components: { Health: { max: 4 } } };
    const game = new Game(project([hud, sign, p], { vars: { coins: 2 }, camera: { x: 200, zoom: 2, clampToBounds: false } }));
    const texts = buildDrawList(game.world) as TextCmd[];
    const h = texts.find((t) => t.id === 'hud')!;
    const s = texts.find((t) => t.id === 'sign')!;
    expect(h).toMatchObject({ x: 8, y: 8, lines: ['Coins: 2', 'HP 4'], baseline: 'top', fontSize: 16 });
    expect(s).toMatchObject({ x: 200, y: 200, baseline: 'middle', fontSize: 20 });
    expect(texts.map((t) => t.id)).toEqual(['hud', 'sign']);
  });
});

describe('paint', () => {
  const opts = { width: 400, height: 300, background: '#123456', pixelArt: true };

  it('clears with the scene background and draws shapes', () => {
    const game = new Game(
      project([box('r', 20, 20, { color: '#ff0000' }), box('c', 60, 20, { shape: 'circle' }), box('t', 90, 20, { shape: 'triangle' })]),
    );
    const { ctx, calls, ops } = recordingContext();
    paint(ctx, buildDrawList(game.world), opts);
    expect(ops[0]).toEqual({ op: 'save', args: [] });
    expect(calls('fillRect')[0]).toEqual([0, 0, 400, 300]);
    expect(ops).toContainEqual({ op: 'set', prop: 'fillStyle', value: '#123456' });
    expect(ops).toContainEqual({ op: 'set', prop: 'imageSmoothingEnabled', value: false });
    expect(calls('fillRect')[1]).toEqual([-10, -5, 20, 10]);
    expect(calls('ellipse')).toHaveLength(1);
    expect(calls('closePath')).toHaveLength(1);
    expect(calls('translate')[0]).toEqual([20, 20]);
    expect(calls('save').length).toBe(calls('restore').length);
  });

  it('draws spritesheet frames from the asset resolver', () => {
    const image = { width: 64, height: 16 } as unknown as CanvasImageSource;
    const assets: AssetResolver = { resolve: (id, frame) => ({ image, sx: frame * 16, sy: 0, sw: 16, sh: 16 }) };
    const game = new Game(project([box('coin', 30, 30, { asset: 'coin', frame: 2, width: 16, height: 16 })], {}, { assets: [{ id: 'coin', type: 'spritesheet', path: 'c.svg', frameWidth: 16, frameHeight: 16 }] }));
    const { ctx, calls } = recordingContext();
    paint(ctx, buildDrawList(game.world), { ...opts, assets });
    expect(calls('drawImage')).toEqual([[image, 32, 0, 16, 16, -8, -8, 16, 16]]);
  });

  it('draws a placeholder and reports when an asset cannot be drawn', () => {
    const assets: AssetResolver = { resolve: () => 'frame 9 is out of range' };
    const game = new Game(project([box('hero', 30, 30, { asset: 'hero', frame: 9 })], {}, { assets: [{ id: 'hero', type: 'image', path: 'h.png' }] }));
    const { ctx, ops, calls } = recordingContext();
    const errors: string[] = [];
    paint(ctx, buildDrawList(game.world), { ...opts, assets, onAssetError: (m) => errors.push(m) });
    expect(calls('drawImage')).toHaveLength(0);
    expect(ops).toContainEqual({ op: 'set', prop: 'fillStyle', value: MISSING_ASSET_COLOR });
    expect(errors).toEqual(['Sprite of "hero": frame 9 is out of range']);
  });

  it('draws multi-line text line by line', () => {
    const game = new Game(project([{ id: 'hud', transform: { x: 5, y: 6 }, components: { Text: { text: 'a\nb', fontSize: 10 } } }]));
    const { ctx, calls, ops } = recordingContext();
    paint(ctx, buildDrawList(game.world), opts);
    expect(calls('fillText')).toEqual([['a', 5, 6], ['b', 5, 18]]);
    expect(ops).toContainEqual({ op: 'set', prop: 'font', value: '10px monospace' });
  });
});

describe('overlays', () => {
  it('status banner only when the game is over', () => {
    const running = recordingContext();
    paintStatusOverlay(running.ctx, 'running', 400, 300);
    expect(running.ops).toHaveLength(0);

    const won = recordingContext();
    paintStatusOverlay(won.ctx, 'won', 400, 300);
    expect(won.calls('fillText').map((a) => a[0])).toEqual(['YOU WIN!', 'Press R to restart']);

    const crashed = recordingContext();
    paintStatusOverlay(crashed.ctx, 'crashed', 400, 300, 'boom');
    expect(crashed.calls('fillText').map((a) => a[0])).toEqual(['RUNTIME ERROR', 'boom', 'See the console for details']);
  });

  it('debug view outlines colliders by kind and labels them', () => {
    const game = new Game(demoProject());
    const { ctx, calls, ops } = recordingContext();
    paintDebug(ctx, game.world, { fps: 60, paused: true });
    const labels = calls('fillText').map((a) => a[0]);
    expect(labels).toContain('player');
    expect(labels).toContain('flag');
    expect(labels).not.toContain('hud'); // screen-space HUD gets no world marker
    expect(labels.at(-1)).toMatch(/^frame 0 \| running \| scene level1 \| 60 fps \| PAUSED$/);
    const colors = ops.flatMap((o) => ('prop' in o && o.prop === 'strokeStyle' ? [o.value] : []));
    expect(colors).toEqual(expect.arrayContaining([DEBUG_COLORS.dynamic, DEBUG_COLORS.solid, DEBUG_COLORS.trigger, DEBUG_COLORS.oneWay]));
  });
});

describe('interaction prompt', () => {
  const scene = (label?: string) =>
    new Game(
      project(
        [
          { id: 'player', tags: ['player'], transform: { x: 100, y: 150 }, components: { Sprite: { width: 20, height: 20 } } },
          { id: 'door', transform: { x: 140, y: 150 }, components: { Sprite: { width: 40, height: 40 }, Interactable: { label } } },
        ],
        { camera: { x: 50, clampToBounds: false } },
      ),
    );

  it('shows "[key] label" above the interactable the key would use', () => {
    const game = scene('Abrir');
    game.step(1);
    const cmds = buildDrawList(game.world).filter((c) => c.id === 'door:prompt');
    expect(cmds.map((c) => c.kind)).toEqual(['sprite', 'text']);
    expect(cmds[1]).toMatchObject({ lines: ['[E] Abrir'], x: 90, y: 130 - 14, align: 'center' });
    expect(cmds.every((c) => c.layer === 1000)).toBe(true);
  });

  it('shows nothing without a label or out of range', () => {
    const unlabeled = scene();
    unlabeled.step(1);
    expect(buildDrawList(unlabeled.world).some((c) => c.id.endsWith(':prompt'))).toBe(false);
    const far = scene('Abrir');
    far.entity('player')!.x = 20;
    far.step(1);
    expect(buildDrawList(far.world).some((c) => c.id.endsWith(':prompt'))).toBe(false);
  });
});

describe('text opacity', () => {
  it('fades world and HUD text; fully transparent text is skipped', () => {
    const text = (id: string, opacity: number) => ({ id, transform: { x: 10, y: 10 }, components: { Text: { text: id, opacity } } });
    const game = new Game(project([text('half', 0.5), text('gone', 0), text('full', 1)]));
    const cmds = buildDrawList(game.world) as TextCmd[];
    expect(cmds.map((c) => [c.id, c.opacity])).toEqual([['half', 0.5], ['full', undefined]]);
    const { ctx, ops } = recordingContext();
    paint(ctx, cmds, { width: 400, height: 300, background: '#000', pixelArt: true });
    const alphas = ops.flatMap((o) => ('prop' in o && o.prop === 'globalAlpha' ? [o.value] : []));
    expect(alphas).toEqual([1, 0.5, 1]);
  });
});

describe('debug: navigation paths', () => {
  it('draws the remaining path of moving NavAgents', () => {
    const game = new Game(
      project([
        { id: 'wall', transform: { x: 200, y: 100 }, components: { Collider: { width: 20, height: 200 } } },
        { id: 'npc', transform: { x: 50, y: 50 }, components: { Sprite: { width: 10, height: 10 }, NavAgent: { target: { x: 350, y: 50 } } } },
      ], { camera: { clampToBounds: false } }),
    );
    game.step(2);
    const { ctx, ops, calls } = recordingContext();
    paintDebug(ctx, game.world);
    expect(ops.some((o) => 'prop' in o && o.prop === 'strokeStyle' && o.value === NAV_PATH_COLOR)).toBe(true);
    expect(calls('lineTo').length).toBe(game.entity('npc')!.nav!.path.length);
  });
});
