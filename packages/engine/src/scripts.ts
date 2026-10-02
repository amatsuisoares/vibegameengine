import type { ComponentType, VarValue } from '@vibe/shared';
import { checkSpeed, type GameClock } from './clock';
import type { Entity } from './entity';
import { fsmOf, stateMs, type StateMachineRunner } from './fsm';
import { animFrameIndex } from './systems/animation';
import { cooldown, type TimerInfo } from './timers';
import { findPath, pathOptionsFor, type NavStatus, type PathResult, type Point } from './nav';
import type { Ease, TweenInfo } from './tweens';
import type { EmitterOptions } from './particles';
import { aiOf, type UtilityRunner } from './utility';
import { ItemCatalog, type ItemFilter, type ItemInfo } from './items';
import { habitOf, patternsOf, peakOf, recordActivity, type Habit } from './routine';
import type { BuyOptions, BuyResult, Economy, Inventory, Wallet } from './economy';
import { affinityOf, evaluate, evaluateItem, learn, preferenceLevel, traitOf, type Evaluation, type IndividualRunner, type PreferenceLevel } from './individual';
import { topmostAt, type InteractionRunner, type InteractResult, type InteractVia, type NearbyInteractable } from './interact';
import { emitSound } from './sound';
import type { GameStorage } from './storage';
import type { SlotHost, SlotInfo } from './saves';
import { screenToWorld } from './systems/camera';
import { applyDamage } from './systems/interactions';
import { FIXED_DT, type GameEvent, type World } from './world';

/**
 * Scripts: project files `scripts/*.js` attached to entities by the `Script` component.
 * A script defines any of these functions (plain JavaScript, no imports):
 *
 *   function onStart(self, game) {}              // first frame of the entity
 *   function onUpdate(self, game, dt) {}         // every frame, after controllers, before physics
 *   function onCollision(self, other, game) {}   // when a contact with `other` begins
 *   function onClick(self, game, pos) {}          // the entity was clicked (left button; pos in world px)
 *   function onEvent(self, event, game) {}        // every game event (end of frame), incl. custom ones
 *   function onInteract(self, by, game, info) {}  // self (an Interactable) was used; by = actor or null, info = { action, via }
 *   function onStateChange(self, change, game) {} // self's StateMachine changed state: change = { from, to } (from null at start)
 *   function onDecision(self, decision, game) {}  // self's UtilityAI chose something new: { choice, from, scores, target }
 *   function onItem(self, item, game, by) {}      // an item was used on self (game.useItem); its return value goes back to the caller
 *
 * Top-level variables are per entity (each entity runs its own copy of the script).
 * Scripts only see `self`, `game`, `console` and a deterministic `Math` (Math.random is
 * seeded); `Date`, timers, network and the host are not available, so runs stay replayable.
 * This is a restricted API for game logic, not a security sandbox.
 */
export interface ScriptHooks {
  onStart?: (self: ScriptEntity, game: ScriptGame) => void;
  onUpdate?: (self: ScriptEntity, game: ScriptGame, dt: number) => void;
  onCollision?: (self: ScriptEntity, other: ScriptEntity, game: ScriptGame) => void;
  onClick?: (self: ScriptEntity, game: ScriptGame, pos: { x: number; y: number }) => void;
  onEvent?: (self: ScriptEntity, event: GameEvent, game: ScriptGame) => void;
  onInteract?: (self: ScriptEntity, by: ScriptEntity | null, game: ScriptGame, info: { action: string; via: InteractVia }) => void;
  onStateChange?: (self: ScriptEntity, change: { from: string | null; to: string }, game: ScriptGame) => void;
  onDecision?: (self: ScriptEntity, decision: { choice: string; from: string | null; scores: Record<string, number | null>; target: string | null }, game: ScriptGame) => void;
  onItem?: (self: ScriptEntity, item: ItemInfo, game: ScriptGame, by: ScriptEntity | null) => unknown;
}

const HOOKS = ['onStart', 'onUpdate', 'onCollision', 'onClick', 'onEvent', 'onInteract', 'onStateChange', 'onDecision', 'onItem'] as const;

/** What scripts reach beyond the world: the calendar clock, the saved data, interactions and state machines. */
export interface ScriptHost extends SlotHost {
  clock: GameClock;
  storage: GameStorage;
  readonly interactions: InteractionRunner;
  readonly stateMachines: StateMachineRunner;
  readonly utility: UtilityRunner;
  readonly individuals: IndividualRunner;
  readonly items: ItemCatalog;
  readonly economy: Economy;
  useItem(itemId: string, target: Entity, by?: Entity): { handled: boolean; result: unknown };
}

/** self.traits: the entity's personality axes (Traits), 0..1. */
export interface ScriptTraits {
  /** Value of an axis (throws for an unknown axis). */
  get(axis: string): number;
  /** Sets an axis (clamped to 0..1; saved with Persist). */
  set(axis: string, value: number): void;
  has(axis: string): boolean;
  all(): Record<string, number>;
}

/** self.prefs: the entity's likes and dislikes (Preferences). */
export interface ScriptPrefs {
  /** Affinity -1..1 for a subject (0 = neutral or unknown). */
  of(subject: string): number;
  /** Whether the subject has an affinity at all. */
  known(subject: string): boolean;
  /** How it feels about a subject with tags: {score, level (love|like|neutral|dislike|hate), known, parts}. */
  evaluate(subject: string | null, tags?: string[]): Evaluation;
  /** Level of a score. */
  level(score: number): PreferenceLevel;
  /** One experience (outcome -1..1): shifts the learned part slowly; returns the new affinity. */
  learn(subject: string, outcome: number): number;
  /** Sets the innate affinity of a subject (-1..1), keeping what was learned. */
  set(subject: string, innate: number): void;
  /** How it feels about an item (id or item): its id, category and tags. */
  item(item: string | ItemInfo): Evaluation;
  /** Affinity per subject. */
  all(): Record<string, number>;
}

/** self.routine: the entity's habits by time of day (Routine). */
export interface ScriptRoutine {
  /** It did `activity` now (weight default 1); saved with Persist. */
  record(activity: string, weight?: number): void;
  /** Share 0..1 of `activity` among what it does at that hour (default: now). */
  habit(activity: string, hour?: number): number;
  /** The time of day it does `activity` most: {slot, from, to, weight} or null. */
  peak(activity: string): { slot: number; from: number; to: number; weight: number } | null;
  /** Stable habits: [{activity, slot, from, to, share, weight}], strongest first. */
  patterns(minShare?: number): Habit[];
}

/** self.persist: where the individual data is kept (Persist). */
export interface ScriptPersist {
  /** Storage key, or null without Persist. */
  readonly key: string | null;
  /** Saves now (changes are also saved at the end of the frame). */
  save(): void;
  /** Forgets the individual: authored values back, generated ones drawn again, saved; preset.traits fixes axes first. */
  reset(preset?: { traits?: Record<string, number> }): void;
}

type PlaceRef = string | ScriptEntity | Point;

/** self.nav: the entity's NavAgent. */
export interface ScriptNav {
  readonly status: NavStatus;
  /** Remaining waypoints. */
  readonly path: Point[];
  /** Current target (entity id or point), null = none. */
  readonly target: string | Point | null;
  /** Walks to an entity (id or entity, followed as it moves) or a point {x, y}. */
  goTo(target: string | ScriptEntity | Point): void;
  /** Stops (target = null). */
  stop(): void;
}

/** self.anim: the entity's Animator. */
export interface ScriptAnim {
  /** Clip showing (null without an Animator or clip). */
  readonly name: string | null;
  /** Index of the frame showing within the clip. */
  readonly frame: number;
  /** Plays a clip over the state/auto choice; a non-looping one ends by itself (then its `next`). */
  play(clip: string): void;
  /** Stops a clip started with play() (back to the state/auto choice). */
  stop(): void;
  /** Playback speed multiplier (Animator.speed). */
  speed: number;
}

/** self.ai: the entity's UtilityAI (choice is null without one or before the first decision). */
export interface ScriptAi {
  readonly choice: string | null;
  /** Scores of the last decision (null = option not available). */
  readonly scores: Record<string, number | null>;
  /** Entity the current choice is about (options with targets), or null. */
  readonly target: string | null;
  /** Scores the options now and applies the choice; returns it. */
  decide(): string | null;
}

/** self.fsm: the entity's StateMachine (state is null without one). */
export interface ScriptFsm {
  readonly state: string | null;
  readonly previous: string | null;
  /** Seconds in the current state. */
  readonly time: number;
  /** True if the current state is any of these. */
  is(...states: string[]): boolean;
  /** Changes state now (exit/enter actions, onStateChange); false if already in it. */
  go(state: string): boolean;
}

type Factory = (math: Math, console: ScriptConsole) => ScriptHooks;

export interface ScriptConsole {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Globals hidden from scripts (shadowed by parameters that are always undefined). */
const HIDDEN = ['globalThis', 'window', 'document', 'process', 'require', 'module', 'exports', 'fetch', 'XMLHttpRequest',
  'WebSocket', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'Date', 'performance', 'localStorage', 'Function'];

/** Lines that `new Function` adds before the body ("function anonymous(...\n) {\n"). */
const HEADER_LINES = 2;

/**
 * Wraps a script so it evaluates to its hooks. The source starts on the first body line, so
 * line numbers inside the script are unchanged except for the function header.
 */
export function wrapScript(source: string, file: string): string {
  const hooks = HOOKS.map((h) => `${h}: typeof ${h} === "function" ? ${h} : undefined`).join(', ');
  return `"use strict";${source}\n;return { ${hooks} };\n//# sourceURL=${file}`;
}

export const SCRIPT_PARAMS = ['Math', 'console', ...HIDDEN];

/** "scripts/x.js:12" for the innermost frame of an error thrown by a script, if any. */
export function scriptLocation(err: unknown, file: string): string | null {
  const stack = err instanceof Error ? (err.stack ?? '') : '';
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(stack);
  return m ? `${file}:${Number(m[1]) - HEADER_LINES}:${m[2]}` : null;
}

/** Compiles the project's scripts on demand (once per game) and creates per-entity instances. */
export class ScriptLibrary {
  private readonly compiled = new Map<string, Factory | Error>();

  constructor(private readonly sources: Record<string, string>) {}

  /** The script's factory, or the compile error. */
  factory(file: string): Factory | Error {
    let f = this.compiled.get(file);
    if (!f) {
      const source = this.sources[file];
      if (source === undefined) f = new Error(`${file}: script file not found`);
      else {
        try {
          f = new Function(...SCRIPT_PARAMS, wrapScript(source, file)) as Factory;
        } catch (err) {
          f = new Error(`${file}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
        }
      }
      this.compiled.set(file, f);
    }
    return f;
  }
}

/** Live per-entity script state (kept on the Entity). */
export interface ScriptInstance {
  file: string;
  hooks: ScriptHooks;
  started: boolean;
  /** Disabled after an error, so one bug does not flood the console every frame. */
  failed: boolean;
}

export interface ScriptEntity {
  readonly id: string;
  readonly name: string;
  readonly tags: string[];
  hasTag(tag: string): boolean;
  x: number;
  y: number;
  /** Visual transform (does not change the collider). */
  scaleX: number;
  scaleY: number;
  rotation: number;
  /** Velocity of the Body (0 without one). Setting it needs a Body. */
  vx: number;
  vy: number;
  readonly grounded: boolean;
  enabled: boolean;
  readonly destroyed: boolean;
  readonly health: number | undefined;
  /** The Script component's props (editable in the scene, mutable at runtime). */
  readonly props: Record<string, VarValue>;
  /** Free per-entity storage for the script. */
  readonly state: Record<string, unknown>;
  /** The entity's StateMachine. */
  readonly fsm: ScriptFsm;
  /** The entity's UtilityAI. */
  readonly ai: ScriptAi;
  /** The entity's Animator. */
  readonly anim: ScriptAnim;
  /** The entity's NavAgent. */
  readonly nav: ScriptNav;
  /** The entity's ParticleEmitter: burst(count?) now, emitting on/off, alive count. */
  readonly particles: { burst(count?: number): number; emitting: boolean; readonly alive: number };
  /** The entity's Traits. */
  readonly traits: ScriptTraits;
  /** The entity's Preferences. */
  readonly prefs: ScriptPrefs;
  /** The entity's Routine. */
  readonly routine: ScriptRoutine;
  /** The entity's Persist. */
  readonly persist: ScriptPersist;
  /** Runs fn once after ms of game time; returns the timer id (same id again = restart). Dropped if the entity is destroyed. */
  after(ms: number, fn: () => void, id?: string): string;
  /** Runs fn every ms of game time until cancelled. */
  every(ms: number, fn: () => void, id?: string): string;
  /** Cancels a timer of this entity; returns whether it existed. */
  cancel(id: string): boolean;
  /** Timers of this entity, soonest first. */
  readonly timers: TimerInfo[];
  /** True (and starts the cooldown) if `name` is not cooling down; false otherwise. */
  cooldown(name: string, ms: number): boolean;
  /**
   * Animates a property to `to` over `ms`: x, y, rotation, scaleX, scaleY, scale, opacity or "Component.field".
   * Options: from, ease (linear|easeIn|easeOut|easeInOut), yoyo, repeat (-1 = forever), id, onDone. Returns the id.
   */
  tween(prop: string, to: number, ms: number, options?: { from?: number; ease?: Ease; yoyo?: boolean; repeat?: number; id?: string; onDone?: () => void }): string;
  /** Stops tweens by id or property (all without an argument); returns how many. */
  stopTween(idOrProp?: string): number;
  readonly tweens: TweenInfo[];
  /** Live component data (changes apply immediately), or undefined. */
  get(type: ComponentType): Record<string, unknown> | undefined;
  damage(amount: number): boolean;
  destroy(): void;
}

export interface ScriptGame {
  readonly frame: number;
  readonly time: number;
  readonly dt: number;
  readonly scene: string;
  readonly status: string;
  /** Game variables (live: assignments change them). */
  readonly vars: Record<string, VarValue>;
  entity(id: string): ScriptEntity | null;
  find(tag: string): ScriptEntity[];
  /** Input actions from project config (e.g. "left", "jump") or key names. */
  readonly input: {
    isDown(action: string): boolean;
    pressed(action: string): boolean;
    released(action: string): boolean;
    /** Mouse position on screen (viewport px) and in the world. */
    readonly mouse: { x: number; y: number };
    readonly mouseWorld: { x: number; y: number };
    mouseDown(button?: 'left' | 'right' | 'middle'): boolean;
    mousePressed(button?: 'left' | 'right' | 'middle'): boolean;
    /** What a left click at the mouse would reach now (Interactable click, onClick or "clickable"), or null. For hover effects. */
    readonly hovered: ScriptEntity | null;
    /** True during the frame of the second press of a double click. */
    readonly doubleClicked: boolean;
    /** The drag in progress (left button held and moved): grabbed entity id (or null), start and current world point. */
    readonly drag: { entity: string | null; startX: number; startY: number; x: number; y: number } | null;
    /** Text typed since the previous frame, in order; "\b" = Backspace, "\n" = Enter (e.g. for a name field). */
    readonly text: string;
  };
  /** Calendar date/time of the game: now (epoch ms), hour (0..24, local), speed (settable; 60 = 1 game minute per second). */
  readonly clock: { readonly now: number; readonly hour: number; readonly iso: string; speed: number };
  /** Saved data that survives closing the game (JSON values). */
  readonly storage: { get(key: string): unknown; set(key: string, value: unknown): void; remove(key: string): void; keys(): string[] };
  /** Saves the whole game (state + storage) in a named slot (overwrites it). */
  saveSlot(name: string, label?: string): void;
  /** Loads a slot at the end of this frame; false when it does not exist. */
  loadSlot(name: string): boolean;
  deleteSlot(name: string): boolean;
  /** Slots: name, label, savedAt (game clock ms), scene. */
  listSlots(): SlotInfo[];
  /** Topmost entity whose box contains the world point (x, y), or null. */
  entityAt(x: number, y: number): ScriptEntity | null;
  /** Custom gameplay event: shows up in read_events / events('type'). */
  emit(type: string, data?: Record<string, unknown>): void;
  random(): number;
  randomInt(min: number, maxInclusive: number): number;
  win(): void;
  lose(): void;
  loadScene(id: string): void;
  /** Plays an audio asset (emits a "sound" event; the browser plays it). */
  playSound(asset: string, volume?: number): void;
  /** Creates an entity from a prefab (prefabs/<id>.json) at (x, y); returns it. */
  spawn(prefab: string, x: number, y: number, id?: string): ScriptEntity;
  /**
   * Uses the Interactable of `target` (id or entity), optionally as `actor` (then its tags and
   * range are checked). Same checks and events as a player interaction; returns { ok, reason? }.
   */
  interact(target: string | ScriptEntity, actor?: string | ScriptEntity): InteractResult;
  /**
   * Path between two places (entity, entity id or {x, y}) around solid colliders, or null. When `from` is an
   * entity its box is the clearance. Options: cell (16), diagonal (true), avoidTags.
   */
  findPath(from: PlaceRef, to: PlaceRef, options?: { cell?: number; diagonal?: boolean; avoidTags?: string[] }): PathResult | null;
  /**
   * Visual particles at a world point (no emitter entity needed): count 1..500 and ParticleEmitter
   * settings, e.g. { colors: ['#ff8fab'], text: '♥', speed: 80, gravity: -40, lifeMs: 900 }. Returns how many.
   */
  emitParticles(x: number, y: number, count: number, options?: EmitterOptions): number;
  /** Enabled interactables that `actor` may use and is in range of, nearest first. */
  nearbyInteractables(actor: string | ScriptEntity): NearbyInteractable[];
  /** The item catalog: get(id) (null if unknown), has(id), list({category?, tag?}). */
  readonly items: { get(id: string): ItemInfo | null; has(id: string): boolean; list(filter?: ItemFilter): ItemInfo[] };
  /** An inventory (default "default"): count, has, add, remove, list({category, tag}), size. Kept in storage. */
  inventory(name?: string): Inventory;
  /** Wallets: get(currency?), add(amount, currency?, reason?), spend(amount, currency?) → bool, all(). Default currency "coins". */
  readonly wallet: Wallet;
  /** Shop: list({category, tag}) = items with a price; buy(item, {qty, currency, inventory}) → {ok, ...} | {ok: false, reason}. */
  readonly shop: { list(filter?: ItemFilter): ItemInfo[]; buy(item: string, options?: BuyOptions): BuyResult };
  /** Uses an item on an entity: event "item_used" and its onItem hook; returns {handled, result}. */
  useItem(item: string | ItemInfo, target: string | ScriptEntity, by?: string | ScriptEntity): { handled: boolean; result: unknown };
}

/** Builds the `self`/`game` objects scripts see, bound to one world. */
class ScriptApi {
  private readonly entities = new WeakMap<Entity, ScriptEntity>();
  private readonly states = new WeakMap<Entity, Record<string, unknown>>();
  readonly game: ScriptGame;

  constructor(
    private readonly world: World,
    private readonly host: ScriptHost,
    /** Reports an error thrown by script code of entity `e` outside a hook call (timer callbacks). */
    private readonly report: (e: Entity, err: unknown, where: string) => void,
  ) {
    const w = world;
    const input = w.input;
    const { clock, storage } = host;
    const wrap = (e: Entity) => this.entity(e);
    const resolve = (ref: string | ScriptEntity | undefined, what: string): Entity => {
      const id = typeof ref === 'string' ? ref : ref?.id;
      const e = id === undefined ? undefined : w.get(id);
      if (!e) throw new Error(`${what}: entity "${String(id)}" does not exist`);
      return e;
    };
    this.game = {
      get frame() {
        return w.frame;
      },
      get time() {
        return w.time;
      },
      dt: FIXED_DT,
      get scene() {
        return w.scene.id;
      },
      get status() {
        return w.status;
      },
      get vars() {
        return w.vars;
      },
      entity: (id) => {
        const e = w.get(id);
        return e ? this.entity(e) : null;
      },
      find: (tag) => w.withTag(tag).map((e) => this.entity(e)),
      input: {
        isDown: (a) => input.action(a),
        pressed: (a) => input.actionPressed(a),
        released: (a) => input.actionReleased(a),
        get mouse() {
          const m = input.snapshot().mouse;
          return { x: m.x, y: m.y };
        },
        get mouseWorld() {
          return screenToWorld(w, input.mouse.x, input.mouse.y);
        },
        mouseDown: (b = 'left') => input.isMouseDown(b),
        mousePressed: (b = 'left') => input.wasMousePressed(b),
        get hovered() {
          const p = screenToWorld(w, input.mouse.x, input.mouse.y);
          const e = host.interactions.clickTargetAt(p.x, p.y);
          return e ? wrap(e) : null;
        },
        get doubleClicked() {
          return host.interactions.doubleClicked;
        },
        get drag() {
          return host.interactions.dragInfo();
        },
        get text() {
          return input.typed();
        },
      },
      clock: {
        get now() {
          return clock.now;
        },
        get hour() {
          return clock.hour;
        },
        get iso() {
          return clock.iso;
        },
        get speed() {
          return clock.speed;
        },
        set speed(v) {
          clock.speed = checkSpeed(v);
        },
      },
      storage: {
        get: (k) => storage.get(k),
        set: (k, v) => storage.set(k, v),
        remove: (k) => storage.remove(k),
        keys: () => storage.keys(),
      },
      saveSlot: (name, label) => host.saveSlot(name, label),
      loadSlot: (name) => host.loadSlot(name),
      deleteSlot: (name) => host.deleteSlot(name),
      listSlots: () => host.listSlots(),
      entityAt: (x, y) => {
        const e = topmostAt(w, x, y, () => true);
        return e ? this.entity(e) : null;
      },
      emit: (type, data = {}) => {
        if (typeof type !== 'string' || !type) throw new Error('game.emit(type): type must be a non-empty string');
        w.emit(type, { ...data });
      },
      random: () => w.rng.next(),
      randomInt: (min, max) => w.rng.int(min, max),
      win: () => {
        if (w.status !== 'running') return;
        w.status = 'won';
        w.emit('win', { by: 'script' });
      },
      lose: () => {
        if (w.status !== 'running') return;
        w.status = 'lost';
        w.emit('lose', { by: 'script' });
      },
      loadScene: (id) => {
        w.pendingScene = id;
      },
      playSound: (asset, volume = 1) => emitSound(w, asset, finite(volume, 'volume'), 'script'),
      spawn: (prefab, x, y, id) => this.entity(w.spawn(prefab, x, y, id)),
      interact: (target, actor) =>
        host.interactions.attempt(resolve(target, 'game.interact target'), actor === undefined ? undefined : resolve(actor, 'game.interact actor'), 'script'),
      findPath: (from, to, options = {}) => {
        const place = (ref: PlaceRef, what: string): { point: Point; entity?: Entity } => {
          if (ref && typeof ref === 'object' && !('id' in ref)) return { point: { x: finite(ref.x, `${what}.x`), y: finite(ref.y, `${what}.y`) } };
          const e = resolve(ref as string | ScriptEntity, `game.findPath ${what}`);
          return { point: { x: e.x, y: e.y }, entity: e };
        };
        const a = place(from, 'from');
        const b = place(to, 'to');
        const base = a.entity ? pathOptionsFor(a.entity) : {};
        return findPath(w, a.point, b.point, { ...base, ...options, ignore: [...(base.ignore ?? []), ...(b.entity ? [b.entity] : [])] });
      },
      emitParticles: (x, y, count, options) => w.particles.emitAt(x, y, count, options),
      nearbyInteractables: (actor) => host.interactions.nearby(resolve(actor, 'game.nearbyInteractables')),
      items: {
        get: (id) => host.items.get(String(id)),
        has: (id) => host.items.has(String(id)),
        list: (filter = {}) => host.items.list({ category: filter.category, tag: filter.tag }),
      },
      inventory: (name) => host.economy.inventory(name),
      wallet: host.economy.wallet,
      shop: {
        list: (filter = {}) => host.economy.forSale({ category: filter.category, tag: filter.tag }),
        buy: (item, options = {}) => host.economy.buy(String(item), options),
      },
      useItem: (item, target, by) =>
        host.useItem(
          typeof item === 'string' ? item : String(item?.id),
          resolve(target, 'game.useItem target'),
          by === undefined ? undefined : resolve(by, 'game.useItem by'),
        ),
    };
  }

  entity(e: Entity): ScriptEntity {
    let api = this.entities.get(e);
    if (api) return api;
    const w = this.world;
    const states = this.states;
    const body = () => e.components.Body;
    const host = this.host;
    const fsm: ScriptFsm = {
      get state() {
        return fsmOf(e)?.state ?? null;
      },
      get previous() {
        return fsmOf(e)?.previous ?? null;
      },
      get time() {
        const st = fsmOf(e);
        return st ? stateMs(w, st) / 1000 : 0;
      },
      is: (...names) => names.includes(fsmOf(e)?.state as string),
      go: (to) => host.stateMachines.go(e, String(to)),
    };
    const ai: ScriptAi = {
      get choice() {
        return aiOf(e)?.choice ?? null;
      },
      get scores() {
        return { ...(aiOf(e)?.scores ?? {}) };
      },
      get target() {
        return aiOf(e)?.target ?? null;
      },
      decide: () => host.utility.decide(e),
    };
    const schedule = (ms: number, every: number | undefined, fn: () => void, id?: string) => {
      if (typeof fn !== 'function') throw new Error('timer callback must be a function');
      if (id !== undefined && (typeof id !== 'string' || !id)) throw new Error('timer id must be a non-empty string');
      const timerId: string = w.timers.schedule({ id, ms, every, owner: e, run: fn, onError: (err) => this.report(e, err, `timer "${timerId}"`) });
      return timerId;
    };
    const navAgent = () => {
      const n = e.components.NavAgent;
      if (!n) throw new Error(`entity "${e.id}" has no NavAgent`);
      return n;
    };
    const nav: ScriptNav = {
      get status() {
        return e.nav?.status ?? 'idle';
      },
      get path() {
        return (e.nav?.path ?? []).map((p) => ({ ...p }));
      },
      get target() {
        const t = e.components.NavAgent?.target ?? null;
        return t && typeof t === 'object' ? { ...t } : t;
      },
      goTo: (t) => {
        const n = navAgent();
        if (t && typeof t === 'object' && 'x' in t && 'y' in t && !('id' in t)) n.target = { x: finite(t.x, 'x'), y: finite(t.y, 'y') };
        else {
          const id = typeof t === 'string' ? t : (t as ScriptEntity | undefined)?.id;
          if (!id || !w.get(id)) throw new Error(`nav.goTo: entity "${String(id)}" does not exist`);
          n.target = id;
        }
      },
      stop: () => {
        navAgent().target = null;
      },
    };
    const emitter = () => {
      const em = e.components.ParticleEmitter;
      if (!em) throw new Error(`entity "${e.id}" has no ParticleEmitter`);
      return em;
    };
    const particles = {
      burst: (count?: number) => w.particles.burst(e, count === undefined ? undefined : Math.max(1, Math.min(500, Math.round(finite(count, 'count'))))),
      get emitting() {
        return emitter().emitting;
      },
      set emitting(v: boolean) {
        emitter().emitting = !!v;
      },
      get alive() {
        return w.particles.aliveOf(e.id);
      },
    };
    const animator = () => {
      const a = e.components.Animator;
      if (!a) throw new Error(`entity "${e.id}" has no Animator`);
      return a;
    };
    const anim: ScriptAnim = {
      get name() {
        return e.animName;
      },
      get frame() {
        return Math.max(0, animFrameIndex(e));
      },
      play: (clip) => {
        const a = animator();
        if (!Object.hasOwn(a.animations, clip)) throw new Error(`animation "${clip}" does not exist (animations: ${Object.keys(a.animations).join(', ')})`);
        e.animOverride = clip;
        // Playing the same one-shot again restarts it.
        if (e.animName === clip) e.animName = null;
      },
      stop: () => {
        e.animOverride = null;
      },
      get speed() {
        return animator().speed;
      },
      set speed(v) {
        animator().speed = Math.max(0, finite(v, 'anim.speed'));
      },
    };
    const individuals = host.individuals;
    const traitsData = () => {
      const t = e.components.Traits;
      if (!t) throw new Error(`entity "${e.id}" has no Traits`);
      individuals.ensure(e);
      return t;
    };
    const prefsData = () => {
      const p = e.components.Preferences;
      if (!p) throw new Error(`entity "${e.id}" has no Preferences`);
      individuals.ensure(e);
      return p;
    };
    const traits: ScriptTraits = {
      get: (axis) => (traitsData(), traitOf(e, String(axis))),
      set: (axis, v) => {
        traitsData().values[String(axis)] = Math.min(1, Math.max(0, finite(v, 'trait')));
        individuals.touch(e);
      },
      has: (axis) => Object.hasOwn(traitsData().values, String(axis)),
      all: () => ({ ...traitsData().values }),
    };
    const prefs: ScriptPrefs = {
      of: (subject) => (prefsData(), affinityOf(e, String(subject))),
      known: (subject) => Object.hasOwn(prefsData().values, String(subject)),
      evaluate: (subject, tags = []) => {
        prefsData();
        if (!Array.isArray(tags)) throw new Error('prefs.evaluate: tags must be an array');
        return evaluate(e, subject === null ? null : String(subject), tags.map(String));
      },
      level: (score) => preferenceLevel(finite(score, 'score')),
      item: (item) => {
        prefsData();
        return evaluateItem(e, host.items.require(typeof item === 'string' ? item : item?.id));
      },
      learn: (subject, outcome) => {
        prefsData();
        const v = learn(e, String(subject), finite(outcome, 'outcome'));
        individuals.touch(e);
        return v;
      },
      set: (subject, innate) => {
        const p = prefsData();
        const v = (p.values[String(subject)] ??= { innate: 0, learned: 0, n: 0 });
        v.innate = Math.min(1, Math.max(-1, finite(innate, 'innate')));
        individuals.touch(e);
      },
      all: () => {
        const p = prefsData();
        return Object.fromEntries(Object.keys(p.values).map((k) => [k, affinityOf(e, k)]));
      },
    };
    const routineData = () => {
      if (!e.components.Routine) throw new Error(`entity "${e.id}" has no Routine`);
      individuals.ensure(e);
    };
    const routine: ScriptRoutine = {
      record: (activity, weight = 1) => {
        routineData();
        recordActivity(e, host.clock, String(activity), finite(weight, 'weight'));
        individuals.touch(e);
      },
      habit: (activity, hour) => (routineData(), habitOf(e, String(activity), hour === undefined ? host.clock.hour : finite(hour, 'hour'))),
      peak: (activity) => (routineData(), peakOf(e, String(activity))),
      patterns: (minShare) => (routineData(), patternsOf(e, minShare === undefined ? undefined : finite(minShare, 'minShare'))),
    };
    const persist: ScriptPersist = {
      get key() {
        return e.components.Persist?.key ?? null;
      },
      save: () => individuals.save(e),
      reset: (preset) => individuals.reset(e, preset ?? {}),
    };
    api = {
      id: e.id,
      name: e.name,
      get tags() {
        return [...e.tags];
      },
      hasTag: (t) => e.hasTag(t),
      traits,
      prefs,
      routine,
      persist,
      get x() {
        return e.x;
      },
      set x(v) {
        e.x = finite(v, 'x');
      },
      get y() {
        return e.y;
      },
      set y(v) {
        e.y = finite(v, 'y');
      },
      get scaleX() {
        return e.scaleX;
      },
      set scaleX(v) {
        e.scaleX = finite(v, 'scaleX');
      },
      get scaleY() {
        return e.scaleY;
      },
      set scaleY(v) {
        e.scaleY = finite(v, 'scaleY');
      },
      get rotation() {
        return e.rotation;
      },
      set rotation(v) {
        e.rotation = finite(v, 'rotation');
      },
      get vx() {
        return body()?.vx ?? 0;
      },
      set vx(v) {
        requireBody(e).vx = finite(v, 'vx');
      },
      get vy() {
        return body()?.vy ?? 0;
      },
      set vy(v) {
        requireBody(e).vy = finite(v, 'vy');
      },
      get grounded() {
        return e.grounded;
      },
      get enabled() {
        return e.enabled;
      },
      set enabled(v) {
        e.enabled = !!v;
      },
      get destroyed() {
        return e.destroyed;
      },
      get health() {
        return e.components.Health?.current;
      },
      get props() {
        return (e.components.Script?.props ?? {}) as Record<string, VarValue>;
      },
      get state() {
        let s = states.get(e);
        if (!s) states.set(e, (s = {}));
        return s;
      },
      fsm,
      ai,
      anim,
      nav,
      particles,
      after: (ms, fn, id) => schedule(ms, undefined, fn, id),
      every: (ms, fn, id) => schedule(ms, ms, fn, id),
      cancel: (id) => w.timers.cancel(String(id), e),
      get timers() {
        return w.timers.list(e);
      },
      cooldown: (name, ms) => cooldown(w, e, String(name), finite(ms, 'cooldown ms')),
      tween: (prop, to, ms, options = {}) => {
        if (options.onDone !== undefined && typeof options.onDone !== 'function') throw new Error('tween onDone must be a function');
        const id: string = w.tweens.start(e, { ...options, prop: String(prop), to, ms, onError: (err) => this.report(e, err, `onDone of tween "${id}"`) });
        return id;
      },
      stopTween: (idOrProp) => w.tweens.stop(e, idOrProp === undefined ? undefined : String(idOrProp)),
      get tweens() {
        return w.tweens.list(e);
      },
      get: (type) => e.components[type] as Record<string, unknown> | undefined,
      damage: (amount) => applyDamage(w, e, amount),
      destroy: () => w.destroy(e),
    };
    this.entities.set(e, api);
    return api;
  }
}

function finite(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number (got ${String(v)})`);
  return v;
}

function requireBody(e: Entity) {
  const b = e.components.Body;
  if (!b) throw new Error(`entity "${e.id}" has no Body: add one to set its velocity`);
  return b;
}

/** Deterministic Math for scripts: Math.random comes from the game's seeded RNG. */
function seededMath(world: World): Math {
  const m = Object.create(Math) as Math;
  Object.defineProperty(m, 'random', { value: () => world.rng.next() });
  return m;
}

/** Runs the scripts of one world. Created per scene load (like the world itself). */
export class ScriptRunner {
  private readonly api: ScriptApi;
  private readonly math: Math;

  private processed: number;

  constructor(
    private readonly world: World,
    private readonly library: ScriptLibrary,
    host: ScriptHost,
  ) {
    this.api = new ScriptApi(world, host, (e, err, where) => {
      const inst = e.script;
      if (inst && !inst.failed) this.fail(e, inst, describe(err, inst.file, e, where));
    });
    this.math = seededMath(world);
    this.processed = world.emitted;
  }

  private instance(e: Entity): ScriptInstance | null {
    const c = e.components.Script;
    if (!c) return null;
    if (e.script?.file === c.src) return e.script;
    const factory = this.library.factory(c.src);
    const inst: ScriptInstance = { file: c.src, hooks: {}, started: false, failed: false };
    e.script = inst;
    if (factory instanceof Error) {
      this.fail(e, inst, factory.message);
      return inst;
    }
    try {
      inst.hooks = factory(this.math, this.consoleFor(e, c.src)) ?? {};
    } catch (err) {
      this.fail(e, inst, describe(err, c.src, e, 'top level'));
    }
    return inst;
  }

  private consoleFor(e: Entity, file: string): ScriptConsole {
    const source = `${file}(${e.id})`;
    const text = (args: unknown[]) => args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ');
    return {
      log: (...a) => this.world.console.log(text(a), source),
      warn: (...a) => this.world.console.warn(text(a), source),
      error: (...a) => this.world.console.error(text(a), source),
    };
  }

  private fail(e: Entity, inst: ScriptInstance, message: string) {
    inst.failed = true;
    this.world.console.error(`Script error: ${message}\n(script disabled on "${e.id}" until the game restarts)`, 'script');
    this.world.emit('script_error', { entity: e.id, script: inst.file, message });
  }

  private call(e: Entity, inst: ScriptInstance, hook: keyof ScriptHooks, run: () => void) {
    try {
      run();
    } catch (err) {
      this.fail(e, inst, describe(err, inst.file, e, hook));
    }
  }

  /**
   * onStart of every active scripted entity that has not started yet. Runs at the start of the
   * frame, so no other hook (click, interaction, collision...) reaches a script before its onStart.
   */
  start() {
    const w = this.world;
    for (const e of [...w.entities]) {
      if (!e.active || w.status !== 'running') continue;
      const inst = this.instance(e);
      if (inst && !inst.failed) this.startOnce(e, inst);
    }
  }

  private startOnce(e: Entity, inst: ScriptInstance) {
    if (inst.started) return;
    inst.started = true;
    if (inst.hooks.onStart) this.call(e, inst, 'onStart', () => inst.hooks.onStart!(this.api.entity(e), this.api.game));
  }

  /** onUpdate for every active scripted entity (onStart first for ones that appeared during the frame). */
  update(dt: number) {
    const w = this.world;
    for (const e of [...w.entities]) {
      if (!e.active || w.status !== 'running') continue;
      const inst = this.instance(e);
      if (!inst || inst.failed) continue;
      const self = this.api.entity(e);
      this.startOnce(e, inst);
      if (inst.hooks.onUpdate && !inst.failed && e.active) this.call(e, inst, 'onUpdate', () => inst.hooks.onUpdate!(self, this.api.game, dt));
    }
  }

  hasClickHandler(e: Entity) {
    return !!this.instance(e)?.hooks.onClick;
  }

  /** onClick of the clicked entity (the InteractionRunner picks it). */
  click(target: Entity, pos: { x: number; y: number }) {
    const inst = this.instance(target);
    if (inst && !inst.failed && inst.hooks.onClick) {
      this.call(target, inst, 'onClick', () => inst.hooks.onClick!(this.api.entity(target), this.api.game, pos));
    }
  }

  /** onDecision of an entity whose UtilityAI chose something new. */
  decided(e: Entity, decision: { choice: string; from: string | null; scores: Record<string, number | null>; target: string | null }) {
    const inst = this.instance(e);
    if (inst && !inst.failed && inst.hooks.onDecision && e.active) {
      this.call(e, inst, 'onDecision', () => inst.hooks.onDecision!(this.api.entity(e), structuredClone(decision), this.api.game));
    }
  }

  /** onStateChange of an entity whose StateMachine changed state. */
  stateChanged(e: Entity, change: { from: string | null; to: string }) {
    const inst = this.instance(e);
    if (inst && !inst.failed && inst.hooks.onStateChange && e.active) {
      this.call(e, inst, 'onStateChange', () => inst.hooks.onStateChange!(this.api.entity(e), { ...change }, this.api.game));
    }
  }

  /** onItem of the entity an item was used on: whether a hook ran, and what it returned (JSON). */
  itemUsed(target: Entity, item: ItemInfo, by: Entity | undefined): { handled: boolean; result: unknown } {
    const inst = this.instance(target);
    if (!inst || inst.failed || !inst.hooks.onItem || !target.active) return { handled: false, result: undefined };
    let result: unknown;
    this.call(target, inst, 'onItem', () => {
      result = inst.hooks.onItem!(this.api.entity(target), structuredClone(item), this.api.game, by ? this.api.entity(by) : null);
    });
    return { handled: true, result: result === undefined ? undefined : JSON.parse(JSON.stringify(result)) };
  }

  /** onInteract of an interactable that was used. */
  interact(target: Entity, by: Entity | undefined, info: { action: string; via: InteractVia }) {
    const inst = this.instance(target);
    if (inst && !inst.failed && inst.hooks.onInteract && target.active) {
      const actor = by ? this.api.entity(by) : null;
      this.call(target, inst, 'onInteract', () => inst.hooks.onInteract!(this.api.entity(target), actor, this.api.game, { ...info }));
    }
  }

  /** onEvent with the events emitted since the previous call (events emitted by onEvent come next frame). */
  events() {
    const w = this.world;
    const count = Math.min(w.emitted - this.processed, w.events.length);
    this.processed = w.emitted;
    if (count <= 0) return;
    const fresh = w.events.slice(-count);
    for (const e of [...w.entities]) {
      if (!e.active) continue;
      const inst = this.instance(e);
      if (!inst || inst.failed || !inst.hooks.onEvent) continue;
      const self = this.api.entity(e);
      for (const ev of fresh) {
        if (inst.failed || !e.active) break;
        this.call(e, inst, 'onEvent', () => inst.hooks.onEvent!(self, { ...ev }, this.api.game));
      }
    }
  }

  /** onCollision on both sides of each contact that began this frame. */
  collisions(entered: [Entity, Entity][]) {
    for (const [a, b] of entered) {
      for (const [self, other] of [[a, b], [b, a]] as const) {
        if (!self.active || !other.active || this.world.status !== 'running') continue;
        const inst = this.instance(self);
        if (!inst || inst.failed || !inst.hooks.onCollision) continue;
        this.call(self, inst, 'onCollision', () => inst.hooks.onCollision!(this.api.entity(self), this.api.entity(other), this.api.game));
      }
    }
  }
}

function describe(err: unknown, file: string, e: Entity, where: string): string {
  const at = scriptLocation(err, file) ?? file;
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : `thrown value ${safeJson(err)}`;
  return `${at} in ${where} of "${e.id}": ${msg}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
