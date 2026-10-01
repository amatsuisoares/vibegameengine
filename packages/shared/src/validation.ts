import type { z } from 'zod';
import { COMPONENT_TYPES } from './components';
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
    r.do.forEach((a, i) => {
      if ('target' in a && a.target !== '$by' && !ids.has(a.target)) errors.push(`${rp}.do[${i}].target: entity "${a.target}" does not exist`);
      if (a.action === 'loadScene' && project && !project.scenes[a.scene]) errors.push(`${rp}.do[${i}].scene: scene "${a.scene}" does not exist`);
      if (a.action === 'spawn' && project && !project.prefabs[a.prefab]) errors.push(`${rp}.do[${i}].prefab: prefab "${a.prefab}" does not exist`);
      if (a.action === 'spawn' && a.at && a.at !== '$by' && !ids.has(a.at)) errors.push(`${rp}.do[${i}].at: entity "${a.at}" does not exist`);
      if (a.action === 'modify' && !(COMPONENT_TYPES as string[]).includes(a.component)) {
        errors.push(`${rp}.do[${i}].component: unknown component "${a.component}"`);
      }
      if ('target' in a && a.target === '$by' && !('enter' in r.when) && !('event' in r.when)) {
        errors.push(`${rp}.do[${i}].target: "$by" only works with "enter" and "event" triggers`);
      }
    });
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
  for (const scene of Object.values(project.scenes)) {
    checkSound(scene.music, `scenes.${scene.id}.music`);
    for (const r of scene.rules) {
      r.do.forEach((a, i) => a.action === 'playSound' && checkSound(a.asset, `scenes.${scene.id}.rules(${r.id}).do[${i}].asset`));
    }
  }
  for (const [id, prefab] of Object.entries(project.prefabs)) {
    const at = `prefabs.${id}`;
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) errors.push(`${at}: invalid prefab id`);
    const c = prefab.components;
    if (c.Script && project.scripts[c.Script.src] === undefined) errors.push(`${at}.components.Script.src: script file "${c.Script.src}" does not exist`);
    if (c.Sprite?.asset && !assetIds.has(c.Sprite.asset)) errors.push(`${at}.components.Sprite.asset: asset "${c.Sprite.asset}" does not exist`);
    if (c.FollowTarget?.targetId) warnings.push(`${at}.components.FollowTarget.targetId: prefabs should target by tag (ids differ per scene)`);
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
