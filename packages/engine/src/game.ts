import { assertProject, type Project, type VarValue } from '@vibe/shared';
import { GameConsole, type LogEntry } from './console';
import { GameClock, type ClockOptions } from './clock';
import { Input, type MouseButton } from './input';
import { GameStorage } from './storage';
import { captureHotState, restoreHotState } from './hot-state';
import { checkSlotName, GameSaves, type SaveSlot, type SlotHost, type SlotInfo } from './saves';
import { round2 } from './math';
import { Rng } from './rng';
import { animationSystem, animFrameIndex } from './systems/animation';
import { audioMix, audioSourceSystem } from './audio-source';
import { cameraSystem, worldToScreen } from './systems/camera';
import { controllerSystem } from './systems/controllers';
import { moverSystem } from './systems/mover';
import { healthSystem } from './systems/health';
import { RuleRunner } from './rules';
import { hitBox, InteractionRunner, isDrawn, snapshotInteractable, type InteractableSnapshot } from './interact';
import { mouseTarget, type LastClick, type MouseTarget } from './mouse';
import { fsmOf, StateMachineRunner, stateMs } from './fsm';
import { aiOf, UtilityRunner } from './utility';
import { NavRunner, snapshotNav } from './nav';
import { affinityOf, IndividualRunner } from './individual';
import { ItemCatalog } from './items';
import { cooldownsLeft, type TimerInfo } from './timers';
import type { TweenInfo } from './tweens';
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
  /** Save slots the game starts with (saveSlot / loadSlot). */
  slots?: Record<string, SaveSlot>;
  /** Called after every change to the save slots. */
  onSlotsChange?: (slots: Record<string, SaveSlot>) => void;
}

/** One scripted input action. Time is simulated: `wait` advances fixed frames, not wall-clock time. */
export type InputStep =
  | { type: 'keyDown'; key: string }
  | { type: 'keyUp'; key: string }
  | { type: 'tap'; key: string; ms?: number }
  | { type: 'hold'; key: string; ms: number }
  | { type: 'wait'; ms: number }
  | { type: 'mouseMove'; x?: number; y?: number; entity?: string }
  | { type: 'mouseDown'; button?: MouseButton }
  | { type: 'mouseUp'; button?: MouseButton }
  | { type: 'click'; x?: number; y?: number; entity?: string; button?: MouseButton }
  | { type: 'doubleClick'; x?: number; y?: number; entity?: string; button?: MouseButton }
  | { type: 'drag'; from: MousePoint; to: MousePoint; ms?: number; button?: MouseButton }
  | { type: 'type'; text: string };

/** A viewport point, or the center of an entity on screen (resolved by Game.expand). */
export type MousePoint = { x?: number; y?: number; entity?: string };

/** Viewport point of a resolved MousePoint (entities must be resolved first). */
function pointOf(p: MousePoint, what: string): { x: number; y: number } {
  if (p.entity !== undefined) throw new Error(`${what} on entity "${p.entity}" needs a running game (Game.expand)`);
  if (p.x === undefined || p.y === undefined) throw new Error(`${what} needs x and y, or an entity`);
  return { x: p.x, y: p.y };
}

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

/**
 * Expands scripted input steps into primitive ops (tap/hold/click become down, step, up).
 * A click on an `entity` needs the game to find where it is: use Game.expand / Game.perform.
 */
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
      case 'mouseMove': {
        const p = pointOf(s, 'mouseMove');
        ops.push({ op: 'mouseMove', x: p.x, y: p.y });
        break;
      }
      case 'mouseDown':
      case 'mouseUp':
        ops.push({ op: s.type, button: s.button });
        break;
      case 'click':
        if (s.entity !== undefined) throw new Error(`click on entity "${s.entity}" needs a running game (Game.expand)`);
        if (s.x !== undefined && s.y !== undefined) ops.push({ op: 'mouseMove', x: s.x, y: s.y });
        ops.push({ op: 'mouseDown', button: s.button }, { op: 'step', frames: 1 }, { op: 'mouseUp', button: s.button });
        break;
      case 'doubleClick': {
        if (s.entity !== undefined) pointOf(s, 'doubleClick');
        if (s.x !== undefined && s.y !== undefined) ops.push({ op: 'mouseMove', x: s.x, y: s.y });
        const press = [{ op: 'mouseDown', button: s.button }, { op: 'step', frames: 1 }, { op: 'mouseUp', button: s.button }] as const;
        ops.push(...press, { op: 'step', frames: 1 }, ...press);
        break;
      }
      case 'drag': {
        // Press at `from`, move frame by frame to `to` (so the game sees the motion), release.
        const a = pointOf(s.from, 'drag from');
        const b = pointOf(s.to, 'drag to');
        const n = Math.max(2, msToFrames(s.ms ?? 300));
        ops.push({ op: 'mouseMove', x: a.x, y: a.y }, { op: 'mouseDown', button: s.button }, { op: 'step', frames: 1 });
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          ops.push({ op: 'mouseMove', x: round2(a.x + (b.x - a.x) * t), y: round2(a.y + (b.y - a.y) * t) }, { op: 'step', frames: 1 });
        }
        ops.push({ op: 'mouseUp', button: s.button }, { op: 'step', frames: 1 });
        break;
      }
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
  interactable?: InteractableSnapshot;
  /** StateMachine: current state, time in it (ms) and the previous state. */
  state?: string;
  stateMs?: number;
  prevState?: string;
  /** UtilityAI: current choice and the scores of the last decision (null = option not available). */
  ai?: { choice: string | null; scores: Record<string, number | null> };
  /** Script props (per-entity values; scripts may change them). */
  props?: Record<string, VarValue>;
  /** Timers of the entity (self.after / every, "after" actions of its states). */
  timers?: TimerInfo[];
  /** Cooldowns running (self.cooldown): ms left by name. */
  cooldowns?: Record<string, number>;
  /** NavAgent: target, status (idle|moving|arrived|failed), next waypoint and how many are left. */
  nav?: ReturnType<typeof snapshotNav>;
  /** ParticleEmitter: particles alive from it and whether it is emitting. */
  particles?: { alive: number; emitting: boolean };
  /** Tweens running on the entity. */
  tweens?: TweenInfo[];
  /** Animator: clip showing and its frame index. */
  anim?: { clip: string | null; frame: number };
  /** Traits: personality axes (0..1). */
  traits?: Record<string, number>;
  /** Preferences: affinity per subject (innate + learned, -1..1). */
  prefs?: Record<string, number>;
  /** AudioSource: clip, whether it plays (a loop sounding / a one-shot about to play), and volume / pan as heard now. */
  audio?: { clip: string; loop: boolean; playing: boolean; volume: number; pan: number };
  components?: Record<string, unknown>;
  /** Box on screen (only with `onScreen` queries). */
  screen?: ScreenBox;
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
  /** Save slots (name, label, game time saved, scene), when there are any. */
  slots?: SlotInfo[];
}

/** An entity's box in viewport pixels (top-left, size). */
export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** Only active entities inside the viewport, each with its box on screen (`screen`). */
  onScreen?: boolean;
}

export const msToFrames = (ms: number) => Math.max(0, Math.round((ms / 1000) / FIXED_DT));

/**
 * Headless-capable game instance. Owns the simulation; rendering is done by
 * whoever reads `world` (browser renderer, screenshot tool) and never affects state.
 */
export class Game implements SlotHost {
  readonly project: Project;
  readonly input: Input;
  readonly console: GameConsole;
  world!: World;
  readonly clock: GameClock;
  readonly storage: GameStorage;
  /** Save slots (named snapshots of the game + its storage). */
  readonly saves: GameSaves;
  /** Slot to load at the end of the current frame. */
  private pendingSlot: string | null = null;
  /** Seed of the game's random generator. */
  readonly seed: number;
  private readonly scripts: ScriptLibrary;
  private scriptRunner!: ScriptRunner;
  private ruleRunner!: RuleRunner;
  private soundDirector!: SoundDirector;
  /** Interactions of the current scene (clicks, interaction keys, game.interact). */
  interactions!: InteractionRunner;
  /** Last left click (any scene), set by the InteractionRunner. */
  lastClick: LastClick | null = null;
  /** State machines of the current scene. */
  stateMachines!: StateMachineRunner;
  /** Utility AIs of the current scene. */
  utility!: UtilityRunner;
  /** NavAgents of the current scene. */
  nav!: NavRunner;
  /** Individuals of the current scene (Traits, Preferences, Persist). */
  individuals!: IndividualRunner;
  /** The item catalog (items/<id>.json). */
  readonly items: ItemCatalog;
  /** Music asset playing (for the `music` event when a scene without music follows one with music). */
  private music: string | null = null;

  constructor(project: Project, private readonly options: GameOptions = {}) {
    this.project = project;
    this.seed = options.seed ?? 1;
    this.input = new Input(project.config.actions);
    this.console = new GameConsole(1000, options.onLog);
    this.clock = new GameClock(options.clock);
    this.storage = new GameStorage(options.storage, options.onStorageChange);
    this.saves = new GameSaves(options.slots, options.onSlotsChange);
    this.scripts = new ScriptLibrary(project.scripts ?? {});
    this.items = new ItemCatalog(project.items ?? {});
    this.loadScene(options.scene ?? project.config.startScene, {});
  }

  /**
   * Uses an item on an entity: emits "item_used" {item, target, by?, category, tags} and calls the
   * target's onItem(self, item, game, by) hook. Returns whether a hook handled it and what it returned.
   */
  useItem(itemId: string, target: Entity, by?: Entity): { handled: boolean; result: unknown } {
    const item = this.items.require(itemId);
    if (!target.active) throw new Error(`useItem: entity "${target.id}" is not active`);
    this.world.emit('item_used', { item: item.id, target: target.id, ...(by && { by: by.id }), category: item.category, tags: [...item.tags] });
    return this.scriptRunner.itemUsed(target, item, by);
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
    this.world.slots = this;
    this.world.particles.reseed(this.seed);
    this.world.frame = prevFrame;
    this.world.time = prevTime;
    this.world.events.push(...prevEvents);
    this.world.emit('scene_loaded', { scene: id });
    this.console.log(`Scene "${id}" loaded (${scene.entities.length} entities)`, 'engine');
    this.scriptRunner = new ScriptRunner(this.world, this.scripts, this);
    this.ruleRunner = new RuleRunner(this.world, this);
    this.interactions = new InteractionRunner(this.world, this, this.scriptRunner);
    this.stateMachines = new StateMachineRunner(this.world, this, this.scriptRunner);
    this.nav = new NavRunner(this.world);
    this.utility = new UtilityRunner(this.world, this, this.scriptRunner, this.stateMachines);
    this.soundDirector = new SoundDirector(this.world);
    this.individuals = new IndividualRunner(this.world, this);
    const music = scene.music ? soundOf(scene.music) : null;
    if (music) this.world.emit('music', music);
    else if (this.music) this.world.emit('music', { asset: null });
    this.music = music?.asset ?? null;
    cameraSystem(this.world);
  }

  /**
   * Saves the game in a slot: its running state (scene, positions, variables, entities...) and a
   * copy of game.storage. Overwrites a slot with the same name. Emits "slot_saved".
   */
  saveSlot(name: string, label?: string) {
    const n = checkSlotName(name);
    if (label !== undefined && typeof label !== 'string') throw new Error('saveSlot(name, label): label must be a string');
    const state = captureHotState(this);
    // Only the prefabs of spawned entities are needed to restore them.
    const used = new Set(state.entities.filter((e) => !e.authored && e.prefab).map((e) => e.prefab!));
    state.prefabs = Object.fromEntries(Object.entries(state.prefabs).filter(([id]) => used.has(id)));
    this.saves.put(n, { version: 1, ...(label && { label }), savedAt: this.clock.now, scene: this.world.scene.id, storage: this.storage.snapshot(), state });
    this.world.emit('slot_saved', { slot: n });
  }

  /** Loads a slot at the end of the current frame (like loadScene). False when there is no such slot. */
  loadSlot(name: string): boolean {
    const n = checkSlotName(name);
    if (!this.saves.get(n)) return false;
    this.pendingSlot = n;
    return true;
  }

  deleteSlot(name: string): boolean {
    const deleted = this.saves.delete(name);
    if (deleted) this.world.emit('slot_deleted', { slot: name });
    return deleted;
  }

  listSlots(): SlotInfo[] {
    return this.saves.list();
  }

  /**
   * Restores a slot now: storage replaced, the scene rebuilt from the current files and the saved
   * state restored into it (file edits made since the save win, as in a hot reload). Game time
   * keeps going forward: the frame counter does not jump back.
   */
  private applySlot(name: string) {
    const slot = this.saves.get(name)!;
    const now = { frame: this.world.frame, time: this.world.time };
    this.storage.replace(slot.storage);
    const scene = this.project.scenes[slot.scene] ? slot.scene : this.world.scene.id;
    this.loadScene(scene, {});
    const report = restoreHotState(this, slot.state, { keepTime: now });
    this.world.emit('slot_loaded', { slot: name, scene: this.world.scene.id });
    this.console.log(`Slot "${name}" loaded (${report.kept} entities${report.sceneMissing ? `; scene "${report.sceneMissing}" no longer exists` : ''})`, 'engine');
  }

  /** The current scene's rule runner (its memory is kept by a hot reload). */
  get rules(): RuleRunner {
    return this.ruleRunner;
  }

  /** Back to the start scene with fresh variables. Input is released. */
  restart() {
    this.input.releaseAll();
    this.input.beginFrame();
    this.world = undefined as unknown as World;
    this.clock.reset();
    this.storage.reset();
    this.saves.reset();
    this.pendingSlot = null;
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
        this.individuals.init();
        this.scriptRunner.start();
        controllerSystem(w, dt);
        moverSystem(w, dt);
        this.nav.run(dt);
        this.interactions.input();
        this.scriptRunner.update(dt);
        physicsSystem(w, dt);
        const contacts = findContacts(w);
        const entered = contacts.filter(([a, b]) => !w.prevContacts.has(pairKey(a, b)));
        interactionSystem(w, contacts);
        this.scriptRunner.collisions(entered);
        this.interactions.proximity();
        healthSystem(w, dt);
        this.ruleRunner.run(entered);
        this.utility.run();
        this.stateMachines.run();
        w.timers.run();
        w.tweens.run();
        w.particles.run(dt);
        animationSystem(w, dt);
        audioSourceSystem(w);
        this.soundDirector.run();
        this.scriptRunner.events();
        this.individuals.flush();
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
    if (this.pendingSlot) {
      const name = this.pendingSlot;
      this.pendingSlot = null;
      this.applySlot(name);
    }
  }

  /** Runs a scripted input sequence (used by tests and by the agent's input tools). */
  perform(steps: InputStep[]) {
    for (const step of steps) for (const op of this.expand(step)) this.apply(op);
  }

  /** Ops for one input step in the current state (a click on an entity aims at where it is now). */
  expand(step: InputStep): GameOp[] {
    const at = (p: MousePoint): MousePoint => (p.entity !== undefined ? this.screenPointOf(p.entity) : p);
    if ((step.type === 'click' || step.type === 'doubleClick' || step.type === 'mouseMove') && step.entity !== undefined) {
      return expandInputSteps([{ ...step, ...this.screenPointOf(step.entity), entity: undefined }]);
    }
    if (step.type === 'drag') return expandInputSteps([{ ...step, from: at(step.from), to: at(step.to) }]);
    return expandInputSteps([step]);
  }

  /**
   * Where an active entity appears in the viewport: its box (Collider or Sprite; a point for entities
   * without one, e.g. Text), not clipped, or null when it is entirely off screen or not drawn at all.
   */
  screenBoxOf(e: Entity): ScreenBox | null {
    if (!e.active || e.destroyed) return null;
    // Only what is drawn (a visible sprite or text) or physically there (a collider, e.g. an invisible wall).
    if (!isDrawn(e) && !e.aabb()) return null;
    const b = hitBox(e) ?? { x: e.x, y: e.y, w: 0, h: 0 };
    const p = worldToScreen(this.world, b.x, b.y);
    const zoom = this.world.camera.zoom;
    const box = { x: round2(p.x), y: round2(p.y), w: round2(b.w * zoom), h: round2(b.h * zoom) };
    const { width, height } = this.project.config;
    if (box.x > width || box.y > height || box.x + box.w < 0 || box.y + box.h < 0) return null;
    return box;
  }

  /** What is under the virtual mouse and what a left click there would reach (no side effects). */
  mouseTarget(): MouseTarget {
    return mouseTarget(this);
  }

  /** Viewport point at the center of an entity's box (Collider or Sprite); throws if it is not on screen. */
  screenPointOf(id: string): { x: number; y: number } {
    const e = this.world.get(id);
    if (!e || !e.active) throw new Error(`entity "${id}" does not exist or is disabled`);
    const b = hitBox(e);
    const p = worldToScreen(this.world, b ? b.x + b.w / 2 : e.x, b ? b.y + b.h / 2 : e.y);
    const { width, height } = this.project.config;
    if (p.x < 0 || p.y < 0 || p.x > width || p.y > height) {
      throw new Error(`entity "${id}" is off screen (viewport ${round2(p.x)}, ${round2(p.y)}); move the camera or click by x/y`);
    }
    return { x: round2(p.x), y: round2(p.y) };
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
    const boxes = new Map<Entity, ScreenBox>();
    if (query.onScreen) {
      list = list.filter((e) => {
        const box = this.screenBoxOf(e);
        if (box) boxes.set(e, box);
        return !!box;
      });
    }
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
      entities: list.map((e) => {
        const snap = snapshotEntity(w, e, !!query.components);
        const box = boxes.get(e);
        return box ? { ...snap, screen: box } : snap;
      }),
      clock: this.clock.snapshot(),
      ...(query.storage && { storage: this.storage.snapshot() }),
      ...(this.saves.list().length && { slots: this.saves.list() }),
    };
  }
}

function snapshotEntity(w: World, e: Entity, withComponents: boolean): EntitySnapshot {
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
  const interactable = snapshotInteractable(w, e);
  if (interactable) s.interactable = interactable;
  const fsm = fsmOf(e);
  if (fsm) {
    s.state = fsm.state;
    s.stateMs = stateMs(w, fsm);
    if (fsm.previous !== null) s.prevState = fsm.previous;
  }
  const ai = aiOf(e);
  if (ai) s.ai = { choice: ai.choice, scores: { ...ai.scores } };
  const timers = w.timers.list(e);
  if (timers.length) s.timers = timers;
  const cds = cooldownsLeft(w, e);
  if (Object.keys(cds).length) s.cooldowns = cds;
  const nav = snapshotNav(e);
  if (nav) s.nav = nav;
  const em = e.components.ParticleEmitter;
  if (em) s.particles = { alive: w.particles.aliveOf(e.id), emitting: em.emitting };
  const tweens = w.tweens.list(e);
  if (tweens.length) s.tweens = tweens;
  if (e.components.Animator) s.anim = { clip: e.animName, frame: Math.max(0, animFrameIndex(e)) };
  const audio = e.components.AudioSource;
  if (audio) s.audio = { clip: audio.clip, loop: audio.loop, playing: audio.playing && e.active, ...audioMix(w, e) };
  if (e.components.Traits) s.traits = { ...e.components.Traits.values };
  if (e.components.Preferences) s.prefs = Object.fromEntries(Object.keys(e.components.Preferences.values).map((k) => [k, affinityOf(e, k)]));
  const props = e.components.Script?.props;
  if (props && Object.keys(props).length) s.props = { ...props };
  if (withComponents) s.components = structuredClone(e.components) as Record<string, unknown>;
  return s;
}
