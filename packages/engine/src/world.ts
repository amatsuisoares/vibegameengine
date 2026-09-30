import type { ProjectConfig, Scene, VarValue } from '@vibe/shared';
import type { GameConsole } from './console';
import { Entity } from './entity';
import type { Input } from './input';
import { Rng } from './rng';

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
  readonly events: GameEvent[] = [];
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

  emit(type: string, data: Record<string, unknown> = {}) {
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
