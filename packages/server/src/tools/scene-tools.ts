import { z } from 'zod';
import { COMPONENT_DOCS, COMPONENT_TYPES, ComponentSchemas, EntitySchema, IdSchema, resolveInstance, type ComponentType } from '@vibe/shared';
import { isPlainObject, mergePatch } from '../merge-patch';
import { ToolError, type CommitResult, type ProjectStore, type Transaction } from '../project-store';
import { openMemoryItems } from './memory-tools';
import { defineTool } from './registry';

type Raw = Record<string, unknown>;

const SceneId = z.string().describe('Scene id.');
const EntityId = z.string().describe('Entity id (unique within the scene).');
const Patch = z
  .record(z.string(), z.unknown())
  .describe('JSON Merge Patch: nested objects are merged, null deletes a key, arrays and other values replace.');
const ComponentType = z.enum(COMPONENT_TYPES as [ComponentType, ...ComponentType[]]);

/** Commit info returned by every mutating tool. */
export function changeInfo(r: CommitResult) {
  if (r.seq === null) return { changed: false };
  return {
    changed: true,
    historySeq: r.seq,
    diff: r.files.map((f) => f.diff).join('\n'),
    ...(r.warnings.length && { warnings: r.warnings }),
    ...(r.remainingErrors.length && { preExistingErrors: r.remainingErrors }),
  };
}

function entitiesOf(scene: Raw): Raw[] {
  if (scene.entities === undefined) scene.entities = [];
  if (!Array.isArray(scene.entities)) throw new ToolError('Scene "entities" is not an array');
  return scene.entities as Raw[];
}

function entityIndex(scene: Raw, sceneId: string, id: string): number {
  const list = entitiesOf(scene);
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) {
    const ids = list.map((e) => String(e.id));
    const close = ids.filter((x) => x.toLowerCase().includes(id.toLowerCase()) || id.toLowerCase().includes(x.toLowerCase()));
    throw new ToolError(
      `Entity "${id}" does not exist in scene "${sceneId}".` + (close.length ? ` Did you mean: ${close.join(', ')}?` : ''),
      [`Entities: ${ids.join(', ') || '(none)'}`],
    );
  }
  return i;
}

/** Short one-line view of an entity for listings. */
export function entitySummary(e: Raw) {
  const t = (isPlainObject(e.transform) ? e.transform : {}) as Raw;
  return {
    id: e.id,
    ...(e.name !== undefined && { name: e.name }),
    tags: e.tags ?? [],
    x: t.x ?? 0,
    y: t.y ?? 0,
    components: Object.keys(isPlainObject(e.components) ? e.components : {}),
    ...(e.prefab !== undefined && { prefab: e.prefab }),
    ...(e.enabled === false && { enabled: false }),
  };
}

/** Edits one scene's raw JSON inside a transaction. */
export function editScene<T>(ctx: { store: ProjectStore }, meta: Parameters<ProjectStore['edit']>[0], sceneId: string, fn: (scene: Raw, tx: Transaction) => T) {
  let out!: T;
  const r = ctx.store.edit(meta, (tx) => {
    const scene = tx.scene(sceneId);
    out = fn(scene, tx);
    tx.setScene(sceneId, scene);
  });
  return { out, change: changeInfo(r) };
}

function rejectKeys(patch: Raw, keys: string[], hint: string) {
  const bad = keys.filter((k) => k in patch);
  if (bad.length) throw new ToolError(`patch cannot change ${bad.join(', ')}: ${hint}`);
}

export const sceneTools = [
  defineTool({
    name: 'get_project_summary',
    description:
      'Overview of the project: config, scenes with their entities (id, tags, position, component types), prefabs, scripts, assets, validation status, recent history and open memory items (todos, issues, unfinished features). Call this first.',
    input: z.object({}),
    run: ({ store }) => {
      const snap = store.snapshot();
      const status = store.validate(snap);
      const config = (snap.config ?? {}) as Raw;
      const { done, undone } = store.history.stacks();
      return {
        name: store.name,
        config: { ...config },
        valid: status.ok,
        ...(status.errors.length && { errors: status.errors }),
        ...(status.warnings.length && { warnings: status.warnings }),
        scenes: snap.scenes.map((s) => {
          const scene = (s.data ?? {}) as Raw;
          const list = Array.isArray(scene.entities) ? (scene.entities as Raw[]) : [];
          return { id: s.id, file: s.file, ...(s.error && { error: s.error }), entityCount: list.length, entities: list.map(entitySummary) };
        }),
        ...(snap.prefabs.length && {
          prefabs: snap.prefabs.map((p) => ({
            id: p.id,
            ...(p.error ? { error: p.error } : { components: Object.keys(isPlainObject((p.data as Raw)?.components) ? ((p.data as Raw).components as Raw) : {}) }),
          })),
        }),
        ...(Object.keys(snap.scripts).length && { scripts: Object.keys(snap.scripts) }),
        history: {
          canUndo: done.length > 0,
          canRedo: undone.length > 0,
          recent: store.history.all().slice(-5).map((e) => ({ seq: e.seq, author: e.author, action: e.action, summary: e.summary })),
        },
        memory: openMemoryItems(store),
      };
    },
  }),

  defineTool({
    name: 'list_component_types',
    description:
      'Built-in component types. Without arguments: names and one-line descriptions. With `types`: full JSON Schema (fields, defaults, descriptions) of those types.',
    input: z.object({ types: z.array(ComponentType).optional().describe('Component types to describe in full.') }),
    run: (_ctx, { types }) =>
      types
        ? types.map((t) => ({ type: t, description: COMPONENT_DOCS[t], schema: z.toJSONSchema(ComponentSchemas[t], { io: 'input' }) }))
        : COMPONENT_TYPES.map((t) => ({ type: t, description: COMPONENT_DOCS[t] })),
  }),

  defineTool({
    name: 'modify_project_config',
    description: 'Changes project.json (name, width, height, gravity, startScene, actions, assets, sounds, pixelArt) with a merge patch. sounds maps event types to audio assets, e.g. {"sounds":{"jump":"sfx_jump","collect":"sfx_coin"}}.',
    mutates: true,
    input: z.object({ patch: Patch }),
    run: ({ store }, { patch }, meta) => {
      const r = store.edit(meta(`Modify project config (${Object.keys(patch).join(', ')})`), (tx) => {
        tx.writeJson('project.json', mergePatch(tx.readJson('project.json'), patch));
      });
      return changeInfo(r);
    },
  }),

  defineTool({
    name: 'get_scene',
    description: 'Scene settings (size, background, camera, vars, killY) and a one-line summary of each entity.',
    input: z.object({ scene: SceneId }),
    run: ({ store }, { scene }) => {
      const s = store.snapshot().scenes.find((x) => x.id === scene);
      if (!s) throw new ToolError(`Scene "${scene}" does not exist`);
      if (s.error) throw new ToolError(s.error);
      const { entities, ...settings } = s.data as Raw;
      return { file: s.file, settings, entities: (Array.isArray(entities) ? (entities as Raw[]) : []).map(entitySummary) };
    },
  }),

  defineTool({
    name: 'create_scene',
    description: 'Creates a new scene file scenes/<id>.json. Settings default to 1600x450 world, dark blue background.',
    mutates: true,
    input: z.object({
      id: IdSchema.describe('New scene id.'),
      settings: Patch.optional().describe('Scene fields other than id/entities: name, background, width, height, killY, camera, vars...'),
      entities: z.array(z.record(z.string(), z.unknown())).optional().describe('Initial entities.'),
    }),
    run: ({ store }, { id, settings = {}, entities = [] }, meta) => {
      rejectKeys(settings, ['id', 'entities'], 'use the id and entities parameters');
      const r = store.edit(meta(`Create scene ${id}`), (tx) => {
        if (tx.hasScene(id)) throw new ToolError(`Scene "${id}" already exists`);
        const file = `scenes/${id}.json`;
        if (tx.read(file) !== null) throw new ToolError(`File ${file} already exists`);
        tx.writeJson(file, { id, ...settings, entities });
      });
      return changeInfo(r);
    },
  }),

  defineTool({
    name: 'modify_scene',
    description: 'Changes scene settings (background, width, height, killY, camera, vars, fallDamage, name) with a merge patch. Entities have their own tools.',
    mutates: true,
    input: z.object({ scene: SceneId, patch: Patch }),
    run: (ctx, { scene, patch }, meta) => {
      rejectKeys(patch, ['id', 'entities'], 'use the entity tools, or create a new scene');
      return editScene(ctx, meta(`Modify scene ${scene} (${Object.keys(patch).join(', ')})`), scene, (s) => {
        const next = mergePatch(s, patch) as Raw;
        for (const k of Object.keys(s)) delete s[k];
        Object.assign(s, next);
      }).change;
    },
  }),

  defineTool({
    name: 'delete_scene',
    description: 'Deletes a scene file. Fails if other data still references the scene (startScene, Goal.scene).',
    mutates: true,
    destructive: true,
    input: z.object({ scene: SceneId }),
    run: ({ store }, { scene }, meta) =>
      changeInfo(store.edit(meta(`Delete scene ${scene}`), (tx) => tx.delete(tx.sceneFile(scene)))),
  }),

  defineTool({
    name: 'get_game_object',
    description: 'One entity: `raw` is what the scene file stores; `effective` has its prefab (if any) and every default filled in.',
    input: z.object({ scene: SceneId, id: EntityId }),
    run: ({ store }, { scene, id }) => {
      const s = store.snapshot().scenes.find((x) => x.id === scene);
      if (!s) throw new ToolError(`Scene "${scene}" does not exist`);
      if (s.error) throw new ToolError(s.error);
      const raw = entitiesOf(s.data as Raw)[entityIndex(s.data as Raw, scene, id)];
      const prefabs = Object.fromEntries(store.snapshot().prefabs.map((p) => [p.id, p.data]));
      const parsed = EntitySchema.safeParse(resolveInstance(raw, prefabs).entity);
      return { raw, effective: parsed.success ? parsed.data : null };
    },
  }),

  defineTool({
    name: 'create_game_object',
    description:
      'Adds an entity to a scene. Only fields that differ from defaults are needed, e.g. {"id":"coin4","tags":["coin"],"transform":{"x":500,"y":380},"components":{"Sprite":{"shape":"circle","color":"#ffd700","width":16,"height":16},"Collider":{"width":16,"height":16,"isTrigger":true},"Collectible":{}}}.',
    mutates: true,
    input: z.object({
      scene: SceneId,
      entity: z.looseObject({ id: IdSchema.describe('New entity id, unique in the scene.') }).describe('Entity JSON: id, name?, tags?, enabled?, transform?, components?'),
      index: z.number().int().min(0).optional().describe('Position in the entity list (default: end).'),
    }),
    run: (ctx, { scene, entity, index }, meta) =>
      editScene(ctx, meta(`Create ${entity.id} in ${scene}`), scene, (s) => {
        const list = entitiesOf(s);
        if (list.some((e) => e.id === entity.id)) throw new ToolError(`Entity "${entity.id}" already exists in scene "${scene}"`);
        list.splice(index ?? list.length, 0, entity);
      }).change,
  }),

  defineTool({
    name: 'duplicate_game_object',
    description: 'Copies an entity under a new id, optionally changing it with a merge patch (e.g. a new transform).',
    mutates: true,
    input: z.object({ scene: SceneId, id: EntityId, newId: IdSchema.describe('Id of the copy.'), patch: Patch.optional() }),
    run: (ctx, { scene, id, newId, patch = {} }, meta) => {
      rejectKeys(patch, ['id'], 'use newId');
      return editScene(ctx, meta(`Duplicate ${id} as ${newId} in ${scene}`), scene, (s) => {
        const list = entitiesOf(s);
        const i = entityIndex(s, scene, id);
        if (list.some((e) => e.id === newId)) throw new ToolError(`Entity "${newId}" already exists in scene "${scene}"`);
        list.splice(i + 1, 0, { ...(mergePatch(list[i], patch) as Raw), id: newId });
      }).change;
    },
  }),

  defineTool({
    name: 'modify_game_object',
    description:
      'Changes an entity with a merge patch: name, tags, enabled, transform, and components (e.g. {"transform":{"x":300},"components":{"Body":{"gravityScale":0.5}}}). A component set to null is removed.',
    mutates: true,
    input: z.object({ scene: SceneId, id: EntityId, patch: Patch }),
    run: (ctx, { scene, id, patch }, meta) => {
      rejectKeys(patch, ['id'], 'entity ids cannot be renamed; duplicate and delete instead');
      return editScene(ctx, meta(`Modify ${id} in ${scene} (${Object.keys(patch).join(', ')})`), scene, (s) => {
        const list = entitiesOf(s);
        const i = entityIndex(s, scene, id);
        list[i] = mergePatch(list[i], patch) as Raw;
      }).change;
    },
  }),

  defineTool({
    name: 'delete_game_object',
    description: 'Removes an entity. Fails if something still references it (camera.follow, FollowTarget.targetId).',
    mutates: true,
    destructive: true,
    input: z.object({ scene: SceneId, id: EntityId }),
    run: (ctx, { scene, id }, meta) =>
      editScene(ctx, meta(`Delete ${id} from ${scene}`), scene, (s) => {
        entitiesOf(s).splice(entityIndex(s, scene, id), 1);
      }).change,
  }),

  defineTool({
    name: 'create_component',
    description: 'Adds a component to an entity. `data` only needs the fields that differ from the defaults (see list_component_types).',
    mutates: true,
    input: z.object({ scene: SceneId, id: EntityId, type: ComponentType, data: Patch.optional().describe('Component fields.') }),
    run: (ctx, { scene, id, type, data = {} }, meta) =>
      editScene(ctx, meta(`Add ${type} to ${id} in ${scene}`), scene, (s) => {
        const e = entitiesOf(s)[entityIndex(s, scene, id)];
        const comps = (isPlainObject(e.components) ? e.components : (e.components = {})) as Raw;
        if (type in comps) throw new ToolError(`Entity "${id}" already has ${type}; use modify_component`);
        comps[type] = data;
      }).change,
  }),

  defineTool({
    name: 'modify_component',
    description: 'Changes fields of an existing component with a merge patch.',
    mutates: true,
    input: z.object({ scene: SceneId, id: EntityId, type: ComponentType, patch: Patch }),
    run: (ctx, { scene, id, type, patch }, meta) =>
      editScene(ctx, meta(`Modify ${type} of ${id} in ${scene} (${Object.keys(patch).join(', ')})`), scene, (s) => {
        const e = entitiesOf(s)[entityIndex(s, scene, id)];
        const comps = (isPlainObject(e.components) ? e.components : {}) as Raw;
        if (!(type in comps)) throw new ToolError(`Entity "${id}" has no ${type}. It has: ${Object.keys(comps).join(', ') || '(none)'}`);
        comps[type] = mergePatch(comps[type], patch);
      }).change,
  }),

  defineTool({
    name: 'remove_component',
    description: 'Removes a component from an entity.',
    mutates: true,
    input: z.object({ scene: SceneId, id: EntityId, type: ComponentType }),
    run: (ctx, { scene, id, type }, meta) =>
      editScene(ctx, meta(`Remove ${type} from ${id} in ${scene}`), scene, (s) => {
        const e = entitiesOf(s)[entityIndex(s, scene, id)];
        const comps = (isPlainObject(e.components) ? e.components : {}) as Raw;
        if (!(type in comps)) throw new ToolError(`Entity "${id}" has no ${type}`);
        delete comps[type];
      }).change,
  }),
];
