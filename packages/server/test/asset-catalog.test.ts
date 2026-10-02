import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAssetCatalog, imageSize, placePrefab, sfxWav, wavSeconds } from '../src';
import { setup } from './helpers';

function png(width: number, height: number) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

describe('asset catalog', () => {
  it('reads image sizes and WAV lengths from the file headers', () => {
    expect(imageSize(png(64, 32), '.png')).toEqual({ width: 64, height: 32 });
    const gif = Buffer.alloc(10);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(20, 6);
    gif.writeUInt16LE(10, 8);
    expect(imageSize(gif, '.gif')).toEqual({ width: 20, height: 10 });
    // JPEG: SOI, an APP0 segment, then SOF0 with height 30 / width 40.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x28, 0x03, 0, 0, 0, 0]);
    expect(imageSize(jpeg, '.jpg')).toEqual({ width: 40, height: 30 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    expect(imageSize(webp, '.webp')).toEqual({ width: 100, height: 50 });
    expect(imageSize(Buffer.from('<svg xmlns="x" width="96px" height="32">'), '.svg')).toEqual({ width: 96, height: 32 });
    expect(imageSize(Buffer.from('<svg viewBox="0 0 12 8">'), '.svg')).toEqual({ width: 12, height: 8 });
    expect(imageSize(Buffer.from('nope'), '.png')).toBeNull();

    expect(wavSeconds(sfxWav('coin', { duration: 0.5 }))).toBeCloseTo(0.5, 2);
    expect(wavSeconds(Buffer.from('not a wav'))).toBeNull();
  });

  it('lists assets with sizes, frames, events and where they are used', () => {
    const { store } = setup();
    const cat = buildAssetCatalog(store);
    const hero = cat.assets.find((a) => a.id === 'hero')!;
    expect(hero).toMatchObject({ type: 'spritesheet', path: 'assets/hero.svg', width: 96, height: 32, warnings: [] });
    expect(hero.frames).toEqual({ frameWidth: 24, frameHeight: 32, columns: 4, rows: 1, count: 4 });
    expect(hero.uses).toContainEqual({ file: 'scenes/level1.json', at: 'entities.player.components.Sprite.asset' });
    const coin = cat.assets.find((a) => a.id === 'sfx_coin')!;
    expect(coin).toMatchObject({ type: 'audio', events: ['collect'] });
    expect(coin.seconds).toBeGreaterThan(0);
    expect(coin.uses).toContainEqual({ file: 'project.json', at: 'sounds.collect' });
    expect(cat.undeclared).toEqual([]);
  });

  it('flags missing files, frames that do not fit and files nobody declared', async () => {
    const { store, dir, ok } = setup();
    writeFileSync(join(dir, 'assets', 'extra.png'), png(10, 10));
    mkdirSync(join(dir, 'assets', 'music'));
    writeFileSync(join(dir, 'assets', 'music', 'theme.ogg'), 'x');
    rmSync(join(dir, 'assets', 'sfx', 'sfx_win.wav'));
    const config = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    const assets = config.assets.map((a: { id: string }) => (a.id === 'coin' ? { ...a, frameWidth: 20 } : a));
    await ok('modify_project_config', { patch: { assets } });

    const cat = buildAssetCatalog(store);
    expect(cat.undeclared).toEqual([
      { path: 'assets/extra.png', bytes: 24, kind: 'image' },
      { path: 'assets/music/theme.ogg', bytes: 1, kind: 'audio' },
    ]);
    expect(cat.assets.find((a) => a.id === 'sfx_win')).toMatchObject({ bytes: null, warnings: ['file assets/sfx/sfx_win.wav is missing'] });
    expect(cat.assets.find((a) => a.id === 'coin')!.warnings).toEqual(['image 64×16 is not a whole number of 20×16 frames']);
  });

  it('lists prefabs with instances and spawns, and scripts with who runs them', async () => {
    const { store, ok } = setup();
    await ok('create_prefab', { id: 'moeda', from: { scene: 'level1', id: 'coin2' }, link: true });
    await ok('set_rule', { scene: 'level1', rule: { id: 'mais', when: { start: true }, do: [{ action: 'spawn', prefab: 'moeda', x: 10, y: 10 }] } });
    const source = "function onUpdate(self, game) {\n  game.spawn('moeda', 0, 0);\n}\n";
    await ok('write_file', { path: 'scripts/gira.js', content: source });
    await ok('modify_game_object', { scene: 'level1', id: 'coin3', patch: { components: { Script: { src: 'scripts/gira.js' } } } });

    const cat = buildAssetCatalog(store);
    const moeda = cat.prefabs.find((p) => p.id === 'moeda')!;
    expect(moeda).toMatchObject({ file: 'prefabs/moeda.json', tags: ['coin'], instances: [{ scene: 'level1', id: 'coin2' }] });
    expect(moeda.components).toContain('Collectible');
    expect(moeda.sprite).toMatchObject({ asset: 'coin', width: 16 });
    expect(moeda.uses).toEqual([
      { file: 'scenes/level1.json', at: 'rules.mais.do[0].prefab' },
      { file: 'scripts/gira.js', at: 'line 2' },
    ]);
    expect(cat.scripts).toEqual([{ path: 'scripts/gira.js', lines: 4, bytes: source.length, uses: [{ file: 'scenes/level1.json', at: 'entities.coin3.components.Script.src' }] }]);
  });

  it('is available to the agent as list_assets, with filters', async () => {
    const { ok } = setup();
    const all = await ok<{ counts: Record<string, number>; assets: { id: string }[] }>('list_assets');
    expect(all.counts).toMatchObject({ assets: 8, prefabs: 0, scripts: 0, undeclared: 0 });
    const audio = await ok<{ assets: { type: string }[] }>('list_assets', { kind: 'audio' });
    expect(audio.assets.every((a) => a.type === 'audio')).toBe(true);
    const one = await ok<{ assets: { id: string }[] }>('list_assets', { id: 'coin' });
    expect(one.assets.map((a) => a.id)).toEqual(['coin']);
    // Every sound is mapped to an event and both images are used: nothing unused.
    expect((await ok<{ counts: Record<string, number> }>('list_assets', { unused: true })).counts).toEqual({ assets: 0, prefabs: 0, scripts: 0, undeclared: 0 });
    await ok('modify_project_config', { patch: { sounds: { lose: null } } });
    const unused = await ok<{ assets: { id: string }[] }>('list_assets', { unused: true });
    expect(unused.assets.map((a) => a.id)).toEqual(['sfx_lose']);
  });

  it('places a prefab instance in a scene as the user', async () => {
    const { store, ok } = setup();
    await ok('create_prefab', { id: 'moeda', from: { scene: 'level1', id: 'coin2' }, link: true });
    const r = await placePrefab(store, 'level1', 'moeda', 300.4, 200.6);
    expect(r).toEqual({ ok: true, id: 'moeda1' });
    expect(await placePrefab(store, 'level1', 'moeda', 0, 0)).toEqual({ ok: true, id: 'moeda2' });
    const placed = await ok<{ raw: unknown }>('get_game_object', { scene: 'level1', id: 'moeda1' });
    expect(placed.raw).toEqual({ id: 'moeda1', prefab: 'moeda', transform: { x: 300, y: 201 } });
    const history = await ok<{ entries: { author: string; reason?: string }[] }>('get_history');
    expect(history.entries.at(-1)).toMatchObject({ author: 'user', reason: 'Asset browser: place prefab moeda as moeda2 at (0, 0)' });
    expect(await placePrefab(store, 'level1', 'nope', 0, 0)).toMatchObject({ ok: false, error: 'Prefab "nope" does not exist' });
    expect(await placePrefab(store, 'nowhere', 'moeda', 0, 0)).toMatchObject({ ok: false, error: 'Scene "nowhere" does not exist' });
  });
});
