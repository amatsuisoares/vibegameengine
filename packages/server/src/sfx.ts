/**
 * Tiny procedural sound-effect synthesizer (retro "sfxr" style) so the agent can give a
 * game sounds without binary files: each preset is a few oscillators with pitch sweeps
 * and envelopes, rendered to a 16-bit mono WAV. Deterministic for a given seed.
 */
export const SFX_PRESETS = ['coin', 'jump', 'hit', 'powerup', 'explosion', 'blip', 'laser', 'win', 'lose'] as const;
export type SfxPreset = (typeof SFX_PRESETS)[number];

export interface SfxOptions {
  /** Multiplies every frequency (0.25..4). */
  pitch?: number;
  /** Seconds; default depends on the preset. */
  duration?: number;
  /** Peak amplitude 0..1 (default 0.6). */
  volume?: number;
  seed?: number;
}

const RATE = 22050;

type Wave = 'square' | 'saw' | 'sine' | 'triangle';

function osc(wave: Wave, phase: number) {
  const p = phase - Math.floor(phase);
  switch (wave) {
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'saw':
      return 2 * p - 1;
    case 'triangle':
      return 1 - 4 * Math.abs(p - 0.5);
    case 'sine':
      return Math.sin(2 * Math.PI * p);
  }
}

interface Voice {
  wave: Wave | 'noise';
  /** Frequency (Hz) at time t in [0, 1] of the sound (ignored for noise). */
  freq: (t: number) => number;
  /** Amplitude envelope at t in [0, 1]. */
  env: (t: number) => number;
  gain?: number;
}

const decay = (k: number) => (t: number) => Math.exp(-k * t);
const linear = (t: number) => 1 - t;
const sweep = (from: number, to: number) => (t: number) => from + (to - from) * t;
const steps = (notes: number[]) => (t: number) => notes[Math.min(notes.length - 1, Math.floor(t * notes.length))];

const PRESETS: Record<SfxPreset, { duration: number; voices: Voice[] }> = {
  coin: { duration: 0.3, voices: [{ wave: 'square', freq: (t) => (t < 0.25 ? 988 : 1319), env: decay(4), gain: 0.5 }] },
  jump: { duration: 0.22, voices: [{ wave: 'square', freq: sweep(260, 640), env: linear, gain: 0.45 }] },
  hit: {
    duration: 0.2,
    voices: [
      { wave: 'noise', freq: () => 0, env: decay(8), gain: 0.6 },
      { wave: 'square', freq: sweep(220, 70), env: decay(6), gain: 0.4 },
    ],
  },
  powerup: { duration: 0.5, voices: [{ wave: 'square', freq: steps([523, 659, 784, 1047, 784, 1047, 1319, 1568]), env: linear, gain: 0.4 }] },
  explosion: { duration: 0.7, voices: [{ wave: 'noise', freq: () => 0, env: decay(5), gain: 0.9 }] },
  blip: { duration: 0.08, voices: [{ wave: 'sine', freq: () => 880, env: linear, gain: 0.7 }] },
  laser: { duration: 0.25, voices: [{ wave: 'saw', freq: sweep(1400, 250), env: decay(3), gain: 0.4 }] },
  win: { duration: 0.8, voices: [{ wave: 'triangle', freq: steps([523, 659, 784, 1047]), env: (t) => (t < 0.75 ? 1 : (1 - t) * 4), gain: 0.7 }] },
  lose: { duration: 0.8, voices: [{ wave: 'square', freq: sweep(440, 110), env: linear, gain: 0.4 }] },
};

/** Renders a preset to 16-bit mono PCM samples in [-1, 1]. */
export function renderSfx(preset: SfxPreset, options: SfxOptions = {}): Float32Array {
  const def = PRESETS[preset];
  const pitch = Math.min(4, Math.max(0.25, options.pitch ?? 1));
  const duration = Math.min(3, Math.max(0.03, options.duration ?? def.duration));
  const volume = Math.min(1, Math.max(0, options.volume ?? 0.6));
  const n = Math.round(duration * RATE);
  const out = new Float32Array(n);
  let seed = (options.seed ?? 1) >>> 0 || 1;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  for (const v of def.voices) {
    let phase = 0;
    let low = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      let s: number;
      if (v.wave === 'noise') {
        low += (noise() - low) * 0.35; // one-pole low-pass: a rumble rather than hiss
        s = low * 2;
      } else {
        phase += (v.freq(t) * pitch) / RATE;
        s = osc(v.wave, phase);
      }
      out[i] += s * v.env(t) * (v.gain ?? 1);
    }
  }
  // Short fades avoid clicks at both ends.
  const fade = Math.min(64, n >> 2);
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[n - 1 - i] *= i / fade;
  }
  for (let i = 0; i < n; i++) out[i] = Math.max(-1, Math.min(1, out[i] * volume));
  return out;
}

/** Encodes samples as a 16-bit mono PCM WAV file. */
export function encodeWav(samples: Float32Array, rate = RATE): Buffer {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  return buf;
}

export function sfxWav(preset: SfxPreset, options?: SfxOptions): Buffer {
  return encodeWav(renderSfx(preset, options));
}
