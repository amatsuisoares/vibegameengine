import { z } from 'zod';
import { RuleActionSchema } from './rules';

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

export const MoverSchema = z.strictObject({
  path: z
    .array(z.strictObject({ x: z.number(), y: z.number() }))
    .min(1)
    .describe('Waypoints relative to the start position, e.g. [{"x":200,"y":0}] = 200 px to the right.'),
  speed: z.number().positive().default(80).describe('px/s.'),
  loop: z.boolean().default(false).describe('false: back and forth along the path; true: from the last point straight back to the start.'),
  waitMs: z.number().min(0).default(0).describe('Pause at each waypoint.'),
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
  frames: z
    .array(z.union([z.number().int().min(0), z.string().min(1)]))
    .min(1)
    .describe('Frame indexes of the spritesheet, or image asset ids (one image per frame), e.g. [0, 1, 2] or ["cat_1", "cat_2"].'),
  fps: z.number().positive().default(8),
  loop: z.boolean().default(true).describe('false: plays once, holds the last frame and emits "anim_end".'),
  asset: z.string().optional().describe('Spritesheet for this clip (default: the Sprite asset).'),
  next: z.string().optional().describe('Clip to play after a non-looping clip ends.'),
  events: z
    .record(z.string().regex(/^\d+$/, 'must be a frame index'), z.string().min(1))
    .optional()
    .describe('Frame index -> event type emitted when the frame shows, e.g. {"2": "footstep"} (map it to a sound in config.sounds).'),
});

export const AnimatorSchema = z.strictObject({
  animations: z.record(z.string(), AnimationClipSchema).default(() => ({})),
  initial: z.string().default('idle'),
  auto: z.boolean().default(true).describe('Pick idle/run/jump/fall from the body state automatically.'),
  states: z
    .record(z.string(), z.string())
    .optional()
    .describe('StateMachine state -> clip. Without an entry, a clip with the state name is used if it exists.'),
  speed: z.number().min(0).default(1).describe('Playback speed multiplier (0 = paused).'),
});

export const InteractableSchema = z.strictObject({
  action: z.string().min(1).default('use').describe('Verb reported in the "interact" event, e.g. "open", "talk", "feed", "pickup".'),
  label: z.string().optional().describe('Prompt for the player, e.g. "Open". Shown above the entity ("[E] Open") when a key interaction is in range.'),
  via: z
    .array(z.enum(['click', 'key', 'enter']))
    .default(() => ['click' as const, 'key' as const])
    .describe('click: left click on the entity. key: an actor in range presses `key`. enter: fires when an actor comes within range. Scripts can always call game.interact().'),
  key: z.string().default('interact').describe('Input action (config.actions) or key name for "key".'),
  actorTags: tagList(['player']).describe('Entities that can interact by key, by entering, or as the actor of game.interact().'),
  range: z.number().min(0).default(32).describe("Max gap in px between the actor's box and this entity's box (0 = touching). Not checked for clicks."),
  condition: z.string().min(1).optional().describe('Expression that must be true, e.g. "vars.keys >= 1". Otherwise the attempt is blocked.'),
  cooldownMs: z.number().min(0).default(0).describe('Time after a successful interaction before the next one.'),
  once: z.boolean().default(false).describe('Disable after the first successful interaction.'),
  enabled: z.boolean().default(true).describe('false: ignored by clicks, keys and entering (scripts and rules can toggle it).'),
  sound: z.string().optional().describe('Audio asset played on a successful interaction.'),
});

export const StateTransitionSchema = z.strictObject({
  to: z.string().min(1).describe('State to go to.'),
  when: z.string().min(1).optional().describe(`Expression that must be true, e.g. "distance(self, 'player') < 120" or "self.health <= 0".`),
  after: z.number().min(0).optional().describe('Minimum time in the current state, in ms.'),
  event: z.string().min(1).optional().describe('A game event of this type happened this frame (e.g. "interact", "damage").'),
  match: z
    .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
    .optional()
    .describe(`Event fields that must match; "$self" stands for this entity's id, e.g. {"entity": "$self"}.`),
});

export const StateSchema = z.strictObject({
  enter: z.array(RuleActionSchema).default(() => []).describe('Actions run when entering the state (same actions as rules; target "$self" = this entity).'),
  exit: z.array(RuleActionSchema).default(() => []).describe('Actions run when leaving the state.'),
  transitions: z.array(StateTransitionSchema).default(() => []).describe('Checked in order every frame; the first whose conditions all hold is taken.'),
});

export const StateMachineSchema = z.strictObject({
  initial: z.string().min(1).describe('State entered when the entity starts.'),
  states: z
    .record(z.string(), StateSchema)
    .refine((s) => Object.keys(s).length > 0, 'needs at least one state')
    .describe('State name -> { enter, exit, transitions }.'),
  transitions: z.array(StateTransitionSchema).default(() => []).describe(`Transitions from any state, checked before the current state's (e.g. to "dead").`),
});

export const UtilityOptionSchema = z.strictObject({
  score: z
    .union([z.number(), z.string().min(1)])
    .describe(`Utility: a number or an expression, e.g. "1 - self.props.hunger / 100" or "clamp(200 - distance(self, 'player'), 0, 200) / 200". <= 0 = not chosen.`),
  when: z.string().min(1).optional().describe('Expression that must be true for the option to be considered.'),
  cooldownMs: z.number().min(0).default(0).describe('After the option stops being the choice, it waits this long before it can be chosen again.'),
  state: z.string().min(1).optional().describe('StateMachine state entered when chosen (default: a state with the option name, if any).'),
});

export const UtilityAISchema = z.strictObject({
  options: z
    .record(z.string(), UtilityOptionSchema)
    .refine((o) => Object.keys(o).length > 0, 'needs at least one option')
    .describe('Option name -> { score, when?, cooldownMs, state? }. Ties go to the first option.'),
  select: z.enum(['best', 'weighted']).default('best').describe('best: highest score. weighted: random in proportion to the scores (seeded).'),
  intervalMs: z.number().min(0).default(500).describe('Time between decisions. 0 = only when a script calls self.ai.decide().'),
  decideWhen: z.string().min(1).optional().describe(`Only decide while this expression is true, e.g. "self.state == 'idle'".`),
  inertia: z.number().min(0).default(0.1).describe("Added to the current choice's score (best) so close scores do not flip-flop."),
  noise: z.number().min(0).default(0).describe('Random amount in [0, noise) added to each score (seeded; varied but reproducible).'),
});

/** Script file path: scripts/<name>.js (subfolders allowed). */
export const SCRIPT_PATH = /^scripts\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.js$/;

export const ScriptSchema = z.strictObject({
  src: z
    .string()
    .regex(SCRIPT_PATH, 'must be a .js file in scripts/, e.g. "scripts/spinner.js"')
    .describe('Script file (project-relative), e.g. "scripts/spinner.js".'),
  props: z
    .record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
    .default(() => ({}))
    .describe('Per-entity values the script reads as self.props (e.g. speed).'),
});

/** Registry of all built-in components. Add new component types here. */
export const ComponentSchemas = {
  Sprite: SpriteSchema,
  Body: BodySchema,
  Collider: ColliderSchema,
  PlatformerController: PlatformerControllerSchema,
  Patrol: PatrolSchema,
  Mover: MoverSchema,
  FollowTarget: FollowTargetSchema,
  Health: HealthSchema,
  Damage: DamageSchema,
  Stompable: StompableSchema,
  Collectible: CollectibleSchema,
  Goal: GoalSchema,
  Checkpoint: CheckpointSchema,
  Text: TextSchema,
  Animator: AnimatorSchema,
  Interactable: InteractableSchema,
  StateMachine: StateMachineSchema,
  UtilityAI: UtilityAISchema,
  Script: ScriptSchema,
} as const;

export type ComponentType = keyof typeof ComponentSchemas;

/** One-line summaries shown to the agent when listing component types. */
export const COMPONENT_DOCS: Record<ComponentType, string> = {
  Sprite: 'Drawing: an asset frame or a colored shape (rect/circle/triangle), layer, flip, opacity.',
  Body: 'Physics body: dynamic (gravity + collisions), static, or kinematic (moves by velocity).',
  Collider: 'Axis-aligned box; isTrigger detects without blocking; oneWay = jump-through platform.',
  PlatformerController: 'Walk and jump from input actions; acceleration, coyote time, jump buffer, double jump.',
  Patrol: 'Walks back and forth; turns at walls, ledges and a distance limit.',
  Mover: 'Moves along waypoints (moving platforms, elevators); with a kinematic Body it carries what stands on it.',
  FollowTarget: 'Chases an entity (by id or nearest with a tag) within a range; horizontal or flying.',
  Health: 'Hit points, invulnerability after damage, and what happens on death (destroy/lose/respawn).',
  Damage: 'Hurts entities with target tags on contact, with knockback.',
  Stompable: 'Dies or takes damage when jumped on from above; bounces the stomper.',
  Collectible: 'Picked up on contact: adds to a variable (e.g. coins), score, optional healing.',
  Goal: 'Win or load another scene on contact; can require minimum variable values.',
  Checkpoint: 'Sets the respawn point of the entity that touches it.',
  Text: 'Text/HUD with {var} and {entity.health} placeholders; screen or world space.',
  Animator: 'Animation clips (spritesheet frames or images); picks the clip from the StateMachine state or idle/run/jump/fall; frame events, one-shots.',
  Interactable: 'Something actors can interact with (open, talk, feed...) by click, key in range or entering; condition, cooldown, once; emits "interact".',
  StateMachine: 'Named states (idle, chase, sleeping...) with transitions by condition, time in state or event, and enter/exit actions.',
  UtilityAI: 'Chooses what to do by scoring options (needs, distance, time, personality...) with expressions; enters the matching StateMachine state.',
  Script: 'Custom behavior in JavaScript (scripts/*.js): onStart/onUpdate/onCollision hooks with a restricted game API.',
};
export const COMPONENT_TYPES = Object.keys(ComponentSchemas) as ComponentType[];

export const ComponentsSchema = z.strictObject({
  Sprite: SpriteSchema.optional(),
  Body: BodySchema.optional(),
  Collider: ColliderSchema.optional(),
  PlatformerController: PlatformerControllerSchema.optional(),
  Patrol: PatrolSchema.optional(),
  Mover: MoverSchema.optional(),
  FollowTarget: FollowTargetSchema.optional(),
  Health: HealthSchema.optional(),
  Damage: DamageSchema.optional(),
  Stompable: StompableSchema.optional(),
  Collectible: CollectibleSchema.optional(),
  Goal: GoalSchema.optional(),
  Checkpoint: CheckpointSchema.optional(),
  Text: TextSchema.optional(),
  Animator: AnimatorSchema.optional(),
  Interactable: InteractableSchema.optional(),
  StateMachine: StateMachineSchema.optional(),
  UtilityAI: UtilityAISchema.optional(),
  Script: ScriptSchema.optional(),
});

export type Components = z.output<typeof ComponentsSchema>;
export type StateTransition = z.output<typeof StateTransitionSchema>;
export type ComponentData<T extends ComponentType> = z.output<(typeof ComponentSchemas)[T]>;
export type ComponentInput<T extends ComponentType> = z.input<(typeof ComponentSchemas)[T]>;
