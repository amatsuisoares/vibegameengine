import { isPlainObject, mergePatch } from './merge-patch';

/**
 * Prefabs: reusable entity templates in `prefabs/<id>.json` (an entity without `id`).
 * A scene entity with `"prefab": "<id>"` is the prefab merged with the entity's own fields
 * (JSON Merge Patch: objects merge, null deletes, other values replace), so a scene only
 * stores what differs, e.g. `{ "id": "enemy3", "prefab": "goomba", "transform": { "x": 900 } }`.
 * Editing the prefab changes every instance. At runtime, rules and scripts can spawn prefabs.
 */
export const PREFAB_DIR = 'prefabs';

type Raw = Record<string, unknown>;

/** The instance as seen by the engine: prefab fields overlaid with the entity's own fields. */
export function resolveInstance(entity: Raw, prefabs: Record<string, unknown>): { entity: Raw; error?: string } {
  const id = entity.prefab;
  if (id === undefined) return { entity };
  if (typeof id !== 'string') return { entity, error: 'prefab: must be a prefab id (string)' };
  const prefab = prefabs[id];
  if (!isPlainObject(prefab)) return { entity, error: `prefab: prefab "${id}" does not exist` };
  const { id: _ignored, ...template } = prefab;
  return { entity: mergePatch(template, entity) as Raw };
}

/**
 * Raw project with prefab instances expanded (before schema validation). Instances keep
 * their `prefab` field so tools can tell them apart. Returns the errors of unknown prefabs.
 */
export function expandPrefabs(raw: unknown): { raw: unknown; errors: string[] } {
  if (!isPlainObject(raw) || !isPlainObject(raw.scenes)) return { raw, errors: [] };
  const prefabs = isPlainObject(raw.prefabs) ? raw.prefabs : {};
  const errors: string[] = [];
  const scenes: Raw = {};
  for (const [key, scene] of Object.entries(raw.scenes)) {
    if (!isPlainObject(scene) || !Array.isArray(scene.entities)) {
      scenes[key] = scene;
      continue;
    }
    const entities = scene.entities.map((e) => {
      if (!isPlainObject(e)) return e;
      const r = resolveInstance(e, prefabs);
      if (r.error) errors.push(`scenes.${key}.entities(${String(e.id)}).${r.error}`);
      return r.entity;
    });
    scenes[key] = { ...scene, entities };
  }
  return { raw: { ...raw, scenes }, errors };
}
