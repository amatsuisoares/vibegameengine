const FRAMES_PER_SECOND = 60;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface ClockOptions {
  /** Date and time the game starts at: epoch ms or an ISO string. Default 2026-01-01 09:00 (UTC). */
  start?: number | string;
  /** Local time zone as minutes east of UTC (e.g. -180 for Brasília). Default 0. */
  utcOffsetMinutes?: number;
  /** Game-clock milliseconds per real millisecond (1 = real time). Default 1. */
  speed?: number;
}

export const DEFAULT_CLOCK_START = Date.UTC(2026, 0, 1, 9, 0, 0);
export const MAX_CLOCK_SPEED = 100_000;

function toEpoch(start: number | string | undefined): number {
  if (start === undefined) return DEFAULT_CLOCK_START;
  const ms = typeof start === 'number' ? start : Date.parse(start);
  if (!Number.isFinite(ms)) throw new Error(`Invalid clock start "${String(start)}"`);
  return ms;
}

export function checkSpeed(speed: number): number {
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0 || speed > MAX_CLOCK_SPEED) {
    throw new Error(`clock speed must be a number from 0 to ${MAX_CLOCK_SPEED} (got ${String(speed)})`);
  }
  return speed;
}

/**
 * The game's calendar clock (date and time of day), separate from simulation time.
 * It advances with the simulation (`speed` game-ms per simulated ms) and can jump ahead
 * (`advance`, e.g. the time the game was closed). Headless runs start it at a fixed date,
 * the browser at the real date — everything that reads it stays replayable.
 */
export class GameClock {
  readonly start: number;
  readonly utcOffsetMinutes: number;
  private readonly initialSpeed: number;
  // now = anchor + frames * (1000 / 60) * speed, recomputed from whole frames so it does not drift.
  private anchor: number;
  private frames = 0;
  private _speed: number;

  constructor(options: ClockOptions = {}) {
    this.start = toEpoch(options.start);
    this.utcOffsetMinutes = options.utcOffsetMinutes ?? 0;
    this.initialSpeed = checkSpeed(options.speed ?? 1);
    this.anchor = this.start;
    this._speed = this.initialSpeed;
  }

  get now(): number {
    return this.anchor + (this.frames * 1000 * this._speed) / FRAMES_PER_SECOND;
  }

  get speed(): number {
    return this._speed;
  }

  set speed(value: number) {
    this.anchor = this.now;
    this.frames = 0;
    this._speed = checkSpeed(value);
  }

  /** Advances by one fixed simulation frame (1/60 s). */
  tick() {
    this.frames++;
  }

  /** Jumps ahead (never back). */
  advance(ms: number) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error(`advanceClock: ms must be >= 0 (got ${String(ms)})`);
    this.anchor += ms;
  }

  reset() {
    this.anchor = this.start;
    this.frames = 0;
    this._speed = this.initialSpeed;
  }

  private get local() {
    return this.now + this.utcOffsetMinutes * MINUTE;
  }

  /** Local hour of day as a fraction, 0 <= hour < 24 (13.5 = 13:30). */
  get hour(): number {
    return (((this.local % DAY) + DAY) % DAY) / HOUR;
  }

  /** Local date and time, e.g. "2026-01-01T09:30:00". */
  get iso(): string {
    return new Date(this.local).toISOString().slice(0, 19);
  }

  snapshot() {
    return { now: Math.round(this.now), iso: this.iso, hour: Math.round(this.hour * 100) / 100, speed: this.speed };
  }
}
