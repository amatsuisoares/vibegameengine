import type { EntityData, PrefabData, ProjectConfig, Scene, VarValue } from '@vibe/shared';
import type { GameConsole } from './console';
import { Entity } from './entity';
import type { Input } from './input';
import { Rng } from './rng';
import { Scheduler } from './timers';
import { TweenRunner } from './tweens';
import { ParticleSystem } from './particles';
import type { Economy } from './economy';
import type { Notifier } from './notifier';
import type { SlotHost } from './saves';

export type GameStatus = 'running' | 'won' | 'lost' | 'crashed';

export interface GameEvent {
  frame: number;
  type: string;
  [key: string]: unknown;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export const FIXED_DT = 1 / 60;

/** All mutable state of one running scene. Systems read and write it. */
export class World {
  readonly entities: Entity[] = [];
  private readonly byId = new Map<string, Entity>();
  vars: Record<string, VarValue>;
  status: GameStatus = 'running';
  frame = 0;
  time = 0;
  readonly camera: CameraState;
  cameraInitialized = false;
  /** Respawn point per entity id, set by checkpoints. */
  readonly respawnPoints = new Map<string, { x: number; y: number }>();
  /** Contact pair keys from the previous frame (for enter-only interactions). */
  prevContacts = new Set<string>();
  pendingScene: string | null = null;
  /** Save slots (set by the Game) for rule actions. */
  slots: SlotHost | null = null;
  /** Inventories, wallets and shop (set by the Game) for rule actions. */
  economy: Economy | null = null;
  /** The game's notifier (game.notify), for the rule action "notify". */
  notifier: Notifier | null = null;
  /** Interactable that the interaction key would use now, and by which actor (for the on-screen prompt). */
  interactFocus: { entity: string; by: string } | null = null;
  readonly events: GameEvent[] = [];
  /** Timers of this scene (scripts' self.after/every, rule and state "after" actions). */
  readonly timers: Scheduler = new Scheduler(this);
  /** Tweens of this scene (self.tween, "tween" actions). */
  readonly tweens: TweenRunner = new TweenRunner(this);
  /** Visual particles of this scene (reseeded from the game seed by the Game). */
  readonly particles: ParticleSystem = new ParticleSystem(this);
  private eventCapacity = 2000;

  constructor(
    readonly config: ProjectConfig,
    readonly scene: Scene,
    readonly input: Input,
    readonly console: GameConsole,
    readonly rng: Rng,
    vars: Record<string, VarValue>,
  ) {
    this.vars = vars;
    this.camera = { x: scene.camera.x, y: scene.camera.y, zoom: scene.camera.zoom };
    for (const data of scene.entities) this.add(new Entity(data));
  }

  /** Entity templates that rules and scripts can spawn (set by the Game). */
  prefabs: Record<string, PrefabData> = {};
  private spawned = 0;

  /** Creates an entity from a prefab at (x, y). Ids default to <prefab><n>. */
  spawn(prefabId: string, x: number, y: number, id?: string): Entity {
    const prefab = this.prefabs[prefabId];
    if (!prefab) throw new Error(`prefab "${prefabId}" does not exist (prefabs: ${Object.keys(this.prefabs).join(', ') || 'none'})`);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`spawn position must be finite numbers (got ${x}, ${y})`);
    let newId = id;
    if (newId !== undefined) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(newId)) throw new Error(`invalid entity id "${newId}"`);
      if (this.byId.has(newId)) throw new Error(`entity "${newId}" already exists`);
    } else {
      do newId = `${prefabId}${++this.spawned}`;
      while (this.byId.has(newId));
    }
    const data = structuredClone(prefab) as EntityData;
    data.id = newId;
    data.prefab = prefabId;
    data.transform = { ...data.transform, x, y };
    const e = this.add(new Entity(data));
    this.emit('spawn', { entity: newId, prefab: prefabId, x, y });
    return e;
  }

  add(e: Entity) {
    if (this.byId.has(e.id)) throw new Error(`Duplicate entity id "${e.id}"`);
    this.entities.push(e);
    this.byId.set(e.id, e);
    return e;
  }

  get(id: string): Entity | undefined {
    const e = this.byId.get(id);
    return e && !e.destroyed ? e : undefined;
  }

  withTag(tag: string): Entity[] {
    return this.entities.filter((e) => e.active && e.hasTag(tag));
  }

  get active(): Entity[] {
    return this.entities.filter((e) => e.active);
  }

  destroy(e: Entity) {
    e.destroyed = true;
  }

  /** Removes destroyed entities; called at the end of each step. */
  flushDestroyed() {
    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      if (e.destroyed) {
        this.entities.splice(i, 1);
        this.byId.delete(e.id);
      }
    }
  }

  /** Events emitted in this world so far (the array keeps only the most recent ones). */
  emitted = 0;

  emit(type: string, data: Record<string, unknown> = {}) {
    this.emitted++;
    this.events.push({ frame: this.frame, type, ...data });
    if (this.events.length > this.eventCapacity) this.events.splice(0, this.events.length - this.eventCapacity);
  }

  addVar(name: string, amount: number) {
    const cur = this.vars[name];
    this.vars[name] = (typeof cur === 'number' ? cur : 0) + amount;
  }

  get killY() {
    return this.scene.killY ?? this.scene.height + 100;
  }

  respawnPointOf(e: Entity) {
    return this.respawnPoints.get(e.id) ?? { x: e.spawnX, y: e.spawnY };
  }
}
