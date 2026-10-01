import type { ComponentType, VarValue } from '@vibe/shared';
import type { Entity } from './entity';
import { emitSound } from './sound';
import { applyDamage } from './systems/interactions';
import { FIXED_DT, type World } from './world';

/**
 * Scripts: project files `scripts/*.js` attached to entities by the `Script` component.
 * A script defines any of these functions (plain JavaScript, no imports):
 *
 *   function onStart(self, game) {}              // first frame of the entity
 *   function onUpdate(self, game, dt) {}         // every frame, after controllers, before physics
 *   function onCollision(self, other, game) {}   // when a contact with `other` begins
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
  return `"use strict";${source}\n;return { onStart: typeof onStart === "function" ? onStart : undefined, onUpdate: typeof onUpdate === "function" ? onUpdate : undefined, onCollision: typeof onCollision === "function" ? onCollision : undefined };\n//# sourceURL=${file}`;
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
    readonly mouse: { x: number; y: number };
  };
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
}

/** Builds the `self`/`game` objects scripts see, bound to one world. */
class ScriptApi {
  private readonly entities = new WeakMap<Entity, ScriptEntity>();
  private readonly states = new WeakMap<Entity, Record<string, unknown>>();
  readonly game: ScriptGame;

  constructor(private readonly world: World) {
    const w = world;
    const input = w.input;
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
    };
  }

  entity(e: Entity): ScriptEntity {
    let api = this.entities.get(e);
    if (api) return api;
    const w = this.world;
    const states = this.states;
    const body = () => e.components.Body;
    api = {
      id: e.id,
      name: e.name,
      get tags() {
        return [...e.tags];
      },
      hasTag: (t) => e.hasTag(t),
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

  constructor(
    private readonly world: World,
    private readonly library: ScriptLibrary,
  ) {
    this.api = new ScriptApi(world);
    this.math = seededMath(world);
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

  /** onStart (once) and onUpdate for every active scripted entity. */
  update(dt: number) {
    const w = this.world;
    for (const e of [...w.entities]) {
      if (!e.active || w.status !== 'running') continue;
      const inst = this.instance(e);
      if (!inst || inst.failed) continue;
      const self = this.api.entity(e);
      if (!inst.started) {
        inst.started = true;
        if (inst.hooks.onStart) this.call(e, inst, 'onStart', () => inst.hooks.onStart!(self, this.api.game));
      }
      if (inst.hooks.onUpdate && !inst.failed && e.active) this.call(e, inst, 'onUpdate', () => inst.hooks.onUpdate!(self, this.api.game, dt));
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
