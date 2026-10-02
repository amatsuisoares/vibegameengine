import type { EntityData, VarValue } from '@vibe/shared';
import { Entity } from './entity';
import type { FsmState } from './fsm';
import type { Game } from './game';
import type { RuleRunnerState } from './rules';

/**
 * Hot reload with state preservation (V0.6): serialize the running state → reload the project →
 * restore what is still compatible.
 *
 * Each value is resolved with a three-way merge between what the old files said (`authored`), what
 * the new files say and what the game has now (`live`): when the files did not change a value, the
 * live one is kept (positions, health, props, variables...); when they did, the edit wins. So an
 * edit shows up right away without throwing away the progress of the session.
 *
 * Kept: scene, frame/time, variables, camera, random sequence, every entity of the scene file
 * (position, enabled, destroyed, component values — Health.current, Body velocity, Script.props,
 * Sprite... — and StateMachine state), and spawned entities whose prefab still exists.
 * Rules keep their memory (start rules and fired "once" rules do not fire again, expressions keep
 * their edge). Not kept (rebuilt from the files): timers, tweens, particles, script-private state
 * (self.state; onStart runs again, so scripts rebuild it and their timers), AI / navigation /
 * animation progress, input. game.storage is the game's own persistence.
 */

type Raw = Record<string, unknown>;

/** The part of an entity a reload compares and restores. */
interface EntityView {
  name: string;
  tags: string[];
  enabled: boolean;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  components: Raw;
}

export interface EntityHotState {
  id: string;
  /** What the old files said about it (null = spawned while playing). */
  authored: EntityView | null;
  prefab?: string;
  live: EntityView;
  fsm?: FsmState;
}

export interface HotState {
  version: 1;
  scene: string;
  frame: number;
  time: number;
  /** Variables as the old scene file declared them, and as they are now. */
  authoredVars: Record<string, VarValue>;
  vars: Record<string, VarValue>;
  camera: { x: number; y: number; zoom: number };
  rng: number;
  /** Ids of the scene file's entities that were destroyed while playing. */
  destroyed: string[];
  entities: EntityHotState[];
  /** Which rules already fired (start, once, expression edges). */
  rules: RuleRunnerState;
  /** The old project's prefabs (to merge spawned entities). */
  prefabs: Record<string, Raw>;
}

export interface HotRestoreReport {
  scene: string;
  /** The saved scene no longer exists: the game started from the start scene. */
  sceneMissing?: string;
  /** Entities restored from the running game. */
  kept: number;
  /** Entities whose files changed: the edited values replaced the running ones. */
  edited: string[];
  /** New in the files (start as authored). */
  added: string[];
  /** Gone from the files (not restored). */
  removed: string[];
  /** Destroyed while playing: they stay destroyed. */
  destroyed: string[];
  /** Spawned entities restored, and those dropped (their prefab is gone). */
  spawned: number;
  droppedSpawned: string[];
}

const isObj = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Three-way merge: `live` where the files did not change the value (authored == next), `next`
 * where they did. Objects merge key by key; keys removed from the files are dropped, keys that only
 * the running game has (added at runtime) are kept.
 */
export function merge3(authored: unknown, next: unknown, live: unknown): unknown {
  if (deepEqual(authored, next)) return structuredClone(live);
  if (isObj(authored) && isObj(next) && isObj(live)) {
    const out: Raw = {};
    for (const k of new Set([...Object.keys(next), ...Object.keys(live)])) {
      const inA = k in authored;
      const inB = k in next;
      if (inB) out[k] = k in live ? merge3(authored[k], next[k], live[k]) : structuredClone(next[k]);
      else if (!inA) out[k] = structuredClone(live[k]);
    }
    return out;
  }
  return structuredClone(next);
}

function viewOfData(d: Pick<EntityData, 'tags' | 'enabled' | 'transform' | 'components'> & { id?: string; name?: string }): EntityView {
  return {
    name: d.name ?? d.id ?? '',
    tags: [...d.tags],
    enabled: d.enabled,
    x: d.transform.x,
    y: d.transform.y,
    rotation: d.transform.rotation,
    scaleX: d.transform.scaleX,
    scaleY: d.transform.scaleY,
    components: structuredClone(d.components) as Raw,
  };
}

function viewOfEntity(e: Entity): EntityView {
  return {
    name: e.name,
    tags: [...e.tags],
    enabled: e.enabled,
    x: e.x,
    y: e.y,
    rotation: e.rotation,
    scaleX: e.scaleX,
    scaleY: e.scaleY,
    components: structuredClone(e.components) as Raw,
  };
}

/** Plain-data snapshot of what a reload can keep (JSON-serializable). */
export function captureHotState(game: Game): HotState {
  const w = game.world;
  const sceneId = w.scene.id;
  const authoredScene = game.project.scenes[sceneId];
  const authored = new Map((authoredScene?.entities ?? []).map((d) => [d.id, d]));
  const live = new Set(w.entities.filter((e) => !e.destroyed).map((e) => e.id));
  return {
    version: 1,
    scene: sceneId,
    frame: w.frame,
    time: w.time,
    authoredVars: structuredClone(authoredScene?.vars ?? {}),
    vars: structuredClone(w.vars),
    camera: { ...w.camera },
    rng: w.rng.position,
    rules: game.rules.saveState(),
    destroyed: [...authored.keys()].filter((id) => !live.has(id)),
    entities: w.entities
      .filter((e) => !e.destroyed)
      .map((e) => {
        const a = authored.get(e.id);
        return {
          id: e.id,
          authored: a ? viewOfData(a) : null,
          ...(e.prefab && { prefab: e.prefab }),
          live: viewOfEntity(e),
          ...(e.fsm && { fsm: { ...e.fsm } }),
        };
      }),
    prefabs: structuredClone(game.project.prefabs ?? {}) as Record<string, Raw>,
  };
}

function apply(e: Entity, v: EntityView) {
  Object.assign(e, { name: v.name, tags: new Set(v.tags), enabled: v.enabled, rotation: v.rotation, scaleX: v.scaleX, scaleY: v.scaleY });
  e.x = e.prevX = v.x;
  e.y = e.prevY = v.y;
  e.components = v.components as Entity['components'];
}

function restoreFsm(e: Entity, fsm: FsmState | undefined, shift = 0) {
  const sm = e.components.StateMachine;
  if (fsm && sm && fsm.state in sm.states) e.fsm = { ...fsm, since: fsm.since < 0 ? fsm.since : fsm.since + shift };
}

/**
 * Restores a captured state into a game freshly built from the new project files (before its
 * first step). Returns what was kept, edited, added, removed and dropped.
 */
export interface RestoreOptions {
  /**
   * Keep the game's clock going forward instead of going back to the captured frame (loading a
   * save slot): times measured in frames (state machine entry, rule start) are shifted to match.
   */
  keepTime?: { frame: number; time: number };
}

export function restoreHotState(game: Game, state: HotState, options: RestoreOptions = {}): HotRestoreReport {
  const report: HotRestoreReport = { scene: state.scene, kept: 0, edited: [], added: [], removed: [], destroyed: [], spawned: 0, droppedSpawned: [] };
  if (!game.project.scenes[state.scene]) {
    report.sceneMissing = state.scene;
    report.scene = game.world.scene.id;
    return report;
  }
  if (game.world.scene.id !== state.scene) game.loadScene(state.scene, {});
  const w = game.world;
  const shift = options.keepTime ? options.keepTime.frame - state.frame : 0;
  w.frame = options.keepTime?.frame ?? state.frame;
  w.time = options.keepTime?.time ?? state.time;
  w.rng.position = state.rng;
  Object.assign(w.camera, state.camera);
  w.cameraInitialized = true;
  game.rules.loadState({ ...state.rules, startFrame: state.rules.startFrame + shift });
  w.vars = merge3(state.authoredVars, w.scene.vars ?? {}, state.vars) as Record<string, VarValue>;
  // Variables the files define but the running game did not have yet.
  for (const [k, v] of Object.entries(w.scene.vars ?? {})) if (!(k in w.vars)) w.vars[k] = structuredClone(v);

  const saved = new Map(state.entities.map((s) => [s.id, s]));
  const nextData = new Map(w.scene.entities.map((d) => [d.id, d]));
  const destroyed = new Set(state.destroyed);
  for (const e of w.entities) {
    const s = saved.get(e.id);
    if (destroyed.has(e.id)) {
      w.destroy(e);
      report.destroyed.push(e.id);
    } else if (!s?.authored) report.added.push(e.id);
    else {
      const data = nextData.get(e.id);
      const next = data ? viewOfData(data) : viewOfEntity(e);
      apply(e, merge3(s.authored, next, s.live) as EntityView);
      restoreFsm(e, s.fsm, shift);
      report.kept++;
      if (!deepEqual(s.authored, next)) report.edited.push(e.id);
    }
  }
  w.flushDestroyed();
  for (const s of state.entities) {
    if (s.authored) {
      if (!w.get(s.id)) report.removed.push(s.id);
      continue;
    }
    // Spawned while playing: rebuilt from its prefab when the prefab still exists.
    const before = s.prefab ? state.prefabs[s.prefab] : undefined;
    const after = s.prefab ? (game.project.prefabs?.[s.prefab] as Raw | undefined) : undefined;
    if (s.prefab && !after) {
      report.droppedSpawned.push(s.id);
      continue;
    }
    if (w.get(s.id)) continue;
    let view = s.live;
    if (before && after) {
      const at = (p: Raw) => viewOfData({ ...(p as unknown as EntityData), transform: { ...(p.transform as EntityData['transform']), x: s.live.x, y: s.live.y } });
      view = merge3(at(before), at(after), s.live) as EntityView;
    }
    const e = w.add(new Entity({ id: s.id, ...(s.prefab && { prefab: s.prefab }), tags: [], enabled: true, transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 }, components: {} } as EntityData));
    apply(e, view);
    restoreFsm(e, s.fsm, shift);
    report.spawned++;
  }
  return report;
}

/** One line for the console: what the reload kept. */
export function describeHotRestore(r: HotRestoreReport): string {
  if (r.sceneMissing) return `Hot reload: scene "${r.sceneMissing}" no longer exists; started from "${r.scene}"`;
  const parts = [`state kept in "${r.scene}" (${r.kept} entities`];
  if (r.spawned) parts[0] += `, ${r.spawned} spawned`;
  parts[0] += ')';
  if (r.edited.length) parts.push(`edited: ${r.edited.join(', ')}`);
  if (r.added.length) parts.push(`new: ${r.added.join(', ')}`);
  if (r.removed.length) parts.push(`removed: ${r.removed.join(', ')}`);
  if (r.destroyed.length) parts.push(`still destroyed: ${r.destroyed.length}`);
  if (r.droppedSpawned.length) parts.push(`dropped (prefab gone): ${r.droppedSpawned.join(', ')}`);
  return `Hot reload: ${parts.join('; ')}`;
}
