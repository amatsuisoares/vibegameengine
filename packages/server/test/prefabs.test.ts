import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

const json = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

describe('prefab tools', () => {
  it('turns an entity into a prefab, creates instances and edits them all at once', async () => {
    const { ok, fail, dir } = setup();
    const created = await ok<{ file: string }>('create_prefab', { id: 'walker', from: { scene: 'level1', id: 'enemy1' }, link: true, reason: 'reuse enemies' });
    expect(created.file).toBe('prefabs/walker.json');
    const prefab = json(dir, 'prefabs/walker.json');
    expect(prefab.tags).toEqual(['enemy']);
    expect(prefab.transform).toBeUndefined(); // position stays with the instance
    const enemy1 = json(dir, 'scenes/level1.json').entities.find((e: { id: string }) => e.id === 'enemy1');
    expect(enemy1).toEqual({ id: 'enemy1', prefab: 'walker', transform: { x: 600, y: 406 } });

    await ok('create_game_object', { scene: 'level1', entity: { id: 'enemy3', prefab: 'walker', transform: { x: 1800, y: 406 } } });
    const eff = await ok<{ effective: { tags: string[]; components: Record<string, unknown> } }>('get_game_object', { scene: 'level1', id: 'enemy3' });
    expect(eff.effective.tags).toEqual(['enemy']);
    expect(Object.keys(eff.effective.components)).toContain('Patrol');

    await ok('modify_prefab', { id: 'walker', patch: { components: { Sprite: { color: '#00ffff' } } } });
    await ok('run_game');
    const state = await ok<{ entities: { id: string; components: { Sprite: { color: string } } }[] }>('inspect_game_state', {
      ids: ['enemy1', 'enemy3'],
      components: true,
    });
    expect(state.entities.map((e) => e.components.Sprite.color)).toEqual(['#00ffff', '#00ffff']);

    const summary = await ok<{ prefabs: { id: string }[]; scenes: { entities: { id: string; prefab?: string }[] }[] }>('get_project_summary');
    expect(summary.prefabs.map((p) => p.id)).toEqual(['walker']);
    expect(summary.scenes[0].entities.find((e) => e.id === 'enemy3')!.prefab).toBe('walker');

    // In use: cannot be deleted; a broken prefab edit is rejected with the instance path.
    const del = await fail('delete_prefab', { id: 'walker' });
    expect(del.details).toContain('scenes.level1.entities(enemy1).prefab: prefab "walker" does not exist');
    const bad = await fail('modify_prefab', { id: 'walker', patch: { components: { Patrol: { speed: 'fast' } } } });
    expect(bad.details?.[0]).toMatch(/Patrol\.speed/);
    expect((await fail('create_prefab', { id: 'walker', entity: {} })).error).toMatch(/already exists/);
    expect((await fail('create_prefab', { id: 'x', entity: { id: 'no' } })).error).toBe('A prefab has no id: instances get their own');

    // Undoing the three changes restores the entity as it was before it was linked, and removes the prefab.
    for (let i = 0; i < 3; i++) await ok('undo');
    expect(() => json(dir, 'prefabs/walker.json')).toThrow();
    expect(json(dir, 'scenes/level1.json').entities.find((e: { id: string }) => e.id === 'enemy1').components.Patrol).toBeDefined();
  });
});
