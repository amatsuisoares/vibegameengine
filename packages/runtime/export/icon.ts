import { crc32, deflateSync, inflateSync } from 'node:zlib';

/**
 * App icons from a game sprite, without image libraries: a small PNG reader/writer (8-bit, not
 * interlaced — what image editors save) and a resampler. The sprite's visible part (its opaque
 * bounding box) is centered on a square of the background color.
 */

export interface Rgba {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(file: Uint8Array): Rgba {
  const buf = Buffer.from(file);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let palette: Buffer | undefined;
  let alpha: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      color = body[9]!;
      if (body[12] !== 0) throw new Error('interlaced PNGs are not supported (save it without interlacing)');
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') alpha = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  const channels = CHANNELS[color];
  if (depth !== 8 || !channels) throw new Error(`PNG with ${depth}-bit color type ${color} is not supported (save it as 8-bit RGBA)`);
  if (color === 3 && !palette) throw new Error('PNG palette is missing');

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? px[y * stride + i - channels]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? px[(y - 1) * stride + i - channels]! : 0;
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
      px[y * stride + i] = (line[i]! + pred) & 255;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = px.subarray(p * channels, p * channels + channels);
    let rgba: [number, number, number, number];
    if (color === 6) rgba = [s[0]!, s[1]!, s[2]!, s[3]!];
    else if (color === 2) rgba = [s[0]!, s[1]!, s[2]!, 255];
    else if (color === 4) rgba = [s[0]!, s[0]!, s[0]!, s[1]!];
    else if (color === 0) rgba = [s[0]!, s[0]!, s[0]!, 255];
    else {
      const i = s[0]!;
      rgba = [palette![i * 3]!, palette![i * 3 + 1]!, palette![i * 3 + 2]!, alpha && i < alpha.length ? alpha[i]! : 255];
    }
    data.set(rgba, p * 4);
  }
  return { width, height, data };
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, body: Uint8Array) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(img: Rgba): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(img.width, 0);
  header.writeUInt32BE(img.height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]);
}

/** The smallest rectangle holding every visible pixel (the whole image if it is all transparent). */
export function visibleBounds(img: Rgba) {
  let x0 = img.width;
  let y0 = img.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3]! < 8) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? { x: 0, y: 0, width: img.width, height: img.height } : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export interface IconOptions {
  /** Square side in pixels. */
  size: number;
  /** A rectangle instead of a square (splash screens); the sprite fits in the shorter side. */
  width?: number;
  height?: number;
  /** Background color (#rrggbb); omitted = transparent (Android's adaptive foreground). */
  background?: string;
  /** Fraction of the side the sprite may take (its longer side). */
  fill?: number;
  /** Cut to a circle (Android's round icon). */
  round?: boolean;
}

/**
 * The sprite's visible part, scaled to fit `fill` of the square and centered. Shrinking averages
 * the covered source pixels (weighted by alpha, so edges do not darken); enlarging keeps hard pixels.
 */
export function renderIcon(sprite: Rgba, o: IconOptions): Rgba {
  const W = o.width ?? o.size;
  const H = o.height ?? o.size;
  const box = visibleBounds(sprite);
  const scale = (Math.min(W, H) * (o.fill ?? 0.8)) / Math.max(box.width, box.height);
  const w = box.width * scale;
  const h = box.height * scale;
  const left = (W - w) / 2;
  const top = (H - h) / 2;
  const bg = o.background ? [1, 3, 5].map((i) => parseInt(o.background!.slice(i, i + 2), 16)) : undefined;
  const out = new Uint8Array(W * H * 4);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Source area under this output pixel.
      const sx0 = box.x + (x - left) / scale;
      const sy0 = box.y + (y - top) / scale;
      const sx1 = sx0 + 1 / scale;
      const sy1 = sy0 + 1 / scale;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      if (scale >= 1) {
        const ix = Math.floor(sx0);
        const iy = Math.floor(sy0);
        if (ix >= box.x && iy >= box.y && ix < box.x + box.width && iy < box.y + box.height) {
          const p = (iy * sprite.width + ix) * 4;
          const pa = sprite.data[p + 3]! / 255;
          [r, g, b, a, area] = [sprite.data[p]! * pa, sprite.data[p + 1]! * pa, sprite.data[p + 2]! * pa, pa, 1];
        } else area = 1;
      } else {
        for (let iy = Math.floor(sy0); iy < Math.ceil(sy1); iy++) {
          const wy = Math.min(sy1, iy + 1) - Math.max(sy0, iy);
          for (let ix = Math.floor(sx0); ix < Math.ceil(sx1); ix++) {
            const wgt = wy * (Math.min(sx1, ix + 1) - Math.max(sx0, ix));
            area += wgt;
            if (ix < box.x || iy < box.y || ix >= box.x + box.width || iy >= box.y + box.height) continue;
            const p = (iy * sprite.width + ix) * 4;
            const pa = (sprite.data[p + 3]! / 255) * wgt;
            r += sprite.data[p]! * pa;
            g += sprite.data[p + 1]! * pa;
            b += sprite.data[p + 2]! * pa;
            a += pa;
          }
        }
      }
      const alpha = area ? a / area : 0; // sprite coverage of this pixel
      const color = a ? [r / a, g / a, b / a] : [0, 0, 0];
      let px: number[];
      if (bg) px = [0, 1, 2].map((i) => color[i]! * alpha + bg[i]! * (1 - alpha)).concat(255);
      else px = [...color, alpha * 255];
      if (o.round) {
        // Antialiased circle edge.
        const d = Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2);
        px[3] = px[3]! * Math.max(0, Math.min(1, Math.min(W, H) / 2 - d + 0.5));
      }
      out.set(px.map((v) => Math.round(v)), (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data: out };
}

/** Shorthand: a PNG file of the icon. */
export function iconPng(sprite: Rgba, o: IconOptions) {
  return encodePng(renderIcon(sprite, o));
}
