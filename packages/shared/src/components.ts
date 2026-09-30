import { z } from 'zod';

/**
 * Built-in component schemas.
 *
 * Every component is plain JSON data. Defaults are filled in by the schema, so a
 * scene file (or an agent tool call) only needs to specify what differs from them.
 * The `.describe()` texts are exported to the agent as documentation.
 */

const tagList = (fallback: string[]) =>
  z.array(z.string()).default(() => [...fallback]);

export const SpriteSchema = z.strictObject({
  asset: z.string().optional().describe('Asset id (image or spritesheet). If omitted, a colored shape is drawn.'),
  frame: z.number().int().min(0).default(0).describe('Spritesheet frame index.'),
  width: z.number().positive().default(32),
  height: z.number().positive().default(32),
  color: z.string().default('#ffffff').describe('Fill color when no asset is set (CSS color).'),
  shape: z.enum(['rect', 'circle', 'triangle']).default('rect'),
  flipX: z.boolean().default(false),
  faceVelocity: z.boolean().default(true).describe('Automatically flip horizontally to face the direction of movement.'),
  visible: z.boolean().default(true),
  layer: z.number().default(0).describe('Draw order; higher is drawn on top.'),
  opacity: z.number().min(0).max(1).default(1),
});

export const BodySchema = z.strictObject({
  type: z.enum(['dynamic', 'static', 'kinematic']).default('dynamic')
    .describe('dynamic: gravity + collides with solids. static: never moves. kinematic: moves by velocity, no gravity, no collision response.'),
  vx: z.number().default(0).describe('Horizontal velocity in px/s.'),
  vy: z.number().default(0).describe('Vertical velocity in px/s (positive is down).'),
  gravityScale: z.number().default(1),
  maxFallSpeed: z.number().positive().default(900),
});

export const ColliderSchema = z.strictObject({
  width: z.number().positive().default(32),
  height: z.number().positive().default(32),
  offsetX: z.number().default(0),
  offsetY: z.number().default(0),
  isTrigger: z.boolean().default(false).describe('Triggers detect overlaps but never block movement.'),
  oneWay: z.boolean().default(false).describe('Solid only when landed on from above (jump-through platform).'),
});

export const PlatformerControllerSchema = z.strictObject({
  moveSpeed: z.number().min(0).default(180),
  acceleration: z.number().positive().default(1800),
  deceleration: z.number().positive().default(2200),
  airControl: z.number().min(0).max(1).default(0.7),
  jumpSpeed: z.number().min(0).default(560).describe('Initial upward speed; jump height = jumpSpeed^2 / (2*gravity).'),
  maxJumps: z.number().int().min(1).default(1).describe('2 = double jump.'),
  coyoteTime: z.number().min(0).default(0.08),
  jumpBuffer: z.number().min(0).default(0.1),
  variableJumpCut: z.number().min(0).max(1).default(0.5).describe('Upward velocity multiplier when jump is released early.'),
  leftAction: z.string().default('left'),
  rightAction: z.string().default('right'),
  jumpAction: z.string().default('jump'),
});

export const PatrolSchema = z.strictObject({
  speed: z.number().min(0).default(60),
  distance: z.number().min(0).default(128).describe('Total patrol width centered on the spawn x. 0 = unlimited.'),
  turnAtEdges: z.boolean().default(true).describe('Turn around instead of walking off a ledge.'),
  startDirection: z.union([z.literal(1), z.literal(-1)]).default(1),
});

export const FollowTargetSchema = z.strictObject({
  targetId: z.string().optional().describe('Entity id to follow. Takes precedence over targetTag.'),
  targetTag: z.string().default('player').describe('Follow the nearest entity with this tag.'),
  speed: z.number().min(0).default(80),
  activationRange: z.number().min(0).default(250),
  mode: z.enum(['horizontal', 'free']).default('horizontal').describe('horizontal: walks along x (use with gravity). free: flies toward the target.'),
  stopDistance: z.number().min(0).default(2),
});

export const HealthSchema = z.strictObject({
  max: z.number().int().positive().default(3),
  current: z.number().int().min(0).optional().describe('Defaults to max.'),
  invulnerableTime: z.number().min(0).default(1),
  onDeath: z.enum(['destroy', 'lose', 'respawn', 'none']).default('destroy')
    .describe('lose: the game is lost. respawn: back to the last checkpoint with full health.'),
});

export const DamageSchema = z.strictObject({
  amount: z.number().int().min(0).default(1),
  targetTags: tagList(['player']),
  knockback: z.number().min(0).default(260),
  destroyOnHit: z.boolean().default(false),
});

export const StompableSchema = z.strictObject({
  stomperTags: tagList(['player']),
  bounceSpeed: z.number().min(0).default(380),
  damage: z.number().int().min(0).default(1).describe('Damage taken when stomped. Destroyed if it has no Health.'),
});

export const CollectibleSchema = z.strictObject({
  collectorTags: tagList(['player']),
  variable: z.string().default('coins').describe('Game variable incremented when collected.'),
  amount: z.number().default(1),
  score: z.number().default(0).describe('Added to the "score" variable.'),
  heal: z.number().int().min(0).default(0),
});

export const GoalSchema = z.strictObject({
  collectorTags: tagList(['player']),
  action: z.enum(['win', 'loadScene']).default('win'),
  scene: z.string().optional().describe('Scene to load when action is loadScene.'),
  require: z.record(z.string(), z.number()).optional()
    .describe('Minimum variable values required, e.g. {"coins": 3}.'),
});

export const CheckpointSchema = z.strictObject({
  activatorTags: tagList(['player']),
});

export const TextSchema = z.strictObject({
  text: z.string().default('').describe('Supports {var} and {entityId.health|maxHealth|x|y} placeholders.'),
  fontSize: z.number().positive().default(16),
  font: z.string().default('monospace'),
  color: z.string().default('#ffffff'),
  align: z.enum(['left', 'center', 'right']).default('left'),
  screenSpace: z.boolean().default(true).describe('true: fixed on screen (HUD). false: placed in the world.'),
  layer: z.number().default(100),
});

export const AnimationClipSchema = z.strictObject({
  frames: z.array(z.number().int().min(0)).min(1),
  fps: z.number().positive().default(8),
  loop: z.boolean().default(true),
});

export const AnimatorSchema = z.strictObject({
  animations: z.record(z.string(), AnimationClipSchema).default(() => ({})),
  initial: z.string().default('idle'),
  auto: z.boolean().default(true).describe('Pick idle/run/jump/fall from the body state automatically.'),
});

/** Registry of all built-in components. Add new component types here. */
export const ComponentSchemas = {
  Sprite: SpriteSchema,
  Body: BodySchema,
  Collider: ColliderSchema,
  PlatformerController: PlatformerControllerSchema,
  Patrol: PatrolSchema,
  FollowTarget: FollowTargetSchema,
  Health: HealthSchema,
  Damage: DamageSchema,
  Stompable: StompableSchema,
  Collectible: CollectibleSchema,
  Goal: GoalSchema,
  Checkpoint: CheckpointSchema,
  Text: TextSchema,
  Animator: AnimatorSchema,
} as const;

export type ComponentType = keyof typeof ComponentSchemas;
export const COMPONENT_TYPES = Object.keys(ComponentSchemas) as ComponentType[];

export const ComponentsSchema = z.strictObject({
  Sprite: SpriteSchema.optional(),
  Body: BodySchema.optional(),
  Collider: ColliderSchema.optional(),
  PlatformerController: PlatformerControllerSchema.optional(),
  Patrol: PatrolSchema.optional(),
  FollowTarget: FollowTargetSchema.optional(),
  Health: HealthSchema.optional(),
  Damage: DamageSchema.optional(),
  Stompable: StompableSchema.optional(),
  Collectible: CollectibleSchema.optional(),
  Goal: GoalSchema.optional(),
  Checkpoint: CheckpointSchema.optional(),
  Text: TextSchema.optional(),
  Animator: AnimatorSchema.optional(),
});

export type Components = z.output<typeof ComponentsSchema>;
export type ComponentData<T extends ComponentType> = z.output<(typeof ComponentSchemas)[T]>;
export type ComponentInput<T extends ComponentType> = z.input<(typeof ComponentSchemas)[T]>;
