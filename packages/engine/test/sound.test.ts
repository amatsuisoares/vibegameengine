import type { EntityInput, ProjectInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { ground, GROUND_TOP, player, trigger } from './helpers';

const ASSETS = [
  { id: 'sfx_jump', type: 'audio' as const, path: 'sfx/jump.wav' },
  { id: 'sfx_coin', type: 'audio' as const, path: 'sfx/coin.wav' },
  { id: 'theme', type: 'audio' as const, path: 'music/theme.ogg' },
  { id: 'pic', type: 'image' as const, path: 'pic.png' },
];

function game(entities: EntityInput[], extra: Partial<ProjectInput> & { scene?: Record<string, unknown> } = {}) {
  const { scene, ...rest } = extra;
  return Game.fromRaw({
    config: { name: 't', startScene: 'main', assets: ASSETS, sounds: { jump: 'sfx_jump', collect: { asset: 'sfx_coin', volume: 0.5 } } },
    scenes: {
      main: { id: 'main', width: 3000, music: 'theme', entities, ...scene },
      quiet: { id: 'quiet', entities: [] },
    },
    ...rest,
  });
}

const sounds = (g: Game) => g.events(0, 'sound').map(({ frame: _f, type: _t, ...rest }) => rest);

describe('sound events', () => {
  it('plays the sounds mapped to gameplay events and the scene music', () => {
    const g = game([player(), ground('g', 0, 1000), trigger('c1', 160, GROUND_TOP - 16, { Collectible: {} })]);
    expect(g.events(0, 'music')).toEqual([{ frame: 0, type: 'music', asset: 'theme', volume: 1 }]);
    g.perform([{ type: 'hold', key: 'D', ms: 600 }, { type: 'tap', key: 'Space' }, { type: 'wait', ms: 300 }]);
    expect(sounds(g)).toEqual([
      { asset: 'sfx_coin', volume: 0.5, cause: 'collect' },
      { asset: 'sfx_jump', volume: 1, cause: 'jump' },
    ]);
    // Each sound is emitted in the same frame as its cause.
    expect(g.events(0, 'sound')[1].frame).toBe(g.events(0, 'jump')[0].frame);
  });

  it('stops the music when a scene without music is loaded', () => {
    const g = game([player()]);
    g.loadScene('quiet');
    expect(g.events(0, 'music').map((e) => e.asset)).toEqual(['theme', null]);
  });

  it('rules and scripts can play sounds; non-audio assets are rejected', () => {
    const g = game([player(), { id: 'box', components: { Script: { src: 'scripts/s.js' } } }], {
      scene: { rules: [{ id: 'hi', when: { start: true }, do: [{ action: 'playSound', asset: 'sfx_coin', volume: 0.3 }] }] },
      scripts: { 'scripts/s.js': 'function onUpdate(self, game) { if (game.frame === 2) game.playSound("sfx_jump", 0.8); if (game.frame === 3) game.playSound("pic"); }' },
    });
    g.step(5);
    expect(sounds(g)).toEqual([
      { asset: 'sfx_coin', volume: 0.3, cause: 'rule:hi' },
      { asset: 'sfx_jump', volume: 0.8, cause: 'script' },
    ]);
    expect(g.console.read(0, 'error')[0].message).toMatch(/asset "pic" is image, not audio/);
  });

  it('validates sound references', () => {
    const bad = () =>
      Game.fromRaw({
        config: { name: 't', startScene: 'main', assets: ASSETS, sounds: { jump: 'nope', stomp: 'pic' } },
        scenes: { main: { id: 'main', music: { asset: 'nope2' }, rules: [{ id: 'r', when: { start: true }, do: [{ action: 'playSound', asset: 'x' }] }] } },
      });
    expect(bad).toThrow(/config\.sounds\.jump: audio asset "nope" does not exist/);
    expect(bad).toThrow(/config\.sounds\.stomp: asset "pic" is not audio/);
    expect(bad).toThrow(/scenes\.main\.music: audio asset "nope2" does not exist/);
    expect(bad).toThrow(/scenes\.main\.rules\(r\)\.do\[0\]\.asset: audio asset "x" does not exist/);
  });
});
