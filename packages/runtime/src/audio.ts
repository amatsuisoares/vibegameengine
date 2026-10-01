import type { GameEvent } from '@vibe/engine';
import type { Asset } from '@vibe/shared';

/** What actually makes noise; the browser uses Web Audio, tests use a recorder. */
export interface AudioBackend<C = unknown> {
  load(url: string): Promise<C>;
  /** Starts a clip; returns a function that stops it. */
  play(clip: C, options: { volume: number; loop: boolean }): () => void;
}

/** Sounds older than this (in frames) are dropped: when the view fast-forwards, it does not play a burst. */
const MAX_SOUND_AGE = 6;

/**
 * Plays the `sound` and `music` events a game emits. Loads the project's audio assets
 * up front; unknown or failed assets are reported once and skipped. Never touches the game.
 */
export class SoundPlayer<C = unknown> {
  private readonly clips = new Map<string, C>();
  private readonly failures = new Map<string, string>();
  private stopMusic: (() => void) | null = null;
  private musicAsset: string | null = null;
  private musicVolume = 1;
  private readonly reported = new Set<string>();
  muted = false;

  constructor(
    private readonly assets: readonly Asset[],
    private readonly baseUrl: string,
    private readonly backend: AudioBackend<C>,
    private readonly onWarning: (message: string) => void = () => {},
  ) {}

  /** Loads every audio asset; returns load errors (`Asset "id": ...`). */
  async loadAll(): Promise<string[]> {
    const errors: string[] = [];
    await Promise.all(
      this.assets
        .filter((a) => a.type === 'audio')
        .map(async (a) => {
          try {
            this.clips.set(a.id, await this.backend.load(this.baseUrl + a.path.split('/').map(encodeURIComponent).join('/')));
          } catch (err) {
            const message = `failed to load "${a.path}": ${err instanceof Error ? err.message : String(err)}`;
            this.failures.set(a.id, message);
            errors.push(`Asset "${a.id}": ${message}`);
          }
        }),
    );
    return errors;
  }

  /** Handles new events; `frame` is the game's current frame (old sounds are skipped). */
  handle(events: readonly GameEvent[], frame: number) {
    for (const ev of events) {
      if (ev.type === 'music') this.setMusic((ev.asset as string | null) ?? null, (ev.volume as number) ?? 1);
      else if (ev.type === 'sound' && frame - ev.frame <= MAX_SOUND_AGE && !this.muted) {
        const clip = this.clip(ev.asset as string);
        if (clip) this.backend.play(clip, { volume: (ev.volume as number) ?? 1, loop: false });
      }
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.stopCurrentMusic();
    else if (this.musicAsset) this.setMusic(this.musicAsset, this.musicVolume, true);
  }

  stopAll() {
    this.stopCurrentMusic();
    this.musicAsset = null;
  }

  private setMusic(asset: string | null, volume: number, force = false) {
    if (asset === this.musicAsset && this.stopMusic && !force) return;
    this.stopCurrentMusic();
    this.musicAsset = asset;
    this.musicVolume = volume;
    if (!asset || this.muted) return;
    const clip = this.clip(asset);
    if (clip) this.stopMusic = this.backend.play(clip, { volume, loop: true });
  }

  private stopCurrentMusic() {
    this.stopMusic?.();
    this.stopMusic = null;
  }

  private clip(asset: string): C | undefined {
    const clip = this.clips.get(asset);
    if (!clip && !this.reported.has(asset)) {
      this.reported.add(asset);
      this.onWarning(`Sound "${asset}" cannot be played: ${this.failures.get(asset) ?? 'not an audio asset of this project'}`);
    }
    return clip;
  }
}

/**
 * Web Audio backend. Browsers only start audio after a user gesture, so the context is
 * resumed on the first key press or click on the page.
 */
export function createWebAudioBackend(target: EventTarget = window): AudioBackend<AudioBuffer> {
  const ctx = new AudioContext();
  const resume = () => void ctx.resume().catch(() => {});
  for (const type of ['keydown', 'pointerdown']) target.addEventListener(type, resume);
  return {
    async load(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ctx.decodeAudioData(await res.arrayBuffer());
    },
    play(buffer, { volume, loop }) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain).connect(ctx.destination);
      source.start();
      return () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
      };
    },
  };
}
