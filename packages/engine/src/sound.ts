import type { SoundRef } from '@vibe/shared';
import type { World } from './world';

/**
 * Sound is an event, like everything the game reports: the simulation emits `sound`
 * ({ asset, volume, cause? }) and `music` ({ asset | null, volume }) events, the browser
 * runtime plays them, and the agent can check them in read_events / events('sound')
 * without hearing anything. Playing audio never affects the simulation.
 */
export function soundOf(ref: SoundRef): { asset: string; volume: number } {
  return typeof ref === 'string' ? { asset: ref, volume: 1 } : { asset: ref.asset, volume: ref.volume };
}

export function emitSound(world: World, asset: string, volume = 1, cause?: string) {
  const def = world.config.assets.find((a) => a.id === asset);
  if (!def) throw new Error(`audio asset "${asset}" does not exist`);
  if (def.type !== 'audio') throw new Error(`asset "${asset}" is ${def.type}, not audio`);
  world.emit('sound', { asset, volume, ...(cause && { cause }) });
}

/** Plays the sounds mapped to event types in config.sounds (e.g. jump -> sfx_jump). */
export class SoundDirector {
  private processed: number;

  constructor(private readonly world: World) {
    this.processed = world.emitted;
  }

  run() {
    const w = this.world;
    const sounds = w.config.sounds;
    const count = Math.min(w.emitted - this.processed, w.events.length);
    const fresh = count > 0 ? w.events.slice(-count) : [];
    for (const ev of fresh) {
      const ref = ev.type !== 'sound' && ev.type !== 'music' ? sounds[ev.type] : undefined;
      if (ref) {
        const { asset, volume } = soundOf(ref);
        w.emit('sound', { asset, volume, cause: ev.type });
      }
    }
    this.processed = w.emitted;
  }
}
