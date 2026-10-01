import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type Summary = { scenes: { id: string; entities: { id: string; components: string[] }[] }[]; valid: boolean; history: { canUndo: boolean } };

describe('tool registry', () => {
  it('exports every tool as a Claude tool definition with an object JSON Schema', async () => {
    const { tools } = setup();
    const defs = tools.definitions();
    expect(defs.length).toBeGreaterThanOrEqual(20);
    for (const d of defs) {
      expect(d.name).toMatch(/^[a-z_]+$/);
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.input_schema.type).toBe('object');
      expect(d.input_schema).not.toHaveProperty('$schema');
    }
    const modify = defs.find((d) => d.name === 'modify_game_object')!.input_schema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(modify.properties)).toEqual(['scene', 'id', 'patch', 'reason']);
    expect(modify.required).toEqual(['scene', 'id', 'patch']);
  });

  it('returns readable errors for unknown tools and bad input', async () => {
    const { call } = setup();
    expect(await call('fly', {})).toMatchObject({ ok: false, error: expect.stringContaining('Unknown tool "fly"') });
    const r = await call('modify_game_object', { scene: 'level1', patch: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.details!.join('\n')).toMatch(/id: .*\n?.*patch/s);
  });
});

describe('project and scene tools', () => {
  it('summarizes the project', async () => {
    const { ok } = setup();
    const s = await ok<Summary>('get_project_summary');
    expect(s.valid).toBe(true);
    expect(s.scenes[0].id).toBe('level1');
    expect(s.scenes[0].entities.find((e) => e.id === 'player')!.components).toContain('PlatformerController');
    expect(s.history.canUndo).toBe(false);
  });

  it('lists component types briefly, or in full on request', async () => {
    const { ok } = setup();
    const brief = await ok<{ type: string; description: string }[]>('list_component_types');
    expect(brief.map((c) => c.type)).toContain('Patrol');
    const [patrol] = await ok<{ schema: { properties: Record<string, { default?: unknown; description?: string }> } }[]>('list_component_types', { types: ['Patrol'] });
    expect(patrol.schema.properties.speed.default).toBe(60);
    expect(patrol.schema.properties.turnAtEdges.description).toContain('ledge');
  });

  it('creates, modifies and deletes scenes', async () => {
    const { ok, fail, dir } = setup();
    await ok('create_scene', { id: 'level2', settings: { width: 1200, background: '#000000' }, entities: [{ id: 'floor', components: { Collider: {} } }] });
    expect(JSON.parse(readFileSync(`${dir}/scenes/level2.json`, 'utf8'))).toMatchObject({ id: 'level2', width: 1200 });
    expect((await fail('create_scene', { id: 'level2' })).error).toContain('already exists');

    await ok('modify_scene', { scene: 'level2', patch: { background: null, vars: { lives: 3 } } });
    const scene = await ok<{ settings: Record<string, unknown> }>('get_scene', { scene: 'level2' });
    expect(scene.settings).toEqual({ id: 'level2', width: 1200, vars: { lives: 3 } });
    expect((await fail('modify_scene', { scene: 'level2', patch: { entities: [] } })).error).toContain('cannot change entities');

    expect((await fail('delete_scene', { scene: 'level1' })).details!.join()).toContain('config.startScene');
    await ok('delete_scene', { scene: 'level2' });
    expect(existsSync(`${dir}/scenes/level2.json`)).toBe(false);
  });

  it('modifies the project config', async () => {
    const { ok, fail } = setup();
    await ok('modify_project_config', { patch: { gravity: 1200, actions: { dash: ['Shift'] } } });
    expect((await fail('modify_project_config', { patch: { startScene: 'nowhere' } })).details![0]).toContain('config.startScene');
  });
});

describe('entity and component tools', () => {
  it('creates an entity with minimal JSON and shows effective defaults', async () => {
    const { ok, fail } = setup();
    const r = (await ok<{ changed: boolean; diff: string; historySeq: number }>('create_game_object', {
      scene: 'level1',
      entity: { id: 'coin9', tags: ['coin'], transform: { x: 500, y: 380 }, components: { Collider: { isTrigger: true }, Collectible: {} } },
      reason: 'extra coin',
    }));
    expect(r.changed).toBe(true);
    expect(r.diff).toContain('+');
    const got = await ok<{ raw: unknown; effective: { components: { Collectible: { variable: string } } } }>('get_game_object', { scene: 'level1', id: 'coin9' });
    expect(got.effective.components.Collectible.variable).toBe('coins');
    expect((await fail('create_game_object', { scene: 'level1', entity: { id: 'coin9' } })).error).toContain('already exists');
  });

  it('rejects entities with invalid components and names the problem', async () => {
    const { fail } = setup();
    const r = await fail('create_game_object', { scene: 'level1', entity: { id: 'bad', components: { Jetpack: {} } } });
    expect(r.error).toContain('would become invalid');
    expect(r.details!.join()).toMatch(/entities\[\d+\]\(bad\)\.components/);
  });

  it('modifies entities with merge patches and removes components with null', async () => {
    const { ok, dir } = setup();
    await ok('modify_game_object', { scene: 'level1', id: 'enemy1', patch: { transform: { x: 650 }, components: { Stompable: null } } });
    const e = JSON.parse(readFileSync(`${dir}/scenes/level1.json`, 'utf8')).entities.find((x: { id: string }) => x.id === 'enemy1');
    expect(e.transform).toEqual({ x: 650, y: 406 });
    expect(e.components.Stompable).toBeUndefined();
    expect(e.components.Patrol).toEqual({ speed: 60, distance: 200 });
  });

  it('duplicates entities', async () => {
    const { ok } = setup();
    await ok('duplicate_game_object', { scene: 'level1', id: 'enemy1', newId: 'enemy3', patch: { transform: { x: 2000 } } });
    const e = await ok<{ raw: { transform: { x: number; y: number }; components: object } }>('get_game_object', { scene: 'level1', id: 'enemy3' });
    expect(e.raw.transform).toEqual({ x: 2000, y: 406 });
    expect(Object.keys(e.raw.components)).toContain('Patrol');
  });

  it('suggests close ids when an entity does not exist', async () => {
    const { fail } = setup();
    expect((await fail('delete_game_object', { scene: 'level1', id: 'enemy' })).error).toMatch(/Did you mean: enemy1, enemy2/);
  });

  it('refuses to delete an entity that is still referenced', async () => {
    const { fail } = setup();
    expect((await fail('delete_game_object', { scene: 'level1', id: 'player' })).details!.join()).toContain('camera.follow');
  });

  it('adds, modifies and removes components', async () => {
    const { ok, fail } = setup();
    await ok('create_component', { scene: 'level1', id: 'enemy2', type: 'Health', data: { max: 2 } });
    expect((await fail('create_component', { scene: 'level1', id: 'enemy2', type: 'Health' })).error).toContain('already has Health');
    await ok('modify_component', { scene: 'level1', id: 'enemy2', type: 'Health', patch: { max: 5 } });
    expect((await fail('modify_component', { scene: 'level1', id: 'enemy2', type: 'Health', patch: { max: -1 } })).details![0]).toContain('Health.max');
    await ok('remove_component', { scene: 'level1', id: 'enemy2', type: 'Health' });
    expect((await fail('remove_component', { scene: 'level1', id: 'enemy2', type: 'Health' })).error).toContain('has no Health');
    expect((await fail('create_component', { scene: 'level1', id: 'enemy2', type: 'Wings' })).ok).toBe(false);
  });
});

describe('file tools', () => {
  it('lists, reads with line numbers, writes, edits and deletes files', async () => {
    const { ok, fail } = setup();
    const files = (await ok<{ path: string }[]>('list_files')).map((f) => f.path);
    expect(files.filter((f) => !f.startsWith('assets/sfx/'))).toEqual(['assets/coin.svg', 'assets/hero.svg', 'project.json', 'scenes/level1.json']);
    expect(files.filter((f) => f.startsWith('assets/sfx/'))).toContain('assets/sfx/sfx_coin.wav');

    await ok('write_file', { path: 'scripts/notes.md', content: 'line one\nline two\nline two\n' });
    const read = await ok<{ text: string; totalLines: number }>('read_file', { path: 'scripts/notes.md', startLine: 2 });
    expect(read.text).toBe('2| line two\n3| line two');
    expect(read.totalLines).toBe(3);

    expect((await fail('edit_file', { path: 'scripts/notes.md', oldText: 'line two', newText: 'x' })).error).toContain('occurs 2 times');
    await ok('edit_file', { path: 'scripts/notes.md', oldText: 'line one', newText: 'first $& line' });
    expect((await ok<{ text: string }>('read_file', { path: 'scripts/notes.md', endLine: 1 })).text).toBe('1| first $& line');

    await ok('delete_file', { path: 'scripts/notes.md' });
    expect((await fail('read_file', { path: 'scripts/notes.md' })).error).toContain('does not exist');
    expect((await fail('read_file', { path: '../../package.json' })).error).toContain('outside the project');
    expect((await fail('write_file', { path: '.vibe/history.jsonl', content: '' })).error).toContain('.vibe/');
  });

  it('validates raw writes to scene files', async () => {
    const { fail } = setup();
    const r = await fail('edit_file', { path: 'scenes/level1.json', oldText: '"id": "level1"', newText: '"id": "level 1"' });
    expect(r.error).toContain('would become invalid');
  });
});

describe('history tools', () => {
  it('shows history with authors and reasons, and undoes/redoes', async () => {
    const { ok, fail, call } = setup();
    await ok('modify_game_object', { scene: 'level1', id: 'coin1', patch: { transform: { y: 300 } }, reason: 'make it harder' });
    await call('write_file', { path: 'a.txt', content: 'a' }, 'user');

    const h = await ok<{ entries: { seq: number; author: string; tool: string; reason?: string; files: string[] }[]; canUndo: boolean }>('get_history');
    expect(h.entries).toMatchObject([
      { seq: 1, author: 'agent', tool: 'modify_game_object', reason: 'make it harder', files: ['scenes/level1.json'] },
      { seq: 2, author: 'user', tool: 'write_file', files: ['a.txt'] },
    ]);
    expect((await ok<{ diff: string }>('get_history', { seq: 1 })).diff).toContain('"y": 300');

    await ok('undo');
    await ok('undo');
    expect((await fail('undo')).error).toBe('Nothing to undo');
    await ok('redo');
    expect((await ok<{ entries: { summary: string }[] }>('get_history', { limit: 3 })).entries.map((e) => e.summary)).toEqual([
      'Undo #2: Create a.txt',
      'Undo #1: Modify coin1 in level1 (transform)',
      'Redo #1: Modify coin1 in level1 (transform)',
    ]);
  });
});
