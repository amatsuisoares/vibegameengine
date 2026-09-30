import { FIXED_DT } from '@vibe/engine';

/**
 * Real-time driver for the fixed-step simulation. Accumulates wall-clock time and
 * steps whole frames; the simulation itself never sees real time.
 */
export class FixedLoop {
  private last: number | null = null;
  private acc = 0;
  /** 1 = real time, 0.5 = slow motion. */
  timeScale = 1;

  constructor(
    private readonly stepFrames: (frames: number) => void,
    /** Upper bound per tick so a long stall (tab in background) does not freeze the page. */
    private readonly maxFramesPerTick = 5,
  ) {}

  /** Call with a monotonic timestamp in ms (e.g. from requestAnimationFrame). Returns frames stepped. */
  tick(nowMs: number): number {
    if (this.last === null) {
      this.last = nowMs;
      return 0;
    }
    const dt = Math.max(0, nowMs - this.last) / 1000;
    this.last = nowMs;
    this.acc += dt * this.timeScale;
    let frames = Math.floor(this.acc / FIXED_DT + 1e-6);
    this.acc -= frames * FIXED_DT;
    if (frames > this.maxFramesPerTick) {
      frames = this.maxFramesPerTick;
      this.acc = 0;
    }
    if (this.acc < 0) this.acc = 0;
    if (frames > 0) this.stepFrames(frames);
    return frames;
  }

  /** Forget elapsed time (after pausing) so the game does not jump ahead. */
  reset() {
    this.last = null;
    this.acc = 0;
  }
}
