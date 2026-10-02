import { z } from 'zod';
import { COMPONENT_DOCS, COMPONENT_TYPES, ComponentSchemas, resolveInstance, TransformSchema, type ComponentType } from '@vibe/shared';
import { isPlainObject } from './merge-patch';
import { ToolError, type ProjectStore } from './project-store';
import { createEditingTools, gameObjectOf } from './tools';

/**
 * Inspector (V0.5): describes one entity as editable fields — built from the JSON Schema of its
 * components and its effective data (prefab + defaults) — and applies the user's edits through
 * the same editing tools the agent uses, so every change is validated by the ProjectStore,
 * written atomically, recorded in the history (author "user") and undoable.
 */

export type FieldKind = 'number' | 'integer' | 'boolean' | 'string' | 'color' | 'enum' | 'asset' | 'flags' | 'list' | 'json';

export interface InspectorField {
  key: string;
  kind: FieldKind;
  /** Effective value (what the game uses). */
  value: unknown;
  default?: unknown;
  description?: string;
  min?: number;
  max?: number;
  /** Choices for enum / asset / flags. */
  options?: string[];
  /** Stored in the scene file (not a default / prefab value): it can be reset. */
  set: boolean;
  /** Comes from the entity's prefab. */
  fromPrefab: boolean;
}

export type SectionId = 'entity' | 'transform' | ComponentType;

export interface InspectorSection {
  id: SectionId;
  title: string;
  description?: string;
  fields: InspectorField[];
  /** A component whose data comes only from the prefab (removing it from the instance is not possible). */
  fromPrefab?: boolean;
}

export interface Inspection {
  scene: string;
  id: string;
  prefab?: string;
  /** Invalid entity data: the fields show the raw values and edits may still fix it. */
  invalid?: boolean;
  sections: InspectorSection[];
  /** Component types the entity does not have (for "add component"). */
  addable: ComponentType[];
}

type Raw = Record<string, unknown>;
type JsonSchema = {
  type?: string;
  enum?: unknown[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
};

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const schemaCache = new Map<string, JsonSchema>();

function jsonSchemaOf(id: string, schema: z.ZodType): JsonSchema {
  let s = schemaCache.get(id);
  if (!s) schemaCache.set(id, (s = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema));
  return s;
}

const obj = (v: unknown): Raw => (isPlainObject(v) ? (v as Raw) : {});

function fieldKind(key: string, p: JsonSchema): Pick<InspectorField, 'kind' | 'options'> {
  if (p.enum) return { kind: 'enum', options: p.enum.map(String) };
  if (p.type === 'boolean') return { kind: 'boolean' };
  if (p.type === 'integer') return { kind: 'integer' };
  if (p.type === 'number') return { kind: 'number' };
  if (p.type === 'string') {
    if (key === 'asset' || /Asset$/.test(key)) return { kind: 'asset' };
    if (/colou?r$/i.test(key)) return { kind: 'color' };
    return { kind: 'string' };
  }
  if (p.type === 'array' && p.items?.enum) return { kind: 'flags', options: p.items.enum.map(String) };
  if (p.type === 'array' && p.items?.type === 'string') return { kind: 'list' };
  return { kind: 'json' };
}

function fieldsOf(schema: JsonSchema, effective: Raw, stored: Raw, prefab: Raw, assets: string[]): InspectorField[] {
  return Object.entries(schema.properties ?? {}).map(([key, p]) => {
    const { kind, options } = fieldKind(key, p);
    const min = p.minimum ?? p.exclusiveMinimum;
    const max = p.maximum ?? p.exclusiveMaximum;
    return {
      key,
      kind,
      value: effective[key] ?? p.default,
      ...(p.default !== undefined && { default: p.default }),
      ...(p.description && { description: p.description }),
      ...(min !== undefined && Math.abs(min) < MAX_SAFE && { min }),
      ...(max !== undefined && Math.abs(max) < MAX_SAFE && { max }),
      ...(kind === 'asset' ? { options: assets } : options && { options }),
      set: key in stored,
      fromPrefab: !(key in stored) && key in prefab,
    };
  });
}

export function inspectEntity(store: ProjectStore, scene: string, id: string): Inspection {
  const { raw, effective } = gameObjectOf(store, scene, id) as { raw: Raw; effective: Raw | null };
  const snap = store.snapshot();
  const prefabId = typeof raw.prefab === 'string' ? raw.prefab : undefined;
  const prefabData = prefabId ? obj(snap.prefabs.find((p) => p.id === prefabId)?.data) : {};
  // Invalid data: show what is stored (resolved with the prefab), so the user can fix it.
  const data = effective ?? obj(resolveInstance(raw, Object.fromEntries(snap.prefabs.map((p) => [p.id, p.data]))).entity);
  const assets = Array.isArray(obj(snap.config).assets) ? (obj(snap.config).assets as Raw[]).map((a) => String(a.id)) : [];

  const entityFields: InspectorField[] = [
    { key: 'name', kind: 'string', value: data.name ?? id, set: 'name' in raw, fromPrefab: !('name' in raw) && 'name' in prefabData },
    { key: 'tags', kind: 'list', value: data.tags ?? [], set: 'tags' in raw, fromPrefab: !('tags' in raw) && 'tags' in prefabData },
    { key: 'enabled', kind: 'boolean', value: data.enabled ?? true, default: true, set: 'enabled' in raw, fromPrefab: !('enabled' in raw) && 'enabled' in prefabData },
  ];
  const sections: InspectorSection[] = [
    { id: 'entity', title: 'Entidade', fields: entityFields },
    {
      id: 'transform',
      title: 'Transform',
      fields: fieldsOf(jsonSchemaOf('Transform', TransformSchema), obj(data.transform), obj(raw.transform), obj(prefabData.transform), assets),
    },
  ];
  const comps = obj(data.components);
  const storedComps = obj(raw.components);
  const prefabComps = obj(prefabData.components);
  for (const type of COMPONENT_TYPES) {
    if (comps[type] === undefined) continue;
    sections.push({
      id: type,
      title: type,
      description: COMPONENT_DOCS[type],
      fields: fieldsOf(jsonSchemaOf(type, ComponentSchemas[type]), obj(comps[type]), obj(storedComps[type]), obj(prefabComps[type]), assets),
      ...(!(type in storedComps) && type in prefabComps && { fromPrefab: true }),
    });
  }
  return {
    scene,
    id,
    ...(prefabId && { prefab: prefabId }),
    ...(!effective && { invalid: true }),
    sections,
    addable: COMPONENT_TYPES.filter((t) => comps[t] === undefined),
  };
}

export const InspectorEditSchema = z.discriminatedUnion('action', [
  /** value null = back to the default (or the prefab's value). */
  z.object({ action: z.literal('set'), section: z.string(), key: z.string().min(1), value: z.unknown() }),
  z.object({ action: z.literal('addComponent'), type: z.enum(COMPONENT_TYPES as [ComponentType, ...ComponentType[]]) }),
  z.object({ action: z.literal('removeComponent'), type: z.enum(COMPONENT_TYPES as [ComponentType, ...ComponentType[]]) }),
  /** Viewport drag: moves the stored position by (dx, dy) world px (one history entry for x and y). */
  z.object({ action: z.literal('move'), dx: z.number().finite(), dy: z.number().finite() }),
]);
export type InspectorEdit = z.output<typeof InspectorEditSchema>;

/**
 * A merge patch that turns `before` into `after` (a plain merge patch would merge objects:
 * keys missing from `after` are set to null so they are removed).
 */
export function replacePatch(before: unknown, after: unknown): unknown {
  if (!isPlainObject(before) || !isPlainObject(after)) return after;
  const out: Raw = {};
  for (const k of Object.keys(before as Raw)) if (!(k in (after as Raw))) out[k] = null;
  for (const [k, v] of Object.entries(after as Raw)) out[k] = replacePatch((before as Raw)[k], v);
  return out;
}

/**
 * The merge patch (for modify_game_object) that applies an inspector edit. `stored` is the
 * entity as in the scene file, so an object value replaces the stored one instead of merging.
 */
export function inspectorPatch(edit: InspectorEdit, stored: Raw = {}, effective: Raw = stored): Raw {
  if (edit.action === 'move') {
    const t = obj(effective.transform);
    const at = (v: unknown, d: number) => Math.round(((typeof v === 'number' ? v : 0) + d) * 100) / 100;
    return { transform: { x: at(t.x, edit.dx), y: at(t.y, edit.dy) } };
  }
  if (edit.action === 'addComponent') return { components: { [edit.type]: {} } };
  if (edit.action === 'removeComponent') return { components: { [edit.type]: null } };
  const value = edit.value === undefined ? null : edit.value;
  if (edit.section === 'entity') {
    if (!['name', 'tags', 'enabled'].includes(edit.key)) throw new ToolError(`Unknown entity field "${edit.key}"`);
    return { [edit.key]: value };
  }
  if (edit.section === 'transform') return { transform: { [edit.key]: value } };
  if (!(COMPONENT_TYPES as string[]).includes(edit.section)) throw new ToolError(`Unknown section "${edit.section}"`);
  const before = obj(obj(stored.components)[edit.section])[edit.key];
  return { components: { [edit.section]: { [edit.key]: replacePatch(before, value) } } };
}

function describeEdit(id: string, edit: InspectorEdit, patch: Raw): string {
  if (edit.action === 'move') {
    const t = obj(patch.transform);
    return `Viewport: move ${id} by (${edit.dx}, ${edit.dy}) to (${t.x}, ${t.y})`;
  }
  if (edit.action === 'addComponent') return `Inspector: add ${edit.type} to ${id}`;
  if (edit.action === 'removeComponent') return `Inspector: remove ${edit.type} from ${id}`;
  const what = edit.section === 'entity' ? edit.key : `${edit.section}.${edit.key}`;
  return edit.value === null ? `Inspector: reset ${what} of ${id}` : `Inspector: ${what} of ${id} = ${JSON.stringify(edit.value).slice(0, 60)}`;
}

export type InspectorEditResult =
  | { ok: true; changed: boolean; inspection: Inspection }
  | { ok: false; error: string; details?: string[]; inspection?: Inspection };

/** Applies an edit made in the inspector, as the user, through modify_game_object. */
export async function applyInspectorEdit(store: ProjectStore, scene: string, id: string, edit: InspectorEdit): Promise<InspectorEditResult> {
  let raw: Raw;
  let patch: Raw;
  try {
    const found = gameObjectOf(store, scene, id) as { raw: unknown; effective: unknown };
    raw = obj(found.raw);
    patch = inspectorPatch(edit, raw, obj(found.effective ?? found.raw));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Removing a component that only the prefab has would be a no-op: say so instead.
  if (edit.action === 'removeComponent') {
    if (!(edit.type in obj(raw.components)) && typeof raw.prefab === 'string') {
      return { ok: false, error: `${edit.type} comes from the prefab "${raw.prefab}": change the prefab to remove it.` };
    }
  }
  const r = await createEditingTools().call('modify_game_object', { scene, id, patch, reason: describeEdit(id, edit, patch) }, { store, author: 'user' });
  const inspection = safeInspect(store, scene, id);
  if (!r.ok) return { ok: false, error: r.error, ...(r.details && { details: r.details }), ...(inspection && { inspection }) };
  return { ok: true, changed: (r.result as { changed?: boolean }).changed ?? true, inspection: inspection! };
}

function safeInspect(store: ProjectStore, scene: string, id: string): Inspection | undefined {
  try {
    return inspectEntity(store, scene, id);
  } catch {
    return undefined;
  }
}

export type PlacePrefabResult = { ok: true; id: string } | { ok: false; error: string; details?: string[] };

/**
 * Asset browser: puts an instance of a prefab in a scene at (x, y), as the user, with the first
 * free id "<prefab>N" (create_game_object: validated, recorded in the history, undoable).
 */
export async function placePrefab(store: ProjectStore, scene: string, prefab: string, x: number, y: number): Promise<PlacePrefabResult> {
  let taken: Set<string>;
  try {
    const raw = store.rawProject();
    if (!raw.prefabs[prefab]) return { ok: false, error: `Prefab "${prefab}" does not exist` };
    const data = raw.scenes[scene];
    if (!data) return { ok: false, error: `Scene "${scene}" does not exist` };
    const list = Array.isArray(obj(data).entities) ? (obj(data).entities as unknown[]) : [];
    taken = new Set(list.map((e) => String(obj(e).id)));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let n = 1;
  while (taken.has(`${prefab}${n}`)) n++;
  const id = `${prefab}${n}`;
  const at = (v: number) => Math.round(v);
  const r = await createEditingTools().call(
    'create_game_object',
    { scene, entity: { id, prefab, transform: { x: at(x), y: at(y) } }, reason: `Asset browser: place prefab ${prefab} as ${id} at (${at(x)}, ${at(y)})` },
    { store, author: 'user' },
  );
  return r.ok ? { ok: true, id } : { ok: false, error: r.error, ...(r.details && { details: r.details }) };
}
