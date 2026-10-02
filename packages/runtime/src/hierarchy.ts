import type { Entity, Game } from '@vibe/engine';
import type { EntityData, Project } from '@vibe/shared';

/**
 * Hierarchy panel model: the project's scenes and their entities, built from the running game
 * for the current scene (live: spawned, disabled and destroyed entities show as such) and from
 * the project data for the others. Pure: no DOM, nothing in the game is changed.
 */

export type EntityKind = 'player' | 'text' | 'enemy' | 'pickup' | 'zone' | 'solid' | 'sprite' | 'logic' | 'empty';

export interface HierarchyEntity {
  id: string;
  name: string;
  tags: string[];
  prefab?: string;
  /** Component types, in schema order. */
  components: string[];
  kind: EntityKind;
  enabled: boolean;
  /** Created while the game runs (not in the scene file). */
  spawned: boolean;
  /** In the scene file but destroyed in the running game. */
  destroyed: boolean;
}

export interface HierarchyScene {
  id: string;
  name: string;
  /** The scene the game is in now (its entities are the live ones). */
  current: boolean;
  start: boolean;
  entities: HierarchyEntity[];
}

export interface Hierarchy {
  scenes: HierarchyScene[];
}

/** One word for what an entity is, from its tags and components (the panel shows it as an icon). */
export function entityKind(tags: Iterable<string>, components: Record<string, unknown>): EntityKind {
  const has = (c: string) => components[c] !== undefined;
  const tagSet = new Set(tags);
  if (has('PlatformerController') || tagSet.has('player')) return 'player';
  if (has('Text')) return 'text';
  if (has('Damage') || has('Patrol') || has('Stompable') || tagSet.has('enemy')) return 'enemy';
  if (has('Collectible')) return 'pickup';
  const collider = components.Collider as { isTrigger?: boolean } | undefined;
  if (collider?.isTrigger || has('Goal') || has('Checkpoint')) return 'zone';
  if (collider) return 'solid';
  if (has('Sprite') || has('Animator') || has('ParticleEmitter')) return 'sprite';
  if (Object.keys(components).some((c) => c !== 'Transform')) return 'logic';
  return 'empty';
}

const componentNames = (components: object) =>
  Object.entries(components)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);

function fromLive(e: Entity, inFile: boolean): HierarchyEntity {
  return {
    id: e.id,
    name: e.name,
    tags: [...e.tags],
    components: componentNames(e.components),
    kind: entityKind(e.tags, e.components),
    enabled: e.enabled,
    spawned: !inFile,
    destroyed: e.destroyed,
  };
}

function fromData(e: EntityData, destroyed = false): HierarchyEntity {
  return {
    id: e.id,
    name: e.name ?? e.id,
    tags: [...(e.tags ?? [])],
    ...(e.prefab && { prefab: e.prefab }),
    components: componentNames(e.components ?? {}),
    kind: entityKind(e.tags ?? [], (e.components ?? {}) as Record<string, unknown>),
    enabled: e.enabled ?? true,
    spawned: false,
    destroyed,
  };
}

export function buildHierarchy(game: Game, project: Project): Hierarchy {
  const current = game.world.scene.id;
  const scenes = Object.values(project.scenes).map((scene): HierarchyScene => {
    const fileEntities = scene.entities;
    let entities: HierarchyEntity[];
    if (scene.id !== current) entities = fileEntities.map((e) => fromData(e));
    else {
      // Scene-file order first (destroyed ones stay, marked), then what was spawned.
      const inFile = new Set(fileEntities.map((e) => e.id));
      const live = new Map(game.world.entities.map((e) => [e.id, e]));
      entities = fileEntities.map((d) => {
        const e = live.get(d.id);
        const node = e ? fromLive(e, true) : fromData(d, true);
        return d.prefab ? { ...node, prefab: d.prefab } : node;
      });
      for (const e of game.world.entities) if (!inFile.has(e.id) && !e.destroyed) entities.push(fromLive(e, false));
    }
    return { id: scene.id, name: scene.name ?? scene.id, current: scene.id === current, start: scene.id === project.config.startScene, entities };
  });
  // The current scene first: it is the one being looked at.
  scenes.sort((a, b) => Number(b.current) - Number(a.current));
  return { scenes };
}

/** Entities whose id, name, tags or components contain the query (case-insensitive). */
export function filterEntities(entities: HierarchyEntity[], query: string): HierarchyEntity[] {
  const q = query.trim().toLowerCase();
  if (!q) return entities;
  return entities.filter((e) => [e.id, e.name, ...e.tags, ...e.components, e.prefab ?? ''].some((s) => s.toLowerCase().includes(q)));
}

/** Cheap fingerprint: the panel only redraws when it changes. */
export function hierarchyKey(h: Hierarchy): string {
  return h.scenes
    .map((s) => `${s.id}${s.current ? '*' : ''}:${s.entities.map((e) => `${e.id}${e.enabled ? '' : '-'}${e.destroyed ? 'x' : ''}${e.spawned ? '+' : ''}`).join(',')}`)
    .join('|');
}
