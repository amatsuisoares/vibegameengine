import { describe, expect, it } from 'vitest';
import { AssetStore, FixedLoop, spritesheetFrameRect } from '../src';

describe('spritesheetFrameRect', () => {
  it('walks frames left-to-right, top-to-bottom', () => {
    expect(spritesheetFrameRect(64, 32, 16, 16, 0).rect).toEqual({ sx: 0, sy: 0, sw: 16, sh: 16 });
    expect(spritesheetFrameRect(64, 32, 16, 16, 5).rect).toEqual({ sx: 16, sy: 16, sw: 16, sh: 16 });
    expect(spritesheetFrameRect(64, 32, 16, 16, 7).rect).toEqual({ sx: 48, sy: 16, sw: 16, sh: 16 });
  });

  it('ignores partial frames and rejects out-of-range indices', () => {
    expect(spritesheetFrameRect(70, 16, 16, 16, 4)).toEqual({ count: 4, rect: null });
    expect(spritesheetFrameRect(8, 8, 16, 16, 0)).toEqual({ count: 0, rect: null });
  });
});

describe('AssetStore', () => {
  type Img = { width: number; height: number; url: string };
  const assets = [
    { id: 'hero', type: 'spritesheet' as const, path: 'chars/hero sheet.svg', frameWidth: 24, frameHeight: 32 },
    { id: 'bg', type: 'image' as const, path: 'bg.png' },
    { id: 'broken', type: 'image' as const, path: 'missing.png' },
    { id: 'jump', type: 'audio' as const, path: 'jump.wav' },
  ];
  const loader = async (url: string): Promise<Img> => {
    if (url.includes('missing')) throw new Error('404');
    return { width: url.includes('hero') ? 96 : 320, height: 32, url };
  };
  const store = () => new AssetStore<Img & CanvasImageSource>(assets, '/projects/demo/assets/', loader as never);

  it('loads images, reports failures and skips audio', async () => {
    const s = store();
    const report = await s.loadAll();
    expect(report.loaded.sort()).toEqual(['bg', 'hero']);
    expect(report.skipped).toEqual(['jump']);
    expect(report.errors).toEqual([{ id: 'broken', message: 'failed to load "missing.png": 404' }]);
  });

  it('encodes asset URLs per path segment', () => {
    expect(store().urlOf(assets[0])).toBe('/projects/demo/assets/chars/hero%20sheet.svg');
  });

  it('resolves frames and explains why a sprite cannot be drawn', async () => {
    const s = store();
    await s.loadAll();
    expect(s.resolve('hero', 2)).toMatchObject({ sx: 48, sy: 0, sw: 24, sh: 32 });
    expect(s.resolve('bg', 7)).toMatchObject({ sx: 0, sy: 0, sw: 320, sh: 32 });
    expect(s.resolve('hero', 4)).toBe('frame 4 is out of range for spritesheet "hero" (4 frames)');
    expect(s.resolve('ghost', 0)).toBe('asset "ghost" is not declared in project.json');
    expect(s.resolve('broken', 0)).toBe('asset "broken" failed to load "missing.png": 404');
    expect(s.resolve('jump', 0)).toBe('asset "jump" is audio, not an image');
  });
});

describe('FixedLoop', () => {
  const setup = (max?: number) => {
    const stepped: number[] = [];
    const loop = new FixedLoop((n) => stepped.push(n), max);
    return { loop, stepped, total: () => stepped.reduce((a, b) => a + b, 0) };
  };

  it('steps one frame per 1/60 s of wall time', () => {
    const { loop, total } = setup();
    loop.tick(0);
    for (let i = 1; i <= 60; i++) loop.tick((i * 1000) / 60);
    expect(total()).toBe(60);
  });

  it('accumulates partial frames across ticks (e.g. 144 Hz displays)', () => {
    const { loop, total } = setup();
    for (let i = 0; i <= 144; i++) loop.tick((i * 1000) / 144);
    expect(total()).toBe(60);
  });

  it('caps frames per tick after a stall and does not catch up later', () => {
    const { loop, stepped } = setup(5);
    loop.tick(0);
    loop.tick(2000);
    loop.tick(2000 + 1000 / 60);
    expect(stepped).toEqual([5, 1]);
  });

  it('supports slow motion and reset', () => {
    const { loop, total } = setup();
    loop.timeScale = 0.5;
    for (let i = 0; i <= 60; i++) loop.tick((i * 1000) / 60);
    expect(total()).toBe(30);
    loop.reset();
    expect(loop.tick(99999)).toBe(0);
  });
});
