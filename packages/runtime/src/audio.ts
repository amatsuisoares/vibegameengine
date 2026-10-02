import type { AudioVoice, GameEvent } from '@vibe/engine';
import type { Asset } from '@vibe/shared';

/** A clip that is playing: it can be stopped, and its volume and stereo position changed. */
export interface PlayingSound {
  stop(): void;
  set(volume: number, pan: number): void;
}

/** What actually makes noise; the browser uses Web Audio, tests use a recorder. */
export interface AudioBackend<C = unknown> {
  load(url: string): Promise<C>;
  /** Starts a clip (pan: -1 left .. 1 right). */
  play(clip: C, options: { volume: number; loop: boolean; pan?: number }): PlayingSound;
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
  /** Loops of AudioSource entities sounding now, by entity id. */
  private readonly voices = new Map<string, { asset: string; sound: PlayingSound; volume: number; pan: number }>();
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
        if (clip) this.backend.play(clip, { volume: (ev.volume as number) ?? 1, loop: false, ...(typeof ev.pan === 'number' && { pan: ev.pan }) });
      }
    }
  }

  /**
   * Makes the AudioSource loops match the game (audioVoices, read every frame like the drawing):
   * starts new ones, stops those gone, follows volume and pan.
   */
  updateVoices(voices: readonly AudioVoice[]) {
    const wanted = new Map(this.muted ? [] : voices.map((v) => [v.entity, v]));
    for (const [id, v] of this.voices) {
      const next = wanted.get(id);
      if (next && next.asset === v.asset) continue;
      v.sound.stop();
      this.voices.delete(id);
    }
    for (const [id, v] of wanted) {
      const cur = this.voices.get(id);
      if (cur) {
        if (cur.volume !== v.volume || cur.pan !== v.pan) {
          cur.sound.set(v.volume, v.pan);
          cur.volume = v.volume;
          cur.pan = v.pan;
        }
        continue;
      }
      const clip = this.clip(v.asset);
      if (clip) this.voices.set(id, { asset: v.asset, sound: this.backend.play(clip, { volume: v.volume, loop: true, pan: v.pan }), volume: v.volume, pan: v.pan });
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (muted) this.updateVoices([]);
    if (muted) this.stopCurrentMusic();
    else if (this.musicAsset) this.setMusic(this.musicAsset, this.musicVolume, true);
  }

  stopAll() {
    this.updateVoices([]);
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
    if (clip) {
      const music = this.backend.play(clip, { volume, loop: true });
      this.stopMusic = () => music.stop();
    }
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
    play(buffer, { volume, loop, pan = 0 }) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      const gain = ctx.createGain();
      gain.gain.value = volume;
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      source.connect(gain).connect(panner).connect(ctx.destination);
      source.start();
      return {
        stop() {
          try {
            source.stop();
          } catch {
            // Already stopped.
          }
        },
        set(v, p) {
          // A short ramp: moving sources change volume every frame without clicks.
          gain.gain.setTargetAtTime(v, ctx.currentTime, 0.03);
          panner.pan.setTargetAtTime(p, ctx.currentTime, 0.03);
        },
      };
    },
  };
}
