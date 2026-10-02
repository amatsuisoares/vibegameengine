import type { EntityInput } from '@vibe/shared';
import { parseProject } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { audioVoices, Game, listenerOf } from '../src';

const ASSETS = [
  { id: 'step', type: 'audio' as const, path: 'step.wav' },
  { id: 'hum', type: 'audio' as const, path: 'hum.ogg' },
  { id: 'pic', type: 'image' as const, path: 'pic.png' },
];

/** 800×450 view at (0, 0): the listener is (400, 225). */
function raw(entities: EntityInput[], rules: unknown[] = []) {
  return { config: { name: 't', startScene: 'main', assets: ASSETS }, scenes: { main: { id: 'main', width: 3000, entities, rules, camera: { x: 0, y: 0 } } } };
}
const game = (entities: EntityInput[], rules: unknown[] = []) => Game.fromRaw(raw(entities, rules));
const src = (id: string, x: number, audio: Record<string, unknown>, extra: Partial<EntityInput> = {}): EntityInput => ({
  id,
  transform: { x, y: 225 },
  components: { AudioSource: { clip: 'step', ...audio } },
  ...extra,
});
const sounds = (g: Game) => g.events(0, 'sound').map(({ frame, asset, volume, pan, entity }) => ({ frame, asset, volume, ...(pan !== undefined && { pan }), entity }));

describe('AudioSource', () => {
  it('plays a one-shot once, and again whenever playing is set (rules, scripts)', () => {
    const g = game(
      [src('door', 400, { volume: 0.8 })],
      [{ id: 'knock', when: { every: 500 }, do: [{ action: 'modify', target: 'door', component: 'AudioSource', set: { playing: true } }] }],
    );
    g.step(1);
    expect(sounds(g)).toEqual([{ frame: 0, asset: 'step', volume: 0.8, entity: 'door' }]);
    expect(g.entity('door')!.components.AudioSource!.playing).toBe(false);
    g.step(29);
    expect(sounds(g)).toHaveLength(1);
    g.step(2);
    expect(sounds(g)).toHaveLength(2);
    expect(g.events(0, 'sound')[1].cause).toBe('AudioSource');
  });

  it('waits for a disabled entity to be enabled', () => {
    const g = game([src('bell', 400, {}, { enabled: false })], [{ id: 'ring', when: { every: 100 }, do: [{ action: 'setEnabled', target: 'bell', enabled: true }] }]);
    g.step(3);
    expect(sounds(g)).toEqual([]);
    g.step(5);
    expect(sounds(g)).toHaveLength(1);
  });

  it('lists the loops sounding now, for the runtime to mix', () => {
    const g = game([
      src('fan', 400, { clip: 'hum', loop: true, volume: 0.5 }),
      src('off', 400, { clip: 'hum', loop: true, playing: false }),
      src('hidden', 400, { clip: 'hum', loop: true }, { enabled: false }),
    ]);
    g.step(1);
    expect(audioVoices(g.world)).toEqual([{ entity: 'fan', asset: 'hum', volume: 0.5, pan: 0 }]);
    // Loops never become sound events.
    expect(sounds(g)).toEqual([]);
    g.entity('fan')!.components.AudioSource!.playing = false;
    expect(audioVoices(g.world)).toEqual([]);
  });

  it('fades and pans spatial sources with the distance to the camera center', () => {
    const g = game([
      src('near', 400, { loop: true, spatial: true }),
      src('right', 500, { loop: true, spatial: true, falloff: 200 }),
      src('left', 250, { loop: true, spatial: true, falloff: 300 }),
      src('far', 1400, { loop: true, spatial: true }),
      src('flat', 1400, { loop: true }),
    ]);
    expect(listenerOf(g.world)).toEqual({ x: 400, y: 225 });
    const mix = Object.fromEntries(audioVoices(g.world).map((v) => [v.entity, [v.volume, v.pan]]));
    expect(mix).toEqual({ near: [1, 0], right: [0.5, 0.5], left: [0.5, -0.5], far: [0, 1], flat: [1, 0] });
    // The camera moving changes what is heard.
    g.world.camera.x = 100;
    expect(audioVoices(g.world).find((v) => v.entity === 'right')).toMatchObject({ volume: 1, pan: 0 });
  });

  it('mixes spatial one-shots when they play, and shows the source in the snapshot', () => {
    const g = game([src('step', 300, { spatial: true, falloff: 200 })]);
    g.step(1);
    expect(sounds(g)).toEqual([{ frame: 0, asset: 'step', volume: 0.5, pan: -0.5, entity: 'step' }]);
    expect(g.getState({ ids: ['step'] }).entities[0].audio).toEqual({ clip: 'step', loop: false, playing: false, volume: 0.5, pan: -0.5 });
  });

  it('requires an audio asset as clip', () => {
    const errors = (r: ReturnType<typeof parseProject>) => (r.ok ? [] : r.errors);
    expect(errors(parseProject(raw([src('a', 0, { clip: 'nope' })])))).toContain('scenes.main.entities(a).components.AudioSource.clip: audio asset "nope" does not exist');
    expect(errors(parseProject(raw([src('a', 0, { clip: 'pic' })])))).toContain('scenes.main.entities(a).components.AudioSource.clip: asset "pic" is image, not audio');
  });
});
