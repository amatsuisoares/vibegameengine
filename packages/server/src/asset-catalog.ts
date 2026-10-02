import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { ProjectStore } from './project-store';

/**
 * Asset catalog (V0.5): what a project has to build with — declared assets (with their files'
 * size, image dimensions, spritesheet frames, audio length), files in assets/ nobody declared,
 * prefabs and scripts — and where each one is used. Used by the editor's asset browser and by the
 * agent (list_assets). Read-only.
 */

/** Where something is referenced: a file and a place in it (JSON path, or "line N" in a script). */
export interface AssetUse {
  file: string;
  at: string;
}

export interface SpritesheetFrames {
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  count: number;
}

export interface AssetEntry {
  id: string;
  type: 'image' | 'spritesheet' | 'audio';
  /** Path inside the project (assets/...). */
  path: string;
  /** null = the file is missing. */
  bytes: number | null;
  width?: number;
  height?: number;
  frames?: SpritesheetFrames;
  /** Audio length (WAV only). */
  seconds?: number;
  /** Game events that play it (config.sounds). */
  events?: string[];
  uses: AssetUse[];
  warnings: string[];
}

export interface UndeclaredFile {
  path: string;
  bytes: number;
  kind: 'image' | 'audio' | 'other';
}

export interface PrefabEntry {
  id: string;
  file: string;
  tags: string[];
  components: string[];
  /** What it looks like (its Sprite), for a preview. */
  sprite?: { asset?: string; color?: string; shape?: string; width?: number; height?: number };
  /** Scene entities that are instances of it. */
  instances: { scene: string; id: string }[];
  /** Other references: spawn actions, scripts. */
  uses: AssetUse[];
  error?: string;
}

export interface ScriptEntry {
  path: string;
  lines: number;
  bytes: number;
  /** Entities / prefabs running it (Script.src). */
  uses: AssetUse[];
}

export interface AssetCatalog {
  assets: AssetEntry[];
  undeclared: UndeclaredFile[];
  prefabs: PrefabEntry[];
  scripts: ScriptEntry[];
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg']);

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

/** Pixel size of a PNG, GIF, JPEG, WebP or SVG file (null when it cannot be read). */
export function imageSize(buf: Buffer, ext: string): { width: number; height: number } | null {
  try {
    switch (ext.toLowerCase()) {
      case '.png':
        if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      case '.gif':
        if (buf.toString('ascii', 0, 3) !== 'GIF') return null;
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      case '.jpg':
      case '.jpeg': {
        let i = 2;
        while (i + 9 < buf.length) {
          if (buf[i] !== 0xff) {
            i++;
            continue;
          }
          const marker = buf[i + 1];
          // Start-of-frame markers (not DHT C4, JPG C8, DAC CC) carry the size.
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
          }
          i += 2 + buf.readUInt16BE(i + 2);
        }
        return null;
      }
      case '.webp': {
        if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
        const chunk = buf.toString('ascii', 12, 16);
        if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
        if (chunk === 'VP8L') {
          const b = buf.readUInt32LE(21);
          return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
        }
        if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
        return null;
      }
      case '.svg': {
        const tag = /<svg\b[^>]*>/i.exec(buf.toString('utf8'))?.[0];
        if (!tag) return null;
        const attr = (name: string) => {
          const v = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, 'i').exec(tag);
          return v ? Number(v[1]) : undefined;
        };
        const w = attr('width');
        const h = attr('height');
        if (w && h) return { width: w, height: h };
        const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
        return box ? { width: Number(box[1]), height: Number(box[2]) } : null;
      }
    }
  } catch {
    // Truncated file: unknown size.
  }
  return null;
}

/** Length of a PCM WAV file in seconds (null when it is not one). */
export function wavSeconds(buf: Buffer): number | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let i = 12; i + 8 <= buf.length; ) {
    const id = buf.toString('ascii', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    if (id === 'fmt ' && i + 16 <= buf.length) byteRate = buf.readUInt32LE(i + 16);
    if (id === 'data') return byteRate ? Math.round((size / byteRate) * 1000) / 1000 : null;
    i += 8 + size + (size % 2);
  }
  return null;
}

function filesUnder(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return filesUnder(p, base);
    return d.isFile() ? [relative(base, p).split('\\').join('/')] : [];
  });
}

/** Path segment of an array element: the entity / item id when it has one, else its index. */
const segment = (parent: string, item: unknown, i: number) =>
  isObj(item) && typeof item.id === 'string' ? `${parent}${parent ? '.' : ''}${item.id}` : `${parent}[${i}]`;

/**
 * Visits every string value of a JSON document with its key and path ("pet.components.Sprite.asset").
 * Arrays of entities are addressed by entity id. `skip` prunes keys (e.g. tags).
 */
function walkStrings(value: unknown, visit: (s: string, key: string, path: string) => void, skip: Set<string>, path = '', key = '') {
  if (typeof value === 'string') visit(value, key, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, visit, skip, segment(path, v, i), key));
  else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (skip.has(k)) continue;
      walkStrings(v, visit, skip, path ? `${path}.${k}` : k, k);
    }
  }
}

/** Lines of the scripts that mention `id` as a string literal ('id', "id" or `id`). */
function scriptMentions(scripts: Record<string, string>, id: string): AssetUse[] {
  const out: AssetUse[] = [];
  const quoted = new RegExp(`(['"\`])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`);
  for (const [file, source] of Object.entries(scripts)) {
    source.split('\n').forEach((line, i) => {
      if (quoted.test(line)) out.push({ file, at: `line ${i + 1}` });
    });
  }
  return out;
}

export function buildAssetCatalog(store: ProjectStore): AssetCatalog {
  const snap = store.snapshot();
  const config = isObj(snap.config) ? snap.config : {};
  const declared = Array.isArray(config.assets) ? (config.assets as unknown[]).filter(isObj) : [];
  const docs: { file: string; data: unknown }[] = [
    { file: 'project.json', data: { ...config, assets: undefined } },
    ...snap.scenes.filter((s) => s.data !== undefined).map((s) => ({ file: s.file, data: s.data })),
    ...snap.prefabs.filter((p) => p.data !== undefined).map((p) => ({ file: p.file, data: p.data })),
  ];
  // Ids and names are not references; tags are labels.
  const ignore = new Set(['id', 'name', 'tags']);
  const usesOf = (match: (s: string, key: string, path: string) => boolean): AssetUse[] => {
    const out: AssetUse[] = [];
    for (const d of docs) walkStrings(d.data, (s, key, path) => match(s, key, path) && out.push({ file: d.file, at: path }), ignore);
    return out;
  };
  const sounds = isObj(config.sounds) ? config.sounds : {};

  const assets: AssetEntry[] = declared.map((a) => {
    const id = String(a.id);
    const type = (['image', 'spritesheet', 'audio'].includes(a.type as string) ? a.type : 'image') as AssetEntry['type'];
    const rel = String(a.path ?? '').replace(/^\/+/, '');
    const entry: AssetEntry = { id, type, path: `assets/${rel}`, bytes: null, uses: [], warnings: [] };
    const abs = store.path(`assets/${rel}`);
    const ext = extname(rel).toLowerCase();
    if (!rel || !existsSync(abs) || !statSync(abs).isFile()) entry.warnings.push(`file assets/${rel} is missing`);
    else {
      const buf = readFileSync(abs);
      entry.bytes = buf.length;
      if (type === 'audio') {
        if (!AUDIO_EXT.has(ext)) entry.warnings.push(`${ext || 'no extension'} is not an audio file`);
        const s = ext === '.wav' ? wavSeconds(buf) : null;
        if (s !== null) entry.seconds = s;
      } else {
        if (!IMAGE_EXT.has(ext)) entry.warnings.push(`${ext || 'no extension'} is not an image file`);
        const size = imageSize(buf, ext);
        if (size) Object.assign(entry, size);
        else entry.warnings.push('could not read the image size');
      }
    }
    const fw = Number(a.frameWidth);
    const fh = Number(a.frameHeight);
    if (type === 'spritesheet' && fw > 0 && fh > 0 && entry.width && entry.height) {
      const columns = Math.floor(entry.width / fw);
      const rows = Math.floor(entry.height / fh);
      entry.frames = { frameWidth: fw, frameHeight: fh, columns, rows, count: columns * rows };
      if (!columns || !rows) entry.warnings.push(`frames (${fw}×${fh}) are larger than the image (${entry.width}×${entry.height})`);
      else if (entry.width % fw || entry.height % fh) entry.warnings.push(`image ${entry.width}×${entry.height} is not a whole number of ${fw}×${fh} frames`);
    }
    const events = Object.entries(sounds)
      .filter(([, ref]) => ref === id || (isObj(ref) && ref.asset === id))
      .map(([event]) => event);
    if (events.length) entry.events = events;
    entry.uses = [...usesOf((s) => s === id), ...scriptMentions(snap.scripts, id)];
    return entry;
  });

  const declaredPaths = new Set(assets.map((a) => a.path));
  const undeclared: UndeclaredFile[] = filesUnder(store.path('assets'))
    .map((p) => `assets/${p}`)
    .filter((p) => !declaredPaths.has(p))
    .map((p) => {
      const ext = extname(p).toLowerCase();
      return { path: p, bytes: statSync(store.path(p)).size, kind: IMAGE_EXT.has(ext) ? 'image' : AUDIO_EXT.has(ext) ? 'audio' : 'other' };
    });

  const prefabs: PrefabEntry[] = snap.prefabs.map((p) => {
    const data = isObj(p.data) ? p.data : {};
    const comps = isObj(data.components) ? data.components : {};
    const s = isObj(comps.Sprite) ? comps.Sprite : undefined;
    const instances: PrefabEntry['instances'] = [];
    for (const sc of snap.scenes) {
      const list = isObj(sc.data) && Array.isArray(sc.data.entities) ? sc.data.entities : [];
      for (const e of list) if (isObj(e) && e.prefab === p.id) instances.push({ scene: sc.id, id: String(e.id) });
    }
    // Instances are listed apart: the other uses are spawn actions and scripts.
    const isInstance = (path: string) => /^entities(\.[^.[\]]+|\[\d+\])\.prefab$/.test(path);
    return {
      id: p.id,
      file: p.file,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      components: Object.keys(comps),
      ...(s && {
        sprite: Object.fromEntries(
          Object.entries({ asset: s.asset, color: s.color, shape: s.shape, width: s.width, height: s.height }).filter(([, v]) => v !== undefined),
        ) as PrefabEntry['sprite'],
      }),
      instances,
      uses: [...usesOf((v, key, path) => v === p.id && key === 'prefab' && !isInstance(path)), ...scriptMentions(snap.scripts, p.id)],
      ...(p.error && { error: p.error }),
    };
  });

  const scripts: ScriptEntry[] = Object.entries(snap.scripts).map(([path, source]) => ({
    path,
    lines: source.split('\n').length,
    bytes: Buffer.byteLength(source),
    uses: usesOf((v, key) => key === 'src' && v === path),
  }));

  return { assets, undeclared, prefabs, scripts };
}
