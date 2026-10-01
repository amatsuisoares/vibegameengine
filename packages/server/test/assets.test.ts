import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderSfx, SFX_PRESETS, sfxWav } from '../src';
import { setup } from './helpers';

const outside: string[] = [];
afterEach(() => {
  while (outside.length) rmSync(outside.pop()!, { recursive: true, force: true });
});

function fileOutsideProject(name: string, content: Buffer | string) {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-import-'));
  outside.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

describe('sound synthesizer', () => {
  it('renders every preset to a valid, deterministic 16-bit mono WAV', () => {
    for (const preset of SFX_PRESETS) {
      const wav = sfxWav(preset, { seed: 3 });
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(wav.subarray(8, 16).toString()).toBe('WAVEfmt ');
      expect(wav.readUInt16LE(22)).toBe(1); // mono
      expect(wav.readUInt32LE(24)).toBe(22050);
      expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
      expect(sfxWav(preset, { seed: 3 }).equals(wav)).toBe(true);
      const samples = renderSfx(preset);
      expect(Math.max(...samples.map(Math.abs))).toBeGreaterThan(0.1); // audible
      expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(1);
    }
    expect(renderSfx('coin', { duration: 1 }).length).toBe(22050);
  });
});

describe('asset tools', () => {
  it('create_sound writes a WAV and declares it; sounds mapped to events show up in the run', async () => {
    const { ok, fail, dir } = setup();
    const r = await ok<{ changed: boolean; asset: { path: string; seconds: number } }>('create_sound', { id: 'boing', preset: 'jump', pitch: 1.2 });
    expect(r.asset.path).toBe('assets/sfx/boing.wav');
    expect(readFileSync(join(dir, 'assets', 'sfx', 'boing.wav')).subarray(0, 4).toString()).toBe('RIFF');
    const config = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(config.assets.at(-1)).toEqual({ id: 'boing', type: 'audio', path: 'sfx/boing.wav' });
    expect((await fail('create_sound', { id: 'boing', preset: 'coin' })).error).toMatch(/already exists; pass replace: true/);
    expect((await ok<{ changed: boolean }>('create_sound', { id: 'boing', preset: 'coin', replace: true })).changed).toBe(false); // same entry, new file

    await ok('modify_project_config', { patch: { sounds: { jump: 'boing' } } });
    expect((await fail('modify_project_config', { patch: { sounds: { stomp: 'hero' } } })).details).toEqual(['config.sounds.stomp: asset "hero" is not audio']);
    await ok('run_game');
    const obs = await ok<{ events: { type: string; asset?: string }[] }>('perform_inputs', { steps: [{ type: 'wait', ms: 200 }, { type: 'tap', key: 'Space' }] });
    expect(obs.events.filter((e) => e.type === 'sound')).toEqual([expect.objectContaining({ asset: 'boing', cause: 'jump' })]);
  });

  it('import_asset copies images and audio from outside the project and declares them', async () => {
    const { ok, fail, dir } = setup();
    const svg = fileOutsideProject('star.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>');
    const r = await ok<{ asset: { id: string; type: string; path: string } }>('import_asset', { source: svg, id: 'star', reason: 'user art' });
    expect(r.asset).toMatchObject({ id: 'star', type: 'image', path: 'assets/star.svg' });
    expect(existsSync(join(dir, 'assets', 'star.svg'))).toBe(true);

    const sheet = fileOutsideProject('walk.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await ok('import_asset', { source: sheet, id: 'walk', path: 'chars/walk.png', frameWidth: 16, frameHeight: 16 });
    const wav = fileOutsideProject('boom.wav', sfxWav('explosion'));
    await ok('import_asset', { source: wav, id: 'boom' });
    const assets = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).assets.slice(-3);
    expect(assets).toEqual([
      { id: 'star', type: 'image', path: 'star.svg' },
      { id: 'walk', type: 'spritesheet', path: 'chars/walk.png', frameWidth: 16, frameHeight: 16 },
      { id: 'boom', type: 'audio', path: 'boom.wav' },
    ]);

    expect((await fail('import_asset', { source: 'relative/file.png', id: 'x' })).error).toBe('source must be an absolute path');
    expect((await fail('import_asset', { source: fileOutsideProject('notes.txt', 'hi'), id: 'x' })).error).toMatch(/Unsupported file type ".txt"/);
    expect((await fail('import_asset', { source: svg, id: 'x', path: '../escape.svg' })).error).toMatch(/Invalid asset path/);
    expect((await fail('import_asset', { source: wav, id: 'x', type: 'image' })).error).toBe('A .wav file cannot be a image asset');
    // A rejected config change leaves no file behind.
    const sheet2 = fileOutsideProject('bad.png', Buffer.from([1, 2, 3]));
    const rejected = await fail('import_asset', { source: sheet2, id: 'bad', type: 'spritesheet' });
    expect(rejected.details).toEqual(['config.assets(bad): spritesheets need frameWidth and frameHeight']);
    expect(existsSync(join(dir, 'assets', 'bad.png'))).toBe(false);
  });
});
