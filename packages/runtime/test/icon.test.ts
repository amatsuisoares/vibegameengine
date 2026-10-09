import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, renderIcon, visibleBounds, type Rgba } from '../export/icon';

const repo = (p: string) => new URL(`../../../${p}`, import.meta.url);

/** w×h transparent image with an opaque rectangle of one color. */
function sprite(w: number, h: number, rect: { x: number; y: number; w: number; h: number }, rgb = [200, 40, 40]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) data.set([...rgb, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}
const px = (img: Rgba, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

describe('PNG reader/writer', () => {
  it('writes and reads back the same pixels', () => {
    const img = sprite(5, 3, { x: 1, y: 1, w: 2, h: 1 });
    img.data.set([1, 2, 3, 128], 0);
    expect(decodePng(encodePng(img))).toEqual(img);
  });

  it('reads a sprite saved by Chromium (8-bit RGBA, filtered rows)', () => {
    const img = decodePng(readFileSync(repo('test-fixtures/demo-app/assets/mascote.png')));
    expect([img.width, img.height]).toEqual([96, 96]);
    expect(px(img, 0, 0)[3]).toBe(0); // transparent corner
    const box = visibleBounds(img);
    expect(box.width).toBeLessThan(96);
    expect(px(img, box.x + Math.floor(box.width / 2), box.y + Math.floor(box.height / 2))[3]).toBe(255);
  });

  it('reads palette images and explains what it cannot read', () => {
    // 2×1 palette PNG: red, then transparent blue (tRNS).
    const chunk = (type: string, body: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(body.length);
      return Buffer.concat([len, Buffer.from(type, 'latin1'), body, Buffer.alloc(4)]); // CRC is not checked
    };
    const head = Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 3, 0, 0, 0]);
    const png = (ihdr: Buffer) =>
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])),
        chunk('tRNS', Buffer.from([255, 0])),
        chunk('IDAT', deflateSync(Buffer.from([0, 0, 1]))),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    expect([...decodePng(png(head)).data]).toEqual([255, 0, 0, 255, 0, 0, 255, 0]);
    const interlaced = Buffer.from(head);
    interlaced[12] = 1;
    expect(() => decodePng(png(interlaced))).toThrow(/interlaced/);
    const deep = Buffer.from(head);
    deep[8] = 16;
    expect(() => decodePng(png(deep))).toThrow(/16-bit/);
    expect(() => decodePng(Buffer.from('GIF89a'))).toThrow(/not a PNG/);
  });
});

describe('renderIcon', () => {
  // A 20×10 red bar in the corner of a 100×100 sprite: only the visible part counts.
  const bar = sprite(100, 100, { x: 0, y: 80, w: 20, h: 10 });

  it('centers the visible part on the background, scaled to fill', () => {
    expect(visibleBounds(bar)).toEqual({ x: 0, y: 80, width: 20, height: 10 });
    const icon = renderIcon(bar, { size: 40, background: '#00ff00', fill: 0.5 }); // bar → 20×10 in the middle
    expect([icon.width, icon.height]).toEqual([40, 40]);
    expect(px(icon, 20, 20)).toEqual([200, 40, 40, 255]);
    expect(px(icon, 11, 16)).toEqual([200, 40, 40, 255]);
    expect(px(icon, 9, 20)).toEqual([0, 255, 0, 255]);
    expect(px(icon, 20, 14)).toEqual([0, 255, 0, 255]);
    expect(px(icon, 0, 0)).toEqual([0, 255, 0, 255]);
  });

  it('shrinks by averaging (edges blend into the background), keeps transparency without one, cuts a circle', () => {
    const big = sprite(1000, 1000, { x: 0, y: 0, w: 1000, h: 1000 }, [255, 255, 255]);
    const small = renderIcon(big, { size: 10, background: '#000000', fill: 0.55 }); // 5.5 px wide, from x = 2.25
    expect(px(small, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(px(small, 2, 5)).toEqual([191, 191, 191, 255]); // three quarters covered
    expect(px(small, 1, 5)).toEqual([0, 0, 0, 255]);
    const fg = renderIcon(bar, { size: 40, fill: 0.5 });
    expect(px(fg, 0, 0)[3]).toBe(0);
    expect(px(fg, 20, 20)).toEqual([200, 40, 40, 255]);
    const round = renderIcon(bar, { size: 40, background: '#00ff00', round: true });
    expect(px(round, 0, 0)[3]).toBe(0);
    expect(px(round, 20, 1)[3]).toBe(255);
  });

  it('draws rectangles too (splash screens), fitting the shorter side', () => {
    const splash = renderIcon(bar, { size: 0, width: 80, height: 40, background: '#0000ff', fill: 0.5 });
    expect([splash.width, splash.height]).toEqual([80, 40]);
    expect(px(splash, 40, 20)).toEqual([200, 40, 40, 255]);
    expect(px(splash, 29, 20)).toEqual([0, 0, 255, 255]);
  });
});
