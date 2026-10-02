import { Game, type GameEvent } from '@vibe/engine';
import { assertProject, type Asset } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Runtime, SoundPlayer, type AudioBackend } from '../src';
import { fakeCanvas, manualScheduler } from './helpers';

function recorder(failing: string[] = []) {
  const log: string[] = [];
  const backend: AudioBackend<string> = {
    load: async (url) => {
      if (failing.some((f) => url.endsWith(f))) throw new Error('HTTP 404');
      log.push(`load ${url}`);
      return url.split('/').pop()!;
    },
    play: (clip, { volume, loop, pan }) => {
      log.push(`play ${clip} ${volume}${loop ? ' loop' : ''}${pan ? ` pan ${pan}` : ''}`);
      return { stop: () => log.push(`stop ${clip}`), set: (v, p) => log.push(`set ${clip} ${v} ${p}`) };
    },
  };
  return { log, backend };
}

const ASSETS: Asset[] = [
  { id: 'coin', type: 'audio', path: 'sfx/coin.wav' },
  { id: 'theme', type: 'audio', path: 'theme.ogg' },
  { id: 'other', type: 'audio', path: 'other.ogg' },
  { id: 'pic', type: 'image', path: 'pic.png' },
];
const ev = (frame: number, type: string, data: Record<string, unknown>): GameEvent => ({ frame, type, ...data });

describe('SoundPlayer', () => {
  it('loads audio assets only and reports failures', async () => {
    const { log, backend } = recorder(['other.ogg']);
    const player = new SoundPlayer(ASSETS, '/projects/p/assets/', backend);
    expect(await player.loadAll()).toEqual(['Asset "other": failed to load "other.ogg": HTTP 404']);
    expect(log).toEqual(['load /projects/p/assets/sfx/coin.wav', 'load /projects/p/assets/theme.ogg']);
  });

  it('plays recent sounds, loops music, switches and stops it, and honors mute', async () => {
    const { log, backend } = recorder();
    const warnings: string[] = [];
    const player = new SoundPlayer(ASSETS, '/a/', backend, (w) => warnings.push(w));
    await player.loadAll();
    log.length = 0;

    player.handle([ev(0, 'music', { asset: 'theme', volume: 0.5 }), ev(10, 'sound', { asset: 'coin', volume: 1 }), ev(2, 'sound', { asset: 'coin', volume: 1 })], 10);
    expect(log).toEqual(['play theme.ogg 0.5 loop', 'play coin.wav 1']); // the frame-2 sound is too old (fast-forward)
    player.handle([ev(11, 'music', { asset: 'theme', volume: 0.5 })], 11);
    expect(log).toHaveLength(2); // same music keeps playing
    player.handle([ev(12, 'music', { asset: 'other' }), ev(12, 'sound', { asset: 'pic' }), ev(12, 'sound', { asset: 'pic' })], 12);
    expect(log.slice(2)).toEqual(['stop theme.ogg', 'play other.ogg 1 loop']);
    expect(warnings).toEqual(['Sound "pic" cannot be played: not an audio asset of this project']);

    player.setMuted(true);
    player.handle([ev(13, 'sound', { asset: 'coin', volume: 1 })], 13);
    expect(log.slice(4)).toEqual(['stop other.ogg']);
    player.setMuted(false);
    expect(log.slice(5)).toEqual(['play other.ogg 1 loop']);
    player.handle([ev(14, 'music', { asset: null })], 14);
    expect(log.at(-1)).toBe('stop other.ogg');
  });
});

describe('Runtime.onEvents', () => {
  it('hands over each new event once, also after a restart', () => {
    const seen: string[] = [];
    const scheduler = manualScheduler();
    const p = assertProject({
      config: { name: 't', startScene: 'main' },
      scenes: { main: { id: 'main', entities: [{ id: 'a', components: { Script: { src: 'scripts/e.js' } } }] } },
      scripts: { 'scripts/e.js': 'function onUpdate(self, game) { if (game.frame % 2 === 0) game.emit("tick"); }' },
    });
    const rt = new Runtime(fakeCanvas().canvas, p, { scheduler: scheduler.scheduler, paused: true, onEvents: (evs) => seen.push(...evs.map((e) => `${e.type}@${e.frame}`)) });
    rt.start();
    scheduler.run(0);
    expect(seen).toEqual(['scene_loaded@0']);
    rt.game.step(4);
    scheduler.run(16);
    expect(seen.slice(1)).toEqual(['tick@0', 'tick@2']);
    rt.restart();
    scheduler.run(32);
    expect(seen.slice(3)).toEqual(['scene_loaded@0']);
    expect(rt.game).toBeInstanceOf(Game);
  });
});

describe('AudioSource voices', () => {
  const voice = (entity: string, asset: string, volume = 1, pan = 0) => ({ entity, asset, volume, pan });

  it('starts, follows, stops and mutes the loops of the game', async () => {
    const { log, backend } = recorder();
    const player = new SoundPlayer(ASSETS, '/a/', backend);
    await player.loadAll();
    log.length = 0;

    player.updateVoices([voice('fan', 'theme', 0.5, -0.25), voice('radio', 'other')]);
    expect(log).toEqual(['play theme.ogg 0.5 loop pan -0.25', 'play other.ogg 1 loop']);
    player.updateVoices([voice('fan', 'theme', 0.5, -0.25), voice('radio', 'other')]);
    expect(log).toHaveLength(2); // nothing changed: nothing restarted
    player.updateVoices([voice('fan', 'theme', 0.2, 0.5)]);
    expect(log.slice(2)).toEqual(['stop other.ogg', 'set theme.ogg 0.2 0.5']);
    player.updateVoices([voice('fan', 'coin', 0.2, 0.5)]); // another clip: restarted
    expect(log.slice(4)).toEqual(['stop theme.ogg', 'play coin.wav 0.2 loop pan 0.5']);

    player.setMuted(true);
    expect(log.at(-1)).toBe('stop coin.wav');
    player.updateVoices([voice('fan', 'coin')]);
    expect(log).toHaveLength(7);
    player.setMuted(false);
    player.updateVoices([voice('fan', 'coin')]);
    expect(log.at(-1)).toBe('play coin.wav 1 loop');
    player.stopAll();
    expect(log.at(-1)).toBe('stop coin.wav');
  });

  it('plays one-shots with their pan, and the runtime hands it the voices every frame', async () => {
    const { log, backend } = recorder();
    const player = new SoundPlayer(ASSETS, '/a/', backend);
    await player.loadAll();
    player.handle([ev(1, 'sound', { asset: 'coin', volume: 0.5, pan: 0.75 })], 1);
    expect(log.at(-1)).toBe('play coin.wav 0.5 pan 0.75');

    const frames: number[] = [];
    const scheduler = manualScheduler();
    const p = assertProject({ config: { name: 't', startScene: 'main' }, scenes: { main: { id: 'main', entities: [] } } });
    const rt = new Runtime(fakeCanvas().canvas, p, { scheduler: scheduler.scheduler, paused: true, onFrame: (g) => frames.push(g.frame) });
    rt.start();
    scheduler.run(0);
    scheduler.run(16);
    expect(frames).toEqual([0, 0]);
  });
});
