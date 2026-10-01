import { createHash } from 'node:crypto';
import { evaluateExpr, ExprError, Game, msToFrames, type EntitySnapshot, type GameEvent, type GameOp, type LogEntry } from '@vibe/engine';
import type { Project } from '@vibe/shared';
import { ToolError } from '../project-store';

export type RawProject = { config: unknown; scenes: Record<string, unknown> };

export function fingerprint(raw: RawProject) {
  return createHash('sha1').update(JSON.stringify(raw)).digest('hex');
}

export interface SessionOptions {
  seed: number;
  scene?: string;
}

/** What changed since the previous observation; returned after every action so the agent sees effects. */
export interface Observation {
  frame: number;
  time: number;
  status: string;
  scene: string;
  keysDown: string[];
  players?: EntitySnapshot[];
  events: GameEvent[];
  eventsTruncated?: number;
  console: LogEntry[];
}

const MAX_EVENTS = 30;
const MAX_CONSOLE = 20;
let counter = 0;

/**
 * A headless game run owned by the RuntimeHost. Every action is recorded as a
 * primitive GameOp, so the run can be replayed exactly (e.g. in Chromium for screenshots).
 */
export class GameSession {
  readonly id = `run-${Date.now().toString(36)}-${++counter}`;
  readonly ops: GameOp[] = [];
  readonly game: Game;
  /** Last event already reported (events of one frame can arrive before and after an observation). */
  private lastEvent: GameEvent | undefined;
  private obsSeq = 0;

  constructor(
    readonly raw: RawProject,
    readonly project: Project,
    readonly options: SessionOptions,
    readonly fingerprint: string,
  ) {
    this.game = new Game(project, { seed: options.seed, scene: options.scene });
    this.obsSeq = this.game.console.lastSeq;
  }

  /** Applies and records an op. The log is append-only (the screenshotter replays it incrementally). */
  apply(op: GameOp) {
    this.ops.push({ ...op });
    this.game.apply(op);
  }

  applyAll(ops: GameOp[]) {
    for (const op of ops) this.apply(op);
  }

  /** Steps frame by frame until `expr` is truthy or `maxMs` of simulated time passes. */
  waitUntil(expr: string, maxMs: number): { ok: boolean; waitedMs: number } {
    const max = msToFrames(maxMs);
    let frames = 0;
    const holds = () => {
      try {
        return !!evaluateExpr(expr, { game: this.game }).value;
      } catch (err) {
        if (err instanceof ExprError) throw new ToolError(err.message);
        throw err;
      }
    };
    while (!holds() && frames < max && this.game.status === 'running') {
      this.game.step(1);
      frames++;
    }
    if (frames) this.ops.push({ op: 'step', frames });
    return { ok: holds(), waitedMs: Math.round((frames * 1000) / 60) };
  }

  observe(): Observation {
    const g = this.game;
    const state = g.getState({ tags: ['player'] });
    const all = g.events();
    const events = this.lastEvent ? all.slice(all.lastIndexOf(this.lastEvent) + 1) : all;
    const logs = g.console.read(this.obsSeq).filter((l) => l.level !== 'log');
    this.lastEvent = all.at(-1) ?? this.lastEvent;
    this.obsSeq = g.console.lastSeq;
    return {
      frame: state.frame,
      time: state.time,
      status: state.status,
      scene: state.scene,
      keysDown: state.input.keys,
      ...(state.entities.length && { players: state.entities }),
      events: events.slice(-MAX_EVENTS),
      ...(events.length > MAX_EVENTS && { eventsTruncated: events.length - MAX_EVENTS }),
      console: logs.slice(-MAX_CONSOLE),
    };
  }
}
