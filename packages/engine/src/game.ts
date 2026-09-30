import { assertProject, type Project, type VarValue } from '@vibe/shared';
import { GameConsole, type LogEntry } from './console';
import { Input, type MouseButton } from './input';
import { round2 } from './math';
import { Rng } from './rng';
import { animationSystem } from './systems/animation';
import { cameraSystem } from './systems/camera';
import { controllerSystem } from './systems/controllers';
import { healthSystem } from './systems/health';
import { findContacts, interactionSystem } from './systems/interactions';
import { physicsSystem } from './systems/physics';
import { FIXED_DT, World, type GameEvent, type GameStatus } from './world';
import type { Entity } from './entity';

export interface GameOptions {
  seed?: number;
  /** Scene to start in (defaults to config.startScene). */
  scene?: string;
  /** Receives every console entry as it is written (e.g. to mirror into the browser console). */
  onLog?: (entry: LogEntry) => void;
}

/** One scripted input action. Time is simulated: `wait` advances fixed frames, not wall-clock time. */
export type InputStep =
  | { type: 'keyDown'; key: string }
  | { type: 'keyUp'; key: string }
  | { type: 'tap'; key: string; ms?: number }
  | { type: 'hold'; key: string; ms: number }
  | { type: 'wait'; ms: number }
  | { type: 'mouseMove'; x: number; y: number }
  | { type: 'mouseDown'; button?: MouseButton }
  | { type: 'mouseUp'; button?: MouseButton }
  | { type: 'click'; x?: number; y?: number; button?: MouseButton };

export interface EntitySnapshot {
  id: string;
  name: string;
  tags: string[];
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  grounded?: boolean;
  width?: number;
  height?: number;
  health?: number;
  maxHealth?: number;
  invulnerable?: boolean;
  components?: Record<string, unknown>;
}

export interface GameState {
  frame: number;
  time: number;
  status: GameStatus;
  scene: string;
  vars: Record<string, VarValue>;
  camera: { x: number; y: number; zoom: number; width: number; height: number };
  input: ReturnType<Input['snapshot']>;
  entityCount: number;
  entities: EntitySnapshot[];
}

export interface StateQuery {
  /** Only these entity ids. */
  ids?: string[];
  /** Only entities having any of these tags. */
  tags?: string[];
  /** Include full component data (verbose). */
  components?: boolean;
}

export const msToFrames = (ms: number) => Math.max(0, Math.round((ms / 1000) / FIXED_DT));

/**
 * Headless-capable game instance. Owns the simulation; rendering is done by
 * whoever reads `world` (browser renderer, screenshot tool) and never affects state.
 */
export class Game {
  readonly project: Project;
  readonly input: Input;
  readonly console: GameConsole;
  world!: World;
  private readonly seed: number;

  constructor(project: Project, private readonly options: GameOptions = {}) {
    this.project = project;
    this.seed = options.seed ?? 1;
    this.input = new Input(project.config.actions);
    this.console = new GameConsole(1000, options.onLog);
    this.loadScene(options.scene ?? project.config.startScene, {});
  }

  /** Validates raw JSON and creates a game; throws with every validation error listed. */
  static fromRaw(raw: unknown, options?: GameOptions) {
    return new Game(assertProject(raw), options);
  }

  get status(): GameStatus {
    return this.world.status;
  }

  get frame() {
    return this.world.frame;
  }

  loadScene(id: string, carryVars: Record<string, VarValue> = this.world?.vars ?? {}) {
    const scene = this.project.scenes[id];
    if (!scene) throw new Error(`Scene "${id}" does not exist`);
    const prevFrame = this.world?.frame ?? 0;
    const prevTime = this.world?.time ?? 0;
    const prevEvents = this.world?.events ?? [];
    const vars = { score: 0, ...structuredClone(scene.vars), ...carryVars };
    this.world = new World(this.project.config, structuredClone(scene), this.input, this.console, new Rng(this.seed), vars);
    this.world.frame = prevFrame;
    this.world.time = prevTime;
    this.world.events.push(...prevEvents);
    this.world.emit('scene_loaded', { scene: id });
    this.console.log(`Scene "${id}" loaded (${scene.entities.length} entities)`, 'engine');
    cameraSystem(this.world);
  }

  /** Back to the start scene with fresh variables. Input is released. */
  restart() {
    this.input.releaseAll();
    this.input.beginFrame();
    this.world = undefined as unknown as World;
    this.console.log('Game restarted', 'engine');
    this.loadScene(this.options.scene ?? this.project.config.startScene, {});
  }

  /** Advances the simulation by whole fixed frames (1/60 s each). */
  step(frames = 1) {
    for (let i = 0; i < frames; i++) this.stepOnce();
  }

  /** Advances simulated time. */
  advance(ms: number) {
    this.step(msToFrames(ms));
  }

  private stepOnce() {
    const w = this.world;
    const dt = FIXED_DT;
    this.console.frame = w.frame;
    this.input.beginFrame();

    if (w.status === 'running') {
      try {
        for (const e of w.entities) {
          e.prevX = e.x;
          e.prevY = e.y;
        }
        controllerSystem(w, dt);
        physicsSystem(w, dt);
        interactionSystem(w, findContacts(w));
        healthSystem(w, dt);
        animationSystem(w, dt);
        w.flushDestroyed();
      } catch (err) {
        w.status = 'crashed';
        const msg = err instanceof Error ? `${err.message}\n${err.stack?.split('\n').slice(1, 6).join('\n')}` : String(err);
        this.console.error(`Runtime error: ${msg}`, 'engine');
        w.emit('crash', { message: err instanceof Error ? err.message : String(err) });
      }
    }

    cameraSystem(w);
    w.frame++;
    w.time += dt;

    if (w.pendingScene) {
      const next = w.pendingScene;
      w.pendingScene = null;
      this.loadScene(next);
    }
  }

  /** Runs a scripted input sequence (used by tests and by the agent's input tools). */
  perform(steps: InputStep[]) {
    for (const s of steps) {
      switch (s.type) {
        case 'keyDown':
          this.input.keyDown(s.key);
          break;
        case 'keyUp':
          this.input.keyUp(s.key);
          break;
        case 'tap':
          this.input.keyDown(s.key);
          this.step(Math.max(1, msToFrames(s.ms ?? 50)));
          this.input.keyUp(s.key);
          break;
        case 'hold':
          this.input.keyDown(s.key);
          this.advance(s.ms);
          this.input.keyUp(s.key);
          break;
        case 'wait':
          this.advance(s.ms);
          break;
        case 'mouseMove':
          this.input.mouseMove(s.x, s.y);
          break;
        case 'mouseDown':
          this.input.mouseDown(s.button);
          break;
        case 'mouseUp':
          this.input.mouseUp(s.button);
          break;
        case 'click':
          if (s.x !== undefined && s.y !== undefined) this.input.mouseMove(s.x, s.y);
          this.input.mouseDown(s.button);
          this.step(1);
          this.input.mouseUp(s.button);
          break;
      }
    }
  }

  /** Steps until `predicate` holds or `maxMs` of simulated time passes. */
  waitUntil(predicate: (game: Game) => boolean, maxMs: number): { ok: boolean; frames: number } {
    const max = msToFrames(maxMs);
    for (let f = 0; f <= max; f++) {
      if (predicate(this)) return { ok: true, frames: f };
      if (f < max) this.stepOnce();
    }
    return { ok: false, frames: max };
  }

  entity(id: string): Entity | undefined {
    return this.world.get(id);
  }

  events(sinceFrame = 0, type?: string): GameEvent[] {
    return this.world.events.filter((e) => e.frame >= sinceFrame && (!type || e.type === type));
  }

  getState(query: StateQuery = {}): GameState {
    const w = this.world;
    let list = w.entities.filter((e) => !e.destroyed);
    if (query.ids) list = list.filter((e) => query.ids!.includes(e.id));
    if (query.tags) list = list.filter((e) => e.hasAnyTag(query.tags!));
    return {
      frame: w.frame,
      time: round2(w.time),
      status: w.status,
      scene: w.scene.id,
      vars: { ...w.vars },
      camera: {
        x: round2(w.camera.x),
        y: round2(w.camera.y),
        zoom: w.camera.zoom,
        width: this.project.config.width,
        height: this.project.config.height,
      },
      input: this.input.snapshot(),
      entityCount: w.entities.length,
      entities: list.map((e) => snapshotEntity(e, !!query.components)),
    };
  }
}

function snapshotEntity(e: Entity, withComponents: boolean): EntitySnapshot {
  const s: EntitySnapshot = { id: e.id, name: e.name, tags: [...e.tags], x: round2(e.x), y: round2(e.y) };
  const b = e.components.Body;
  if (b && b.type !== 'static') {
    s.vx = round2(b.vx);
    s.vy = round2(b.vy);
    if (b.type === 'dynamic') s.grounded = e.grounded;
  }
  const col = e.components.Collider ?? e.components.Sprite;
  if (col) {
    s.width = col.width;
    s.height = col.height;
  }
  const h = e.components.Health;
  if (h) {
    s.health = h.current;
    s.maxHealth = h.max;
    if (e.invulnTimer > 0) s.invulnerable = true;
  }
  if (withComponents) s.components = structuredClone(e.components) as Record<string, unknown>;
  return s;
}
