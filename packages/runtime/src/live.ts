import type { GameOp } from '@vibe/engine';

/** How far the view may trail the agent's run before it fast-forwards (3 s). */
export const DEFAULT_MAX_LAG_FRAMES = 180;

/**
 * Plays the op log of the agent's published run (follow mode) at real-time pace.
 * Step ops are spread over several ticks; other ops (key presses, restart...) are applied
 * when reached, so the replay goes through exactly the same states as the headless run.
 * The agent simulates much faster than real time: when the view trails it by more than
 * `maxLagFrames`, the excess is played at once.
 */
export class LivePlayer {
  /** Number of ops of the run's log received so far. */
  received = 0;
  private queue: GameOp[] = [];
  /** Frames already played of queue[0] (when it is a step op). */
  private partial = 0;

  constructor(
    private readonly apply: (op: GameOp) => void,
    readonly maxLagFrames = DEFAULT_MAX_LAG_FRAMES,
  ) {}

  push(ops: GameOp[]) {
    this.queue.push(...ops);
    this.received += ops.length;
  }

  /** Forget everything (a new run starts). */
  reset() {
    this.queue = [];
    this.partial = 0;
    this.received = 0;
  }

  /** Frames still to be played. */
  get backlog(): number {
    return this.queue.reduce((n, op) => n + (op.op === 'step' ? op.frames : 0), 0) - this.partial;
  }

  /** Plays `frames` frames of the log (more when trailing beyond the lag limit). Returns the frames played. */
  play(frames: number): number {
    const budget = Math.max(frames, this.backlog - this.maxLagFrames);
    let played = 0;
    while (this.queue.length) {
      const op = this.queue[0];
      if (op.op !== 'step') {
        this.apply(op);
        this.queue.shift();
        continue;
      }
      const n = Math.min(op.frames - this.partial, budget - played);
      if (n > 0) {
        this.apply({ op: 'step', frames: n });
        played += n;
        this.partial += n;
      }
      if (this.partial < op.frames) break;
      this.queue.shift();
      this.partial = 0;
    }
    return played;
  }
}
