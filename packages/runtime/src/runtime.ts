import { FIXED_DT, Game, type ClockOptions, type GameEvent, type LogEntry, type World } from '@vibe/engine';
import type { Project } from '@vibe/shared';
import { FixedLoop } from './loop';
import { buildDrawList, paint, paintDebug, paintSelection, paintStatusOverlay, type AssetResolver } from './render';
import { dragView, offsetDrawList, paintViewportGizmos, type EditorView } from './viewport';

export interface Scheduler {
  request(cb: (now: number) => void): number;
  cancel(id: number): void;
}

const animationFrames: Scheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

/** What a game starts from: seed, scene, clock and saved data. */
export interface StartOptions {
  seed?: number;
  scene?: string;
  clock?: ClockOptions;
  storage?: Record<string, unknown>;
}

/** Real-time gaps longer than this (ms) are treated as skipped frames and added to the game clock. */
const CLOCK_GAP_MS = 250;

export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d'): CanvasRenderingContext2D | null;
}

export interface RuntimeOptions {
  assets?: AssetResolver;
  seed?: number;
  scene?: string;
  debug?: boolean;
  /** Start paused: nothing advances until resume() or an explicit step (external control). */
  paused?: boolean;
  /** Draw the win/lose/crash banner. */
  statusOverlay?: boolean;
  onLog?: (entry: LogEntry) => void;
  /** Called on every animation frame before drawing (e.g. to feed a replayed run). */
  onTick?: (now: number) => void;
  /** Receives the events emitted since the previous animation frame (e.g. to play sounds). */
  onEvents?: (events: GameEvent[], game: Game) => void;
  /** Called on every animation frame after the events (e.g. to follow continuous sounds: audioVoices). */
  onFrame?: (game: Game) => void;
  /** Calendar clock and saved data of the game (see GameClock / GameStorage). */
  clock?: ClockOptions;
  storage?: Record<string, unknown>;
  onStorageChange?: (data: Record<string, unknown>) => void;
  /**
   * Keep the game clock in step with the real clock: when frames are skipped (background tab,
   * sleep), the missing time is added with an advanceClock op instead of being lost.
   */
  realtimeClock?: boolean;
  scheduler?: Scheduler;
}

/**
 * Browser runtime: owns a Game, drives it in real time and draws it on a canvas.
 * Real-time stepping and external stepping (window.__vibe) both go through `game.step`,
 * so the simulation is identical either way.
 */
export class Runtime {
  game!: Game;
  project!: Project;
  readonly loop: FixedLoop;
  debug: boolean;
  /** Entity selected in the editor panels: outlined over the game (never part of the simulation). */
  selected: string | null = null;
  /** Editor viewport: its own camera, a drag preview and gizmos (null = the game's own view). */
  editor: EditorView | null = null;
  fps = 0;
  private assets?: AssetResolver;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scheduler: Scheduler;
  private rafId: number | null = null;
  private lastFrameAt: number | null = null;
  private _paused: boolean;
  private reportedAssetErrors = new Set<string>();
  private startAt: StartOptions;
  private seen: { world: World | null; emitted: number } = { world: null, emitted: 0 };

  constructor(
    private readonly canvas: CanvasLike,
    project: Project,
    private readonly options: RuntimeOptions = {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context is not available');
    this.ctx = ctx;
    this.debug = options.debug ?? false;
    this._paused = options.paused ?? false;
    this.scheduler = options.scheduler ?? animationFrames;
    this.startAt = { seed: options.seed, scene: options.scene, clock: options.clock, storage: options.storage };
    this.loop = new FixedLoop((frames) => this.game.step(frames));
    this.setProject(project, options.assets);
  }

  /**
   * Replaces the project (hot reload) and starts it from its start scene, or from
   * `start` (seed/scene/clock/saved data, e.g. of a run to mirror), kept for later restarts.
   */
  setProject(project: Project, assets = this.assets, start?: StartOptions) {
    if (start) this.startAt = start;
    this.project = project;
    this.assets = assets;
    this.canvas.width = project.config.width;
    this.canvas.height = project.config.height;
    this.reportedAssetErrors.clear();
    this.game = new Game(project, { ...this.startAt, onLog: this.options.onLog, onStorageChange: this.options.onStorageChange });
    this.loop.reset();
    this.render();
  }

  get paused() {
    return this._paused;
  }

  pause() {
    this._paused = true;
    this.render();
  }

  resume() {
    this._paused = false;
    this.loop.reset();
  }

  restart() {
    this.reportedAssetErrors.clear();
    this.game.restart();
    this.loop.reset();
    this.render();
  }

  /** Starts the animation-frame loop (rendering always; stepping only when not paused). */
  start() {
    if (this.rafId !== null) return;
    const frame = (now: number) => {
      this.rafId = this.scheduler.request(frame);
      const gap = this.lastFrameAt === null ? 0 : now - this.lastFrameAt;
      this.measureFps(now);
      if (this._paused) this.loop.reset();
      else {
        const frames = this.loop.tick(now);
        const missing = gap - frames * FIXED_DT * 1000;
        if (this.options.realtimeClock && missing > CLOCK_GAP_MS) {
          this.game.apply({ op: 'advanceClock', ms: missing * this.game.clock.speed });
        }
      }
      this.options.onTick?.(now);
      this.dispatchEvents();
      this.options.onFrame?.(this.game);
      this.render();
    };
    this.rafId = this.scheduler.request(frame);
  }

  stop() {
    if (this.rafId !== null) this.scheduler.cancel(this.rafId);
    this.rafId = null;
    this.lastFrameAt = null;
  }

  get running() {
    return this.rafId !== null;
  }

  /** Runtime shortcuts that are not game input. Returns true when the key was consumed. */
  handleShellKey(code: string): boolean {
    if (code === 'KeyR' && this.game.status !== 'running') {
      this.restart();
      return true;
    }
    return false;
  }

  render() {
    const { config } = this.project;
    const world = this.game.world;
    const ed = this.editor;
    const cam = ed?.view ?? world.camera;
    let cmds = buildDrawList(world, cam);
    if (ed?.drag) cmds = offsetDrawList(cmds, ed.drag, cam.zoom);
    paint(this.ctx, cmds, {
      width: config.width,
      height: config.height,
      background: world.scene.background,
      pixelArt: config.pixelArt,
      assets: this.assets,
      onAssetError: (message) => this.reportAssetError(message),
    });
    if (this.debug) paintDebug(this.ctx, world, { fps: this.running && !this._paused ? this.fps : undefined, paused: this._paused }, cam);
    if (ed) paintViewportGizmos(this.ctx, world, ed, this.selected);
    if (this.selected) paintSelection(this.ctx, world, this.selected, ed?.drag?.id === this.selected ? dragView(cam, ed.drag) : cam);
    if (this.options.statusOverlay ?? true) {
      const crash = world.status === 'crashed' ? world.events.findLast((e) => e.type === 'crash') : undefined;
      paintStatusOverlay(this.ctx, world.status, config.width, config.height, crash?.message as string | undefined);
    }
  }

  /** Hands new events to onEvents. A new world (restart, scene change, hot reload) counts from its own start. */
  private dispatchEvents() {
    if (!this.options.onEvents) return;
    const w = this.game.world;
    if (this.seen.world !== w) this.seen = { world: w, emitted: 0 };
    const count = Math.min(w.emitted - this.seen.emitted, w.events.length);
    this.seen.emitted = w.emitted;
    if (count > 0) this.options.onEvents(w.events.slice(-count), this.game);
  }

  private reportAssetError(message: string) {
    if (this.reportedAssetErrors.has(message)) return;
    this.reportedAssetErrors.add(message);
    this.game.console.warn(message, 'renderer');
  }

  private measureFps(now: number) {
    if (this.lastFrameAt !== null && now > this.lastFrameAt) {
      const inst = 1000 / (now - this.lastFrameAt);
      this.fps = this.fps ? this.fps * 0.9 + inst * 0.1 : inst;
    }
    this.lastFrameAt = now;
  }
}
