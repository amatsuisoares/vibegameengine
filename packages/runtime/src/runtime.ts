import { Game, type LogEntry } from '@vibe/engine';
import type { Project } from '@vibe/shared';
import { FixedLoop } from './loop';
import { buildDrawList, paint, paintDebug, paintStatusOverlay, type AssetResolver } from './render';

export interface Scheduler {
  request(cb: (now: number) => void): number;
  cancel(id: number): void;
}

const animationFrames: Scheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

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
  fps = 0;
  private assets?: AssetResolver;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scheduler: Scheduler;
  private rafId: number | null = null;
  private lastFrameAt: number | null = null;
  private _paused: boolean;
  private reportedAssetErrors = new Set<string>();

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
    this.loop = new FixedLoop((frames) => this.game.step(frames));
    this.setProject(project, options.assets);
  }

  /** Replaces the project (hot reload) and starts it from its start scene. */
  setProject(project: Project, assets = this.assets) {
    this.project = project;
    this.assets = assets;
    this.canvas.width = project.config.width;
    this.canvas.height = project.config.height;
    this.reportedAssetErrors.clear();
    this.game = new Game(project, { seed: this.options.seed, scene: this.options.scene, onLog: this.options.onLog });
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
      this.measureFps(now);
      if (this._paused) this.loop.reset();
      else this.loop.tick(now);
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
    paint(this.ctx, buildDrawList(world), {
      width: config.width,
      height: config.height,
      background: world.scene.background,
      pixelArt: config.pixelArt,
      assets: this.assets,
      onAssetError: (message) => this.reportAssetError(message),
    });
    if (this.debug) paintDebug(this.ctx, world, { fps: this.running ? this.fps : undefined, paused: this._paused });
    if (this.options.statusOverlay ?? true) {
      const crash = world.status === 'crashed' ? world.events.findLast((e) => e.type === 'crash') : undefined;
      paintStatusOverlay(this.ctx, world.status, config.width, config.height, crash?.message as string | undefined);
    }
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
