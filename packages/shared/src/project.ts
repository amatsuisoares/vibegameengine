import { z } from 'zod';
import { ComponentsSchema } from './components';
import { RuleSchema } from './rules';
import { ItemSchema } from './items';

export const IdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'must start with a letter and contain only letters, digits, "_" or "-"');

export const TransformSchema = z.strictObject({
  x: z.number().default(0).describe('Center x in world pixels.'),
  y: z.number().default(0).describe('Center y in world pixels (y grows downward).'),
  rotation: z.number().default(0).describe('Visual rotation in degrees, clockwise. Does not rotate the collider.'),
  scaleX: z.number().default(1).describe('Visual scale of the sprite; negative mirrors it. Does not scale the collider.'),
  scaleY: z.number().default(1).describe('Visual scale of the sprite; negative mirrors it. Does not scale the collider.'),
});

export const EntitySchema = z.strictObject({
  id: IdSchema.describe('Unique within the scene. Used by tools and references.'),
  name: z.string().optional(),
  tags: z.array(z.string()).default(() => []).describe('Used by interactions, e.g. "player", "enemy".'),
  enabled: z.boolean().default(true),
  transform: TransformSchema.default(() => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 })),
  components: ComponentsSchema.default(() => ({})),
  prefab: IdSchema.optional().describe('Prefab this entity is an instance of: the entity only stores what differs from it.'),
});

/** A reusable entity template (prefabs/<id>.json): an entity without id. */
export const PrefabSchema = EntitySchema.omit({ id: true, prefab: true });

export const CameraSchema = z.strictObject({
  follow: z.string().optional().describe('Entity id the camera follows.'),
  x: z.number().default(0),
  y: z.number().default(0),
  zoom: z.number().positive().default(1),
  lerp: z.number().min(0).max(1).default(0.15).describe('Follow smoothing per frame; 1 = locked.'),
  clampToBounds: z.boolean().default(true),
});

export const VarValueSchema = z.union([z.number(), z.string(), z.boolean()]);

export const SceneSchema = z.strictObject({
  id: IdSchema,
  name: z.string().optional(),
  background: z.string().default('#1d2b53'),
  width: z.number().positive().default(1600).describe('World width in pixels.'),
  height: z.number().positive().default(450).describe('World height in pixels.'),
  killY: z.number().optional().describe('Entities below this y fall out of the world. Default: height + 100.'),
  fallDamage: z.number().int().min(0).default(1),
  camera: CameraSchema.default(() => ({ x: 0, y: 0, zoom: 1, lerp: 0.15, clampToBounds: true })),
  vars: z.record(z.string(), VarValueSchema).default(() => ({})).describe('Initial game variables.'),
  entities: z.array(EntitySchema).default(() => []),
  rules: z.array(RuleSchema).default(() => []).describe('Data-driven events and conditions: when -> if -> do.'),
  music: z.lazy(() => SoundRefSchema).optional().describe('Audio asset looped while this scene runs.'),
});

/** An audio asset id, or { asset, volume }. */
export const SoundRefSchema = z.union([
  z.string().min(1),
  z.strictObject({ asset: z.string().min(1), volume: z.number().min(0).max(1).default(1) }),
]);

export const AssetSchema = z.strictObject({
  id: IdSchema,
  type: z.enum(['image', 'spritesheet', 'audio']),
  path: z.string().describe('Path relative to the project assets/ folder.'),
  frameWidth: z.number().int().positive().optional().describe('Spritesheet frame width in pixels (required for spritesheets).'),
  frameHeight: z.number().int().positive().optional().describe('Spritesheet frame height in pixels (required for spritesheets).'),
});

export const DEFAULT_ACTIONS: Record<string, string[]> = {
  left: ['A', 'ArrowLeft'],
  right: ['D', 'ArrowRight'],
  up: ['W', 'ArrowUp'],
  down: ['S', 'ArrowDown'],
  jump: ['Space', 'W', 'ArrowUp'],
  interact: ['E'],
};

export const ProjectConfigSchema = z.strictObject({
  formatVersion: z.literal(1).default(1),
  name: z.string().min(1),
  width: z.number().int().positive().default(800).describe('Viewport width in pixels.'),
  height: z.number().int().positive().default(450).describe('Viewport height in pixels.'),
  pixelArt: z.boolean().default(true),
  gravity: z.number().default(1400).describe('px/s^2, positive is down.'),
  startScene: IdSchema,
  actions: z.record(z.string(), z.array(z.string())).default(() => structuredClone(DEFAULT_ACTIONS))
    .describe('Input action name -> keys. Controllers reference actions, not keys.'),
  assets: z.array(AssetSchema).default(() => []),
  sounds: z
    .record(z.string(), SoundRefSchema)
    .default(() => ({}))
    .describe('Event type -> audio asset played when that event happens, e.g. {"jump": "sfx_jump", "collect": "sfx_coin"}.'),
});

export const ProjectSchema = z.strictObject({
  config: ProjectConfigSchema,
  scenes: z.record(z.string(), SceneSchema),
  scripts: z.record(z.string(), z.string()).default(() => ({})).describe('Script sources by project-relative path (scripts/*.js).'),
  prefabs: z.record(z.string(), PrefabSchema).default(() => ({})).describe('Entity templates by id (prefabs/<id>.json).'),
  items: z.record(z.string(), ItemSchema).default(() => ({})).describe('Item catalog by id (items/<id>.json).'),
});

export type Transform = z.output<typeof TransformSchema>;
export type EntityData = z.output<typeof EntitySchema>;
export type EntityInput = z.input<typeof EntitySchema>;
export type PrefabData = z.output<typeof PrefabSchema>;
export type CameraData = z.output<typeof CameraSchema>;
export type Scene = z.output<typeof SceneSchema>;
export type SceneInput = z.input<typeof SceneSchema>;
export type Asset = z.output<typeof AssetSchema>;
export type ProjectConfig = z.output<typeof ProjectConfigSchema>;
export type Project = z.output<typeof ProjectSchema>;
export type ProjectInput = z.input<typeof ProjectSchema>;
export type VarValue = z.output<typeof VarValueSchema>;
export type SoundRef = z.output<typeof SoundRefSchema>;
