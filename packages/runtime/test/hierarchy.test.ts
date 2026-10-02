import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Game } from '@vibe/engine';
import { assertProject } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { buildHierarchy, entityKind, filterEntities, hierarchyKey, paintSelection, Runtime, SELECTION_COLOR, selectionBox } from '../src';
import { handleSelectionRequest, projectOfFile } from '../vite/project-files';
import { demoProject, fakeCanvas, recordingContext } from './helpers';

const twoScenes = () =>
  assertProject({
    config: { name: 't', startScene: 'menu', width: 400, height: 300 },
    prefabs: { coin: { tags: ['coin'], components: { Sprite: { width: 10, height: 10 }, Collectible: {} } } },
    scenes: {
      level: { id: 'level', name: 'Fase 1', entities: [{ id: 'hero', tags: ['player'], components: { PlatformerController: {}, Body: {}, Collider: {} } }] },
      menu: {
        id: 'menu',
        entities: [
          { id: 'title', components: { Text: { text: 'Oi' } } },
          { id: 'secret', enabled: false, components: { Sprite: { width: 20, height: 20 } } },
          { id: 'coinA', prefab: 'coin', transform: { x: 50, y: 50 } },
          { id: 'brain', components: { Health: {} } },
        ],
      },
    },
  });

describe('hierarchy model', () => {
  it('lists every scene, the current one first and live, the others from the project data', () => {
    const project = twoScenes();
    const game = new Game(project);
    const h = buildHierarchy(game, project);
    expect(h.scenes.map((s) => [s.id, s.current, s.start])).toEqual([
      ['menu', true, true],
      ['level', false, false],
    ]);
    const menu = h.scenes[0];
    expect(menu.entities.map((e) => [e.id, e.kind, e.enabled])).toEqual([
      ['title', 'text', true],
      ['secret', 'sprite', false],
      ['coinA', 'pickup', true],
      ['brain', 'logic', true],
    ]);
    expect(menu.entities[2]).toMatchObject({ prefab: 'coin', tags: ['coin'], components: ['Sprite', 'Collectible'] });
    expect(h.scenes[1]).toMatchObject({ name: 'Fase 1', entities: [{ id: 'hero', kind: 'player', spawned: false }] });
  });

  it('shows what changed while the game runs: spawned, destroyed and disabled entities', () => {
    const project = twoScenes();
    const game = new Game(project);
    const before = hierarchyKey(buildHierarchy(game, project));
    game.world.spawn('coin', 100, 100);
    game.world.destroy(game.world.get('title')!);
    game.world.get('secret')!.enabled = true;
    const menu = buildHierarchy(game, project).scenes[0];
    expect(menu.entities.map((e) => [e.id, e.spawned, e.destroyed, e.enabled])).toEqual([
      ['title', false, true, true],
      ['secret', false, false, true],
      ['coinA', false, false, true],
      ['brain', false, false, true],
      ['coin1', true, false, true],
    ]);
    expect(hierarchyKey(buildHierarchy(game, project))).not.toBe(before);
    // Nothing about the game changed by building the panel.
    expect(game.frame).toBe(0);
  });

  it('follows the scene the game is in', () => {
    const project = twoScenes();
    const game = new Game(project);
    game.loadScene('level');
    const h = buildHierarchy(game, project);
    expect(h.scenes[0]).toMatchObject({ id: 'level', current: true });
    expect(h.scenes[1]).toMatchObject({ id: 'menu', current: false });
  });

  it('filters by id, name, tag, component or prefab', () => {
    const project = twoScenes();
    const entities = buildHierarchy(new Game(project), project).scenes[0].entities;
    const ids = (q: string) => filterEntities(entities, q).map((e) => e.id);
    expect(ids('')).toHaveLength(4);
    expect(ids('COIN')).toEqual(['coinA']);
    expect(ids('health')).toEqual(['brain']);
    expect(ids('text')).toEqual(['title']);
    expect(ids('nada')).toEqual([]);
  });

  it('names what an entity is from its tags and components', () => {
    expect(entityKind(['player'], {})).toBe('player');
    expect(entityKind([], { Damage: {} })).toBe('enemy');
    expect(entityKind([], { Collider: { isTrigger: true } })).toBe('zone');
    expect(entityKind([], { Goal: {}, Collider: {} })).toBe('zone');
    expect(entityKind([], { Collider: {} })).toBe('solid');
    expect(entityKind([], {})).toBe('empty');
  });

  it('builds the demo project hierarchy', () => {
    const project = demoProject();
    const level = buildHierarchy(new Game(project), project).scenes[0];
    const kinds = Object.fromEntries(level.entities.map((e) => [e.id, e.kind]));
    expect(kinds).toMatchObject({ player: 'player', ground1: 'solid', coin1: 'pickup', enemy1: 'enemy', flag: 'zone', hud: 'text' });
  });
});

describe('selection outline', () => {
  it('outlines the selected entity box on screen, following the camera', () => {
    const project = demoProject();
    const game = new Game(project);
    const box = selectionBox(game.world, 'coin1')!;
    const e = game.world.get('coin1')!;
    expect(box.x).toBeCloseTo(e.aabb()!.x - game.world.camera.x);
    expect(box.w).toBeGreaterThan(0);
    expect(selectionBox(game.world, 'nobody')).toBeNull();

    const { ctx, calls } = recordingContext();
    paintSelection(ctx, game.world, 'coin1');
    expect(calls('strokeRect')).toHaveLength(1);
    expect(calls('fillText')[0][0]).toBe('coin1');
  });

  it('marks a disabled entity with a dashed outline', () => {
    const project = twoScenes();
    const game = new Game(project);
    const { ctx, calls } = recordingContext();
    paintSelection(ctx, game.world, 'secret');
    expect(calls('setLineDash')[0]).toEqual([[5, 4]]);
    expect(calls('fillText')[0][0]).toBe('secret (desativada)');
  });

  it('is drawn by the runtime over the game, without touching the simulation', () => {
    const { canvas, ops, calls } = fakeCanvas();
    const runtime = new Runtime(canvas, demoProject(), { paused: true });
    const state = JSON.stringify(runtime.game.getState());
    runtime.selected = 'player';
    runtime.render();
    expect(ops).toContainEqual({ op: 'set', prop: 'strokeStyle', value: SELECTION_COLOR });
    expect(calls('fillText').some((args) => args[0] === 'player')).toBe(true);
    expect(JSON.stringify(runtime.game.getState())).toBe(state);
  });
});

describe('selection route', () => {
  it('keeps the editor selection on disk, validated', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibe-sel-'));
    try {
      mkdirSync(join(root, 'game'), { recursive: true });
      writeFileSync(join(root, 'game', 'project.json'), '{}');
      const call = (method: string, body?: string) => handleSelectionRequest(root, method, '/api/projects/game/selection', body)!;
      expect(JSON.parse(String(call('GET').body))).toBeNull();
      expect(call('PUT', JSON.stringify({ version: 1, scene: 'quarto', entity: 'pet', at: 5 })).status).toBe(204);
      expect(JSON.parse(String(call('GET').body))).toEqual({ version: 1, scene: 'quarto', entity: 'pet', at: 5 });
      expect(call('PUT', JSON.stringify({ version: 1, scene: 'quarto', entity: null })).status).toBe(204);
      expect(call('PUT', JSON.stringify({ scene: 'quarto' })).status).toBe(400);
      expect(call('PUT', JSON.stringify({ version: 1, scene: 'q', entity: 'x', extra: 1 })).status).toBe(400);
      expect(call('PUT', 'nope').status).toBe(400);
      expect(call('PATCH', '{}').status).toBe(405);
      expect(call('DELETE').status).toBe(204);
      expect(JSON.parse(String(call('GET').body))).toBeNull();
      expect(handleSelectionRequest(root, 'GET', '/api/projects/nope/selection')!.status).toBe(404);
      expect(handleSelectionRequest(root, 'GET', '/api/projects/game/save')).toBeNull();
      // Editor state, not a project edit: no hot reload.
      expect(projectOfFile(root, join(root, 'game', '.vibe', 'selection.json'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
