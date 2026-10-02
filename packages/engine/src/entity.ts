import type { Components, EntityData } from '@vibe/shared';
import type { FsmState } from './fsm';
import type { NavState } from './nav';
import type { AABB } from './math';
import type { AiState } from './utility';
import type { ScriptInstance } from './scripts';

/** Runtime instance of an entity. Component data is a deep copy of the scene data and may be mutated. */
export class Entity {
  readonly id: string;
  /** Prefab it was created from (instances and spawned entities). */
  readonly prefab?: string;
  name: string;
  tags: Set<string>;
  enabled: boolean;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  components: Components;
  destroyed = false;

  // Runtime state maintained by systems (not part of the scene file).
  readonly spawnX: number;
  readonly spawnY: number;
  grounded = false;
  groundId: string | null = null;
  onWallLeft = false;
  onWallRight = false;
  coyoteTimer = 0;
  jumpBufferTimer = 0;
  jumpsUsed = 0;
  stunTimer = 0;
  invulnTimer = 0;
  patrolDir: number;
  /** Animator: clip showing, time in it (s), last frame step shown, whether a one-shot ended. */
  animName: string | null = null;
  animTime = 0;
  animStep = -1;
  animEnded = false;
  /** Clip played by a script (self.anim.play) and the base clip (initial / next). */
  animOverride: string | null = null;
  animBase: string | null = null;
  /** Mover progress: waypoint index, direction (ping-pong) and remaining pause in frames. */
  mover?: { target: number; dir: number; wait: number };
  /** Interactable state: frame from which it can be used again, successful uses. */
  interact?: { readyAt: number; uses: number };
  /** StateMachine state (created on first use; see fsm.ts). */
  fsm?: FsmState;
  /** Cooldowns started with self.cooldown(): name -> frame it is ready again. */
  cooldowns?: Record<string, number>;
  /** NavAgent state (see nav.ts). */
  nav?: NavState;
  /** UtilityAI state (created on first use; see utility.ts). */
  ai?: AiState;
  /** Script instance (created on first use by the ScriptRunner). */
  script?: ScriptInstance;

  constructor(data: EntityData) {
    this.id = data.id;
    if (data.prefab) this.prefab = data.prefab;
    this.name = data.name ?? data.id;
    this.tags = new Set(data.tags);
    this.enabled = data.enabled;
    this.x = this.prevX = this.spawnX = data.transform.x;
    this.y = this.prevY = this.spawnY = data.transform.y;
    this.rotation = data.transform.rotation;
    this.scaleX = data.transform.scaleX;
    this.scaleY = data.transform.scaleY;
    this.components = structuredClone(data.components);
    const h = this.components.Health;
    if (h && h.current === undefined) h.current = h.max;
    this.patrolDir = this.components.Patrol?.startDirection ?? 1;
  }

  get active() {
    return this.enabled && !this.destroyed;
  }

  hasTag(tag: string) {
    return this.tags.has(tag);
  }

  hasAnyTag(tags: readonly string[]) {
    return tags.some((t) => this.tags.has(t));
  }

  /** Collider box at the current position (or at a given center). */
  aabb(cx = this.x, cy = this.y): AABB | null {
    const c = this.components.Collider;
    if (!c) return null;
    return { x: cx + c.offsetX - c.width / 2, y: cy + c.offsetY - c.height / 2, w: c.width, h: c.height };
  }

  prevAabb(): AABB | null {
    return this.aabb(this.prevX, this.prevY);
  }

  /** Whether this entity blocks dynamic bodies. */
  get isSolid() {
    const c = this.components.Collider;
    if (!c || c.isTrigger) return false;
    return this.components.Body?.type !== 'dynamic';
  }

  get health() {
    return this.components.Health?.current;
  }
}
