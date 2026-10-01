import { assertProject, type Project, type VarValue } from '@vibe/shared';
import { GameConsole, type LogEntry } from './console';
import { GameClock, type ClockOptions } from './clock';
import { Input, type MouseButton } from './input';
import { GameStorage } from './storage';
import { round2 } from './math';
import { Rng } from './rng';
import { animationSystem } from './systems/animation';
import { cameraSystem } from './systems/camera';
import { controllerSystem } from './systems/controllers';
import { moverSystem } from './systems/mover';
import { healthSystem } from './systems/health';
import { RuleRunner } from './rules';
import { SoundDirector, soundOf } from './sound';
import { ScriptLibrary, ScriptRunner } from './scripts';
import { findContacts, interactionSystem, pairKey } from './systems/interactions';
import { physicsSystem } from './systems/physics';
import { FIXED_DT, World, type GameEvent, type GameStatus } from './world';
import type { Entity } from './entity';

export interface GameOptions {
  seed?: number;
  /** Scene to start in (defaults to config.startScene). */
  scene?: string;
  /** Receives every console entry as it is written (e.g. to mirror into the browser console). */
  onLog?: (entry: LogEntry) => void;
  /** Calendar clock: start date, time zone and speed (see GameClock). */
  clock?: ClockOptions;
  /** Saved data the game starts with (game.storage). */
  storage?: Record<string, unknown>;
  /** Called after every change to game.storage (e.g. to persist it in the browser). */
  onStorageChange?: (data: Record<string, unknown>) => void;
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
  | { type: 'click'; x?: number; y?: number; button?: MouseButton }
  | { type: 'type'; text: string };

/** Primitive, replayable operation. Every way of driving a Game reduces to a sequence of these. */
export type GameOp =
  | { op: 'keyDown'; key: string }
  | { op: 'keyUp'; key: string }
  | { op: 'mouseMove'; x: number; y: number }
  | { op: 'mouseDown'; button?: MouseButton }
  | { op: 'mouseUp'; button?: MouseButton }
  | { op: 'step'; frames: number }
  | { op: 'restart' }
  | { op: 'loadScene'; scene: string }
  | { op: 'text'; text: string }
  | { op: 'advanceClock'; ms: number };

/** Expands scripted input steps into primitive ops (tap/hold/click become down, step, up). */
export function expandInputSteps(steps: InputStep[]): GameOp[] {
  const ops: GameOp[] = [];
  for (const s of steps) {
    switch (s.type) {
      case 'keyDown':
      case 'keyUp':
        ops.push({ op: s.type, key: s.key });
        break;
      case 'tap':
        ops.push({ op: 'keyDown', key: s.key }, { op: 'step', frames: Math.max(1, msToFrames(s.ms ?? 50)) }, { op: 'keyUp', key: s.key });
        break;
      case 'hold':
        ops.push({ op: 'keyDown', key: s.key }, { op: 'step', frames: msToFrames(s.ms) }, { op: 'keyUp', key: s.key });
        break;
      case 'wait':
        ops.push({ op: 'step', frames: msToFrames(s.ms) });
        break;
      case 'mouseMove':
        ops.push({ op: 'mouseMove', x: s.x, y: s.y });
        break;
      case 'mouseDown':
      case 'mouseUp':
        ops.push({ op: s.type, button: s.button });
        break;
      case 'click':
        if (s.x !== undefined && s.y !== undefined) ops.push({ op: 'mouseMove', x: s.x, y: s.y });
        ops.push({ op: 'mouseDown', button: s.button }, { op: 'step', frames: 1 }, { op: 'mouseUp', button: s.button });
        break;
      case 'type':
        ops.push({ op: 'text', text: s.text }, { op: 'step', frames: 1 });
        break;
    }
  }
  return ops;
}

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
  clock: ReturnType<GameClock['snapshot']>;
  /** Saved data (only when requested with `storage: true`). */
  storage?: Record<string, unknown>;
}

export interface StateQuery {
  /** Only these entity ids. */
  ids?: string[];
  /** Only entities having any of these tags. */
  tags?: string[];
  /** Include the saved data (game.storage). */
  storage?: boolean;
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
  readonly clock: GameClock;
  readonly storage: GameStorage;
  private readonly seed: number;
  private readonly scripts: ScriptLibrary;
  private scriptRunner!: ScriptRunner;
  private ruleRunner!: RuleRunner;
  private soundDirector!: SoundDirector;
  /** Music asset playing (for the `music` event when a scene without music follows one with music). */
  private music: string | null = null;

  constructor(project: Project, private readonly options: GameOptions = {}) {
    this.project = project;
    this.seed = options.seed ?? 1;
    this.input = new Input(project.config.actions);
    this.console = new GameConsole(1000, options.onLog);
    this.clock = new GameClock(options.clock);
    this.storage = new GameStorage(options.storage, options.onStorageChange);
    this.scripts = new ScriptLibrary(project.scripts ?? {});
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
    this.world.prefabs = this.project.prefabs ?? {};
    this.world.frame = prevFrame;
    this.world.time = prevTime;
    this.world.events.push(...prevEvents);
    this.world.emit('scene_loaded', { scene: id });
    this.console.log(`Scene "${id}" loaded (${scene.entities.length} entities)`, 'engine');
    this.scriptRunner = new ScriptRunner(this.world, this.scripts, this);
    this.ruleRunner = new RuleRunner(this.world, this);
    this.soundDirector = new SoundDirector(this.world);
    const music = scene.music ? soundOf(scene.music) : null;
    if (music) this.world.emit('music', music);
    else if (this.music) this.world.emit('music', { asset: null });
    this.music = music?.asset ?? null;
    cameraSystem(this.world);
  }

  /** Back to the start scene with fresh variables. Input is released. */
  restart() {
    this.input.releaseAll();
    this.input.beginFrame();
    this.world = undefined as unknown as World;
    this.clock.reset();
    this.storage.reset();
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
        moverSystem(w, dt);
        this.scriptRunner.update(dt);
        physicsSystem(w, dt);
        const contacts = findContacts(w);
        const entered = contacts.filter(([a, b]) => !w.prevContacts.has(pairKey(a, b)));
        interactionSystem(w, contacts);
        this.scriptRunner.collisions(entered);
        healthSystem(w, dt);
        animationSystem(w, dt);
        this.ruleRunner.run(entered);
        this.soundDirector.run();
        this.scriptRunner.events();
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
    this.clock.tick();

    if (w.pendingScene) {
      const next = w.pendingScene;
      w.pendingScene = null;
      this.loadScene(next);
    }
  }

  /** Runs a scripted input sequence (used by tests and by the agent's input tools). */
  perform(steps: InputStep[]) {
    for (const op of expandInputSteps(steps)) this.apply(op);
  }

  /** Applies one primitive operation. Replaying the same ops on a fresh game reproduces its state exactly. */
  apply(op: GameOp) {
    switch (op.op) {
      case 'keyDown':
        return this.input.keyDown(op.key);
      case 'keyUp':
        return this.input.keyUp(op.key);
      case 'mouseMove':
        return this.input.mouseMove(op.x, op.y);
      case 'mouseDown':
        return this.input.mouseDown(op.button);
      case 'mouseUp':
        return this.input.mouseUp(op.button);
      case 'step':
        return this.step(op.frames);
      case 'restart':
        return this.restart();
      case 'loadScene':
        return this.loadScene(op.scene);
      case 'text':
        return this.input.typeText(op.text);
      case 'advanceClock':
        return this.clock.advance(op.ms);
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
      clock: this.clock.snapshot(),
      ...(query.storage && { storage: this.storage.snapshot() }),
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
