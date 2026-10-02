import type { Entity } from './entity';
import { round2 } from './math';
import type { World } from './world';

/**
 * AudioSource (V0.6): sound attached to an entity. Like every sound, it stays out of the
 * simulation: one-shots become `sound` events (with the entity, and volume / pan already mixed),
 * and continuous loops are a mix the runtime reads every frame (audioVoices) — the same way it
 * reads the World to draw. The agent sees both (events, and `audio` in the entity snapshot).
 *
 * Spatial sources are heard from the listener, the center of the camera view: the volume falls
 * linearly to 0 at `falloff` px and the sound pans with the horizontal offset.
 */

/** A loop that should be sounding now. */
export interface AudioVoice {
  entity: string;
  asset: string;
  /** Effective volume (0..1), after distance. */
  volume: number;
  /** Stereo position: -1 = left, 0 = center, 1 = right. */
  pan: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Where spatial sounds are heard from: the center of the camera view. */
export function listenerOf(world: World): { x: number; y: number } {
  const cam = world.camera;
  return { x: round2(cam.x + world.config.width / 2 / cam.zoom), y: round2(cam.y + world.config.height / 2 / cam.zoom) };
}

/** Volume and pan of an entity's AudioSource as heard now. */
export function audioMix(world: World, e: Entity): { volume: number; pan: number } {
  const c = e.components.AudioSource!;
  if (!c.spatial) return { volume: c.volume, pan: 0 };
  const l = listenerOf(world);
  const d = Math.hypot(e.x - l.x, e.y - l.y);
  const gain = Math.max(0, 1 - d / c.falloff);
  return { volume: r3(c.volume * gain), pan: r3(Math.max(-1, Math.min(1, (e.x - l.x) / c.falloff))) };
}

/** Plays one-shots whose `playing` turned true (then resets it, so setting it again replays). */
export function audioSourceSystem(world: World) {
  for (const e of world.entities) {
    const c = e.components.AudioSource;
    if (!c || c.loop || !c.playing || !e.active) continue;
    c.playing = false;
    const { volume, pan } = audioMix(world, e);
    world.emit('sound', { asset: c.clip, volume, ...(pan && { pan }), entity: e.id, cause: 'AudioSource' });
  }
}

/** The loops sounding now: active entities with a looping AudioSource that is playing. */
export function audioVoices(world: World): AudioVoice[] {
  const out: AudioVoice[] = [];
  for (const e of world.entities) {
    const c = e.components.AudioSource;
    if (!c?.loop || !c.playing || !e.active) continue;
    out.push({ entity: e.id, asset: c.clip, ...audioMix(world, e) });
  }
  return out;
}
