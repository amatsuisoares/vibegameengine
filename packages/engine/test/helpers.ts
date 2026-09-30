import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityInput, SceneInput } from '@vibe/shared';
import { Game } from '../src';

export const GROUND_TOP = 418;

export function ground(id: string, left: number, right: number, top = GROUND_TOP, h = 32): EntityInput {
  const width = right - left;
  return {
    id,
    tags: ['ground'],
    transform: { x: left + width / 2, y: top + h / 2 },
    components: { Sprite: { width, height: h }, Collider: { width, height: h } },
  };
}

export function player(x = 100, y = GROUND_TOP - 16, components: EntityInput['components'] = {}): EntityInput {
  return {
    id: 'player',
    tags: ['player'],
    transform: { x, y },
    components: {
      Sprite: { width: 24, height: 32 },
      Body: {},
      Collider: { width: 24, height: 32 },
      PlatformerController: {},
      Health: { max: 3, onDeath: 'lose' },
      ...components,
    },
  };
}

export function enemy(id: string, x: number, components: EntityInput['components'] = {}): EntityInput {
  return {
    id,
    tags: ['enemy'],
    transform: { x, y: GROUND_TOP - 12 },
    components: { Body: {}, Collider: { width: 28, height: 24 }, Damage: {}, ...components },
  };
}

export function trigger(id: string, x: number, y: number, components: EntityInput['components'], w = 16, h = 16): EntityInput {
  return { id, transform: { x, y }, components: { Collider: { width: w, height: h, isTrigger: true }, ...components } };
}

export function makeGame(entities: EntityInput[], scene: Partial<SceneInput> = {}, extraScenes: SceneInput[] = []) {
  const scenes: Record<string, SceneInput> = { main: { id: 'main', width: 3000, ...scene, entities } };
  for (const s of extraScenes) scenes[s.id] = s;
  return Game.fromRaw({ config: { name: 'test', startScene: 'main' }, scenes });
}

/** Reads a project folder (project.json + scenes/*.json) into the in-memory shape. */
export function readProjectDir(dir: string) {
  const config = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
  const scenes: Record<string, unknown> = {};
  for (const f of readdirSync(join(dir, 'scenes'))) {
    if (!f.endsWith('.json')) continue;
    const s = JSON.parse(readFileSync(join(dir, 'scenes', f), 'utf8'));
    scenes[s.id] = s;
  }
  return { config, scenes };
}
