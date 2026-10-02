import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute } from 'node:path';
import { IdSchema, type Asset } from '@vibe/shared';
import { z } from 'zod';
import { buildAssetCatalog, type AssetUse } from '../asset-catalog';
import { normalizeRel, ToolError, type ProjectStore } from '../project-store';
import { SFX_PRESETS, sfxWav } from '../sfx';
import { defineTool } from './registry';
import { changeInfo } from './scene-tools';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg']);
const MAX_BYTES = 20 * 1024 * 1024;
/** list_assets shows at most this many uses per item (the total is given). */
const MAX_USES = 20;

const capUses = <T extends { uses: AssetUse[] }>(e: T) =>
  e.uses.length > MAX_USES ? { ...e, uses: e.uses.slice(0, MAX_USES), usesTotal: e.uses.length } : e;

type Raw = Record<string, unknown>;

function assetsOf(config: Raw): Raw[] {
  if (config.assets === undefined) config.assets = [];
  if (!Array.isArray(config.assets)) throw new ToolError('config.assets is not an array');
  return config.assets as Raw[];
}

/** Path under assets/ (no "..", no absolute paths), with forward slashes. */
function assetPath(rel: string): string {
  const p = normalizeRel(rel).replace(/^assets\//, '');
  if (!p || p.startsWith('/') || p.split('/').includes('..')) throw new ToolError(`Invalid asset path "${rel}": use a path inside assets/`);
  return p;
}

/**
 * Writes a binary file into assets/ and registers (or updates) it in config.assets.
 * The file itself is not in the undo history (binary); the config change is.
 */
function addAsset(store: ProjectStore, meta: Parameters<ProjectStore['edit']>[0], asset: Asset, content: Buffer, replace: boolean) {
  const abs = store.path(`assets/${asset.path}`);
  const config = JSON.parse(store.readText('project.json') ?? '{}') as Raw;
  const existing = assetsOf(config).find((a) => a.id === asset.id);
  if (existing && !replace) throw new ToolError(`Asset "${asset.id}" already exists; pass replace: true to overwrite it`);
  if (!existing && existsSync(abs) && !replace) {
    throw new ToolError(`File assets/${asset.path} already exists; choose another path or pass replace: true`);
  }
  const previous = existsSync(abs) ? readFileSync(abs) : null;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  try {
    return store.edit(meta, (tx) => {
      const cfg = tx.readJson('project.json') as Raw;
      const list = assetsOf(cfg);
      const i = list.findIndex((a) => a.id === asset.id);
      const entry = Object.fromEntries(Object.entries(asset).filter(([, v]) => v !== undefined));
      if (i >= 0) list[i] = entry;
      else list.push(entry);
      tx.writeJson('project.json', cfg);
    });
  } catch (err) {
    // The config was rejected: put the file back as it was.
    if (previous) writeFileSync(abs, previous);
    else rmSync(abs, { force: true });
    throw err;
  }
}

export const assetTools = [
  defineTool({
    name: 'list_assets',
    description:
      'Asset catalog (the same the asset browser of the game page shows): declared assets with file size, image size, spritesheet frames (columns × rows), audio length and the events that play them; files in assets/ not declared in project.json; prefabs (components, sprite, instances); scripts. Each item lists where it is used (file + JSON path, or script line). Filter by kind, id, or unused: true to find what nothing uses.',
    input: z.object({
      kind: z.enum(['image', 'spritesheet', 'audio', 'prefab', 'script', 'undeclared']).optional().describe('Only this kind.'),
      id: z.string().optional().describe('Only the asset / prefab with this id, or the script with this path.'),
      unused: z.boolean().optional().describe('Only items nothing references (instances count as uses of a prefab).'),
    }),
    run: ({ store }, { kind, id, unused }) => {
      const cat = buildAssetCatalog(store);
      const keep = (itemId: string, used: boolean) => (id === undefined || itemId === id) && (!unused || !used);
      const assets = cat.assets.filter((a) => (!kind || kind === a.type) && keep(a.id, a.uses.length > 0 || !!a.events));
      const prefabs = cat.prefabs.filter((p) => (!kind || kind === 'prefab') && keep(p.id, p.uses.length + p.instances.length > 0));
      const scripts = cat.scripts.filter((s) => (!kind || kind === 'script') && keep(s.path, s.uses.length > 0));
      const undeclared = !kind || kind === 'undeclared' ? (id === undefined ? cat.undeclared : cat.undeclared.filter((f) => f.path === id)) : [];
      const warnings = assets.flatMap((a) => a.warnings.map((w) => `${a.id}: ${w}`));
      return {
        counts: { assets: assets.length, prefabs: prefabs.length, scripts: scripts.length, undeclared: undeclared.length },
        ...(warnings.length && { warnings }),
        ...(assets.length && { assets: assets.map(capUses) }),
        ...(undeclared.length && { undeclared, note: 'Undeclared files are not usable by id: declare them in config.assets (modify_project_config) or delete them.' }),
        ...(prefabs.length && { prefabs: prefabs.map(capUses) }),
        ...(scripts.length && { scripts: scripts.map(capUses) }),
      };
    },
  }),

  defineTool({
    name: 'import_asset',
    description:
      'Copies an image, spritesheet or audio file the user has on disk (absolute path) into the project assets/ and declares it in project.json. Types are inferred from the extension (png/jpg/gif/webp/svg, wav/mp3/ogg); spritesheets need frameWidth/frameHeight.',
    mutates: true,
    input: z.object({
      source: z.string().min(1).describe('Absolute path of the file to import (given by the user).'),
      id: IdSchema.describe('Asset id used by Sprite.asset, sounds, music...'),
      type: z.enum(['image', 'spritesheet', 'audio']).optional().describe('Default: audio for wav/mp3/ogg, else image (spritesheet if frame size is given).'),
      path: z.string().optional().describe('Destination inside assets/ (default: the file name).'),
      frameWidth: z.number().int().positive().optional(),
      frameHeight: z.number().int().positive().optional(),
      replace: z.boolean().default(false).describe('Overwrite an existing asset with this id / file.'),
    }),
    run: ({ store }, input, meta) => {
      if (!isAbsolute(input.source)) throw new ToolError('source must be an absolute path');
      if (!existsSync(input.source) || !statSync(input.source).isFile()) throw new ToolError(`File not found: ${input.source}`);
      const ext = extname(input.source).toLowerCase();
      const audio = AUDIO_EXT.has(ext);
      if (!audio && !IMAGE_EXT.has(ext)) throw new ToolError(`Unsupported file type "${ext}". Images: ${[...IMAGE_EXT].join(' ')}; audio: ${[...AUDIO_EXT].join(' ')}`);
      const size = statSync(input.source).size;
      if (size > MAX_BYTES) throw new ToolError(`File is too large (${Math.round(size / 1e6)} MB; max ${MAX_BYTES / 1e6} MB)`);
      const type = input.type ?? (audio ? 'audio' : input.frameWidth ? 'spritesheet' : 'image');
      if (audio !== (type === 'audio')) throw new ToolError(`A ${ext} file cannot be a ${type} asset`);
      const path = assetPath(input.path ?? basename(input.source));
      if (extname(path).toLowerCase() !== ext) throw new ToolError(`Destination "${path}" must keep the ${ext} extension`);
      const asset: Asset = { id: input.id, type, path, frameWidth: input.frameWidth, frameHeight: input.frameHeight };
      const r = addAsset(store, meta(`Import ${type} ${input.id} (assets/${path})`), asset, readFileSync(input.source), input.replace);
      return { ...changeInfo(r), asset: { id: asset.id, type, path: `assets/${path}`, bytes: size } };
    },
  }),

  defineTool({
    name: 'create_sound',
    description: `Generates a retro sound effect (WAV) into assets/sfx/ and declares it as an audio asset. Presets: ${SFX_PRESETS.join(', ')}. Then map it to events in config.sounds (modify_project_config) or play it from a rule/script.`,
    mutates: true,
    input: z.object({
      id: IdSchema.describe('Asset id, e.g. "sfx_coin".'),
      preset: z.enum(SFX_PRESETS),
      pitch: z.number().min(0.25).max(4).optional().describe('Frequency multiplier (default 1).'),
      duration: z.number().min(0.03).max(3).optional().describe('Seconds (default depends on the preset).'),
      volume: z.number().min(0).max(1).optional().describe('Peak level (default 0.6).'),
      seed: z.number().int().optional().describe('Noise variation (hit, explosion).'),
      replace: z.boolean().default(false),
    }),
    run: ({ store }, { id, preset, pitch, duration, volume, seed, replace }, meta) => {
      const wav = sfxWav(preset, { pitch, duration, volume, seed });
      const asset: Asset = { id, type: 'audio', path: `sfx/${id}.wav` };
      const r = addAsset(store, meta(`Create sound ${id} (${preset})`), asset, wav, replace);
      return { ...changeInfo(r), asset: { id, type: 'audio', path: `assets/sfx/${id}.wav`, bytes: wav.length, seconds: (wav.length - 44) / 2 / 22050 } };
    },
  }),
];
