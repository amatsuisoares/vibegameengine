import type { z } from 'zod';
import { COMPONENT_TYPES, type Components, type StateTransition } from './components';
import { TWEEN_PROPS, type RuleAction } from './rules';
import { expandPrefabs } from './prefabs';
import { ProjectSchema, SceneSchema, type Project, type Scene, type SoundRef } from './project';

export type ValidationResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/**
 * Formats zod issues as "path: message" lines. Entity array indices are annotated
 * with the entity id when available, e.g. `scenes.level1.entities[3](enemy1).components.Body.type`,
 * so that an agent can locate the problem without counting array elements.
 */
export function formatIssues(error: z.ZodError, raw?: unknown): string[] {
  return error.issues.map((issue) => `${formatPath(issue.path, raw)}: ${issue.message}`);
}

function formatPath(path: PropertyKey[], raw: unknown): string {
  if (path.length === 0) return '(root)';
  let out = '';
  let node: unknown = raw;
  for (const key of path) {
    if (typeof key === 'number') {
      out += `[${key}]`;
      node = Array.isArray(node) ? node[key] : undefined;
      const id = node && typeof node === 'object' ? (node as { id?: unknown }).id : undefined;
      if (typeof id === 'string') out += `(${id})`;
    } else {
      out += (out ? '.' : '') + String(key);
      node = node && typeof node === 'object' ? (node as Record<PropertyKey, unknown>)[key] : undefined;
    }
  }
  return out;
}

/** "$by" / "$entity": rule targets resolved from the trigger. */
const RULE_REFS = new Set(['$by', '$entity']);

/**
 * Cross references of data-driven actions (rules, states). `ids`: entities of the scene (null = unknown,
 * as in prefabs). `refProblem(ref)` says why a "$..." target is not allowed here (null = allowed).
 */
function actionErrors(
  actions: RuleAction[],
  at: string,
  ids: Set<string> | null,
  project: Project | undefined,
  refProblem: (ref: string) => string | null,
): string[] {
  const errors: string[] = [];
  actions.forEach((a, i) => {
    for (const field of ['target', 'at'] as const) {
      const ref = (a as Record<string, unknown>)[field];
      if (typeof ref !== 'string') continue;
      const problem = ref.startsWith('$') ? refProblem(ref) : null;
      if (problem) errors.push(`${at}[${i}].${field}: "${ref}" ${problem}`);
      else if (!ref.startsWith('$') && ids && !ids.has(ref)) errors.push(`${at}[${i}].${field}: entity "${ref}" does not exist`);
    }
    if (a.action === 'loadScene' && project && !project.scenes[a.scene]) errors.push(`${at}[${i}].scene: scene "${a.scene}" does not exist`);
    if (a.action === 'spawn' && project && !project.prefabs[a.prefab]) errors.push(`${at}[${i}].prefab: prefab "${a.prefab}" does not exist`);
    if (a.action === 'modify' && !(COMPONENT_TYPES as string[]).includes(a.component)) {
      errors.push(`${at}[${i}].component: unknown component "${a.component}"`);
    }
    if (a.action === 'tween') {
      const m = /^([A-Za-z]+)\.([A-Za-z]+)$/.exec(a.prop);
      if (!(TWEEN_PROPS as readonly string[]).includes(a.prop) && !(m && (COMPONENT_TYPES as string[]).includes(m[1]))) {
        errors.push(`${at}[${i}].prop: cannot tween "${a.prop}" (use ${TWEEN_PROPS.join(', ')} or "Component.field")`);
      }
    }
    if (a.action === 'after') errors.push(...actionErrors(a.do, `${at}[${i}].do`, ids, project, refProblem));
  });
  return errors;
}

/** States referenced by initial/transitions exist; actions only target "$self" or real entities. */
export function stateMachineErrors(sm: NonNullable<Components['StateMachine']>, at: string, ids: Set<string> | null, project?: Project): string[] {
  const errors: string[] = [];
  const names = Object.keys(sm.states);
  const known = (s: string) => Object.hasOwn(sm.states, s);
  if (!known(sm.initial)) errors.push(`${at}.initial: state "${sm.initial}" does not exist (states: ${names.join(', ')})`);
  const checkTransitions = (list: StateTransition[], where: string) =>
    list.forEach((t, i) => {
      if (!known(t.to)) errors.push(`${where}[${i}].to: state "${t.to}" does not exist (states: ${names.join(', ')})`);
    });
  checkTransitions(sm.transitions, `${at}.transitions`);
  const refProblem = (ref: string) => (ref === '$self' ? null : 'is not available in states (use "$self" or an entity id)');
  for (const [name, state] of Object.entries(sm.states)) {
    checkTransitions(state.transitions, `${at}.states.${name}.transitions`);
    errors.push(...actionErrors(state.enter, `${at}.states.${name}.enter`, ids, project, refProblem));
    errors.push(...actionErrors(state.exit, `${at}.states.${name}.exit`, ids, project, refProblem));
  }
  return errors;
}

/** Options that name a state need a StateMachine with that state. */
export function utilityErrors(c: Components, at: string): string[] {
  const ai = c.UtilityAI;
  if (!ai) return [];
  const errors: string[] = [];
  for (const [name, o] of Object.entries(ai.options)) {
    if (o.state === undefined) continue;
    if (!c.StateMachine) errors.push(`${at}.components.UtilityAI.options.${name}.state: the entity has no StateMachine`);
    else if (!Object.hasOwn(c.StateMachine.states, o.state)) {
      errors.push(`${at}.components.UtilityAI.options.${name}.state: state "${o.state}" does not exist (states: ${Object.keys(c.StateMachine.states).join(', ')})`);
    }
  }
  return errors;
}

/** Clip references (next, states, frame events) and assets; `project` enables the asset checks. */
export function animatorErrors(c: Components, at: string, project?: Project): string[] {
  const a = c.Animator;
  if (!a) return [];
  const errors: string[] = [];
  const p = `${at}.components.Animator`;
  const clips = Object.keys(a.animations);
  const known = (n: string) => Object.hasOwn(a.animations, n);
  const assets = project && new Map(project.config.assets.map((x) => [x.id, x.type]));
  const checkAsset = (id: string, where: string, types: string[]) => {
    if (!assets) return;
    const type = assets.get(id);
    if (!type) errors.push(`${where}: asset "${id}" does not exist`);
    else if (!types.includes(type)) errors.push(`${where}: asset "${id}" is ${type}, not ${types.join(' or ')}`);
  };
  for (const [name, clip] of Object.entries(a.animations)) {
    const cp = `${p}.animations.${name}`;
    if (clip.next !== undefined && !known(clip.next)) errors.push(`${cp}.next: animation "${clip.next}" does not exist (animations: ${clips.join(', ')})`);
    if (clip.asset !== undefined) checkAsset(clip.asset, `${cp}.asset`, ['spritesheet']);
    clip.frames.forEach((f, i) => typeof f === 'string' && checkAsset(f, `${cp}.frames[${i}]`, ['image', 'spritesheet']));
    for (const index of Object.keys(clip.events ?? {})) {
      if (Number(index) >= clip.frames.length) errors.push(`${cp}.events.${index}: the clip has ${clip.frames.length} frames (0-${clip.frames.length - 1})`);
    }
  }
  for (const [state, clip] of Object.entries(a.states ?? {})) {
    if (!known(clip)) errors.push(`${p}.states.${state}: animation "${clip}" does not exist (animations: ${clips.join(', ')})`);
    if (c.StateMachine && !Object.hasOwn(c.StateMachine.states, state)) {
      errors.push(`${p}.states.${state}: the StateMachine has no state "${state}" (states: ${Object.keys(c.StateMachine.states).join(', ')})`);
    }
  }
  return errors;
}

/** Actions with their paths, including the ones delayed by "after". */
function flatActions(actions: RuleAction[], at: string): [string, RuleAction][] {
  return actions.flatMap((a, i): [string, RuleAction][] => [[`${at}[${i}]`, a], ...(a.action === 'after' ? flatActions(a.do, `${at}[${i}].do`) : [])]);
}

/** Every action list of a StateMachine (for checks that apply to all actions, e.g. sounds). */
export function stateActions(sm: NonNullable<Components['StateMachine']> | undefined): [string, RuleAction[]][] {
  if (!sm) return [];
  return Object.entries(sm.states).flatMap(([name, s]) => [[`states.${name}.enter`, s.enter], [`states.${name}.exit`, s.exit]] as [string, RuleAction[]][]);
}

function interactableWarnings(c: NonNullable<Components['Interactable']>, project: Project, at: string): string[] {
  // Lowercase multi-letter names are action names; one missing from config.actions never fires.
  if (c.via.includes('key') && !project.config.actions[c.key] && c.key.length > 1 && c.key === c.key.toLowerCase()) {
    return [`${at}.components.Interactable.key: "${c.key}" is not an input action in config.actions (add e.g. {"${c.key}": ["E"]})`];
  }
  return [];
}

/** Semantic checks that a schema cannot express (cross references, uniqueness). */
export function checkScene(scene: Scene, project?: Project): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const at = `scenes.${scene.id}`;
  const ids = new Set<string>();

  for (const e of scene.entities) {
    if (ids.has(e.id)) errors.push(`${at}: duplicate entity id "${e.id}"`);
    ids.add(e.id);
  }
  if (scene.camera.follow && !ids.has(scene.camera.follow)) {
    errors.push(`${at}.camera.follow: entity "${scene.camera.follow}" does not exist`);
  }

  const ruleIds = new Set<string>();
  for (const r of scene.rules) {
    const rp = `${at}.rules(${r.id})`;
    if (ruleIds.has(r.id)) errors.push(`${at}.rules: duplicate rule id "${r.id}"`);
    ruleIds.add(r.id);
    if ('enter' in r.when && !ids.has(r.when.enter)) errors.push(`${rp}.when.enter: entity "${r.when.enter}" does not exist`);
    const fromTrigger = 'enter' in r.when || 'event' in r.when;
    errors.push(
      ...actionErrors(r.do, `${rp}.do`, ids, project, (ref) =>
        RULE_REFS.has(ref) && fromTrigger ? null : RULE_REFS.has(ref) ? 'only works with "enter" and "event" triggers' : 'is not a rule target'),
    );
  }

  const assetIds = new Set(project?.config.assets.map((a) => a.id) ?? []);
  for (const e of scene.entities) {
    const c = e.components;
    const ep = `${at}.entities(${e.id})`;
    if (c.FollowTarget?.targetId && !ids.has(c.FollowTarget.targetId)) {
      errors.push(`${ep}.components.FollowTarget.targetId: entity "${c.FollowTarget.targetId}" does not exist`);
    }
    if (c.Goal?.action === 'loadScene') {
      if (!c.Goal.scene) errors.push(`${ep}.components.Goal.scene: required when action is "loadScene"`);
      else if (project && !project.scenes[c.Goal.scene]) {
        errors.push(`${ep}.components.Goal.scene: scene "${c.Goal.scene}" does not exist`);
      }
    }
    if (project && c.Sprite?.asset && !assetIds.has(c.Sprite.asset)) {
      errors.push(`${ep}.components.Sprite.asset: asset "${c.Sprite.asset}" does not exist`);
    }
    if (project && c.AudioSource) {
      const clip = project.config.assets.find((a) => a.id === c.AudioSource!.clip);
      if (!clip) errors.push(`${ep}.components.AudioSource.clip: audio asset "${c.AudioSource.clip}" does not exist`);
      else if (clip.type !== 'audio') errors.push(`${ep}.components.AudioSource.clip: asset "${clip.id}" is ${clip.type}, not audio`);
    }
    if (c.Body?.type === 'dynamic' && !c.Collider) {
      warnings.push(`${ep}: dynamic Body without Collider will fall through everything`);
    }
    if (c.PlatformerController && c.Body?.type !== 'dynamic') {
      warnings.push(`${ep}: PlatformerController needs a dynamic Body`);
    }
    if (c.Animator && !c.Sprite) warnings.push(`${ep}: Animator has no Sprite to animate`);
    if (c.Mover && c.Body && c.Body.type !== 'kinematic') warnings.push(`${ep}: Mover needs a kinematic Body (or no Body) to follow its path`);
    if (project && c.Script && project.scripts[c.Script.src] === undefined) {
      errors.push(`${ep}.components.Script.src: script file "${c.Script.src}" does not exist`);
    }
    if (project && c.Interactable) warnings.push(...interactableWarnings(c.Interactable, project, ep));
    if (c.StateMachine) errors.push(...stateMachineErrors(c.StateMachine, `${ep}.components.StateMachine`, ids, project));
    errors.push(...utilityErrors(c, ep));
    errors.push(...animatorErrors(c, ep, project));
    const nav = c.NavAgent?.target;
    if (typeof nav === 'string' && !ids.has(nav)) errors.push(`${ep}.components.NavAgent.target: entity "${nav}" does not exist`);
  }
  return { errors, warnings };
}

export function checkProject(project: Project): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!project.scenes[project.config.startScene]) {
    errors.push(`config.startScene: scene "${project.config.startScene}" does not exist`);
  }
  const assetIds = new Set<string>();
  for (const a of project.config.assets) {
    if (assetIds.has(a.id)) errors.push(`config.assets: duplicate asset id "${a.id}"`);
    assetIds.add(a.id);
    if (a.type === 'spritesheet' && (!a.frameWidth || !a.frameHeight)) {
      errors.push(`config.assets(${a.id}): spritesheets need frameWidth and frameHeight`);
    }
    if (a.path.startsWith('/') || a.path.split(/[\\/]/).includes('..')) {
      errors.push(`config.assets(${a.id}).path: must be relative to the assets/ folder, without ".."`);
    }
  }
  const audio = new Set(project.config.assets.filter((a) => a.type === 'audio').map((a) => a.id));
  const checkSound = (ref: SoundRef | undefined, at: string) => {
    if (ref === undefined) return;
    const id = typeof ref === 'string' ? ref : ref.asset;
    if (!audio.has(id)) errors.push(`${at}: ${assetIds.has(id) ? `asset "${id}" is not audio` : `audio asset "${id}" does not exist`}`);
  };
  for (const [event, ref] of Object.entries(project.config.sounds)) checkSound(ref, `config.sounds.${event}`);
  const checkEntitySounds = (c: Components, at: string) => {
    checkSound(c.Interactable?.sound, `${at}.components.Interactable.sound`);
    for (const [where, actions] of stateActions(c.StateMachine)) {
      for (const [path, a] of flatActions(actions, `${at}.components.StateMachine.${where}`)) if (a.action === 'playSound') checkSound(a.asset, `${path}.asset`);
    }
  };
  for (const [id, prefab] of Object.entries(project.prefabs)) checkEntitySounds(prefab.components, `prefabs.${id}`);
  for (const scene of Object.values(project.scenes)) {
    checkSound(scene.music, `scenes.${scene.id}.music`);
    for (const e of scene.entities) checkEntitySounds(e.components, `scenes.${scene.id}.entities(${e.id})`);
    for (const r of scene.rules) {
      for (const [path, a] of flatActions(r.do, `scenes.${scene.id}.rules(${r.id}).do`)) if (a.action === 'playSound') checkSound(a.asset, `${path}.asset`);
    }
  }
  for (const [id, prefab] of Object.entries(project.prefabs)) {
    const at = `prefabs.${id}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) errors.push(`${at}: invalid prefab id`);
    const c = prefab.components;
    if (c.Script && project.scripts[c.Script.src] === undefined) errors.push(`${at}.components.Script.src: script file "${c.Script.src}" does not exist`);
    if (c.Sprite?.asset && !assetIds.has(c.Sprite.asset)) errors.push(`${at}.components.Sprite.asset: asset "${c.Sprite.asset}" does not exist`);
    if (c.FollowTarget?.targetId) warnings.push(`${at}.components.FollowTarget.targetId: prefabs should target by tag (ids differ per scene)`);
    if (c.StateMachine) errors.push(...stateMachineErrors(c.StateMachine, `${at}.components.StateMachine`, null, project));
    errors.push(...utilityErrors(c, at));
    errors.push(...animatorErrors(c, at, project));
  }
  for (const [key, scene] of Object.entries(project.scenes)) {
    if (key !== scene.id) errors.push(`scenes.${key}: key does not match scene id "${scene.id}"`);
    const r = checkScene(scene, project);
    errors.push(...r.errors);
    warnings.push(...r.warnings);
  }
  return { errors, warnings };
}

export function parseProject(input: unknown): ValidationResult<Project> {
  const { raw, errors: prefabErrors } = expandPrefabs(input);
  if (prefabErrors.length) return { ok: false, errors: prefabErrors, warnings: [] };
  const parsed = ProjectSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error, raw), warnings: [] };
  const { errors, warnings } = checkProject(parsed.data);
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, value: parsed.data, warnings };
}

export function parseScene(raw: unknown, project?: Project): ValidationResult<Scene> {
  const parsed = SceneSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error, raw), warnings: [] };
  const { errors, warnings } = checkScene(parsed.data, project);
  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, value: parsed.data, warnings };
}

/** Parses or throws an Error whose message lists every problem. */
export function assertProject(raw: unknown): Project {
  const r = parseProject(raw);
  if (!r.ok) throw new Error(`Invalid project:\n${r.errors.join('\n')}`);
  return r.value;
}
