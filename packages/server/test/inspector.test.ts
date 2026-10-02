import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInspectorEdit, inspectEntity, ProjectStore, replacePatch, type Inspection } from '../src';
import { setup } from './helpers';

const section = (i: Inspection, id: string) => i.sections.find((s) => s.id === id)!;
const field = (i: Inspection, sec: string, key: string) => section(i, sec).fields.find((f) => f.key === key)!;
const sceneFile = (dir: string) => readFileSync(join(dir, 'scenes', 'level1.json'), 'utf8');

describe('inspector', () => {
  it('describes an entity as typed fields from its component schemas', () => {
    const { store } = setup();
    const i = inspectEntity(store, 'level1', 'player');
    expect(i.sections.map((s) => s.id)).toEqual(['entity', 'transform', 'Sprite', 'Body', 'Collider', 'PlatformerController', 'Health', 'Animator']);
    expect(field(i, 'entity', 'tags')).toMatchObject({ kind: 'list', value: ['player'], set: true });
    expect(field(i, 'transform', 'x')).toMatchObject({ kind: 'number', set: true });
    expect(field(i, 'Sprite', 'width')).toMatchObject({ kind: 'number', value: 24, set: true, min: 0 });
    expect(field(i, 'Sprite', 'shape')).toMatchObject({ kind: 'enum', value: 'rect', options: ['rect', 'circle', 'triangle'], set: false, default: 'rect' });
    expect(field(i, 'Sprite', 'color')).toMatchObject({ kind: 'color', value: '#ffcc00' });
    expect(field(i, 'Sprite', 'asset')).toMatchObject({ kind: 'asset', value: 'hero' });
    expect(field(i, 'Sprite', 'asset').options).toContain('coin');
    expect(field(i, 'Sprite', 'opacity')).toMatchObject({ kind: 'number', min: 0, max: 1 });
    expect(field(i, 'Sprite', 'frame')).toMatchObject({ kind: 'integer' });
    expect(field(i, 'Sprite', 'frame').max).toBeUndefined();
    expect(field(i, 'Body', 'type')).toMatchObject({ kind: 'enum', value: 'dynamic' });
    expect(field(i, 'Animator', 'animations').kind).toBe('json');
    expect(section(i, 'Sprite').description).toMatch(/./);
    expect(i.addable).toContain('Interactable');
    expect(i.addable).not.toContain('Sprite');
  });

  it('applies an edit as the user, through the store and the history', async () => {
    const { store, ok } = setup();
    const r = await applyInspectorEdit(store, 'level1', 'coin1', { action: 'set', section: 'Sprite', key: 'width', value: 40 });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(field(r.inspection!, 'Sprite', 'width')).toMatchObject({ value: 40, set: true });
    const history = await ok<{ entries: { author: string; tool: string; reason?: string }[] }>('get_history');
    expect(history.entries.at(-1)).toMatchObject({ author: 'user', tool: 'modify_game_object', reason: 'Inspector: Sprite.width of coin1 = 40' });

    // Undo works on it like on any other change.
    await ok('undo');
    expect(field(inspectEntity(store, 'level1', 'coin1'), 'Sprite', 'width').value).toBe(16);
  });

  it('resets a field to its default with null, and edits entity and transform fields', async () => {
    const { store } = setup();
    let r = await applyInspectorEdit(store, 'level1', 'enemy1', { action: 'set', section: 'Sprite', key: 'layer', value: null });
    expect(field(r.inspection!, 'Sprite', 'layer')).toMatchObject({ value: 0, set: false });
    r = await applyInspectorEdit(store, 'level1', 'enemy1', { action: 'set', section: 'entity', key: 'enabled', value: false });
    expect(field(r.inspection!, 'entity', 'enabled')).toMatchObject({ value: false, set: true });
    r = await applyInspectorEdit(store, 'level1', 'enemy1', { action: 'set', section: 'transform', key: 'y', value: 123 });
    expect(field(r.inspection!, 'transform', 'y').value).toBe(123);
    r = await applyInspectorEdit(store, 'level1', 'enemy1', { action: 'set', section: 'entity', key: 'tags', value: ['enemy', 'boss'] });
    expect(field(r.inspection!, 'entity', 'tags').value).toEqual(['enemy', 'boss']);
  });

  it('rejects invalid values without writing anything', async () => {
    const { store, dir } = setup();
    const before = sceneFile(dir);
    const r = await applyInspectorEdit(store, 'level1', 'coin1', { action: 'set', section: 'Sprite', key: 'width', value: -5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/rejected/i);
      expect(r.details?.join('\n')).toMatch(/Sprite\.width/);
      expect(field(r.inspection!, 'Sprite', 'width').value).toBe(16);
    }
    expect(sceneFile(dir)).toBe(before);
    expect((await applyInspectorEdit(store, 'level1', 'coin1', { action: 'set', section: 'Nope', key: 'x', value: 1 })).ok).toBe(false);
    expect((await applyInspectorEdit(store, 'level1', 'coin1', { action: 'set', section: 'entity', key: 'id', value: 'x' })).ok).toBe(false);
  });

  it('replaces object fields instead of merging them', async () => {
    const { store } = setup();
    const r = await applyInspectorEdit(store, 'level1', 'coin1', {
      action: 'set',
      section: 'Animator',
      key: 'animations',
      value: { turn: { frames: [0, 1], fps: 4 } },
    });
    expect(r.ok).toBe(true);
    // "spin" is gone: a plain merge patch would have kept it.
    expect(Object.keys(field(r.inspection!, 'Animator', 'animations').value as object)).toEqual(['turn']);
    expect(replacePatch({ a: 1, b: { c: 1, d: 2 } }, { b: { c: 3 } })).toEqual({ a: null, b: { c: 3, d: null } });
    expect(replacePatch([1], [2])).toEqual([2]);
  });

  it('adds and removes components', async () => {
    const { store } = setup();
    let r = await applyInspectorEdit(store, 'level1', 'flag', { action: 'addComponent', type: 'Interactable' });
    expect(r.ok && r.inspection.sections.some((s) => s.id === 'Interactable')).toBe(true);
    r = await applyInspectorEdit(store, 'level1', 'flag', { action: 'removeComponent', type: 'Interactable' });
    expect(r.ok && r.inspection.sections.some((s) => s.id === 'Interactable')).toBe(false);
    // Components that need data are rejected with the reason.
    r = await applyInspectorEdit(store, 'level1', 'flag', { action: 'addComponent', type: 'Script' });
    expect(r.ok).toBe(false);
  });

  it('shows what comes from a prefab and refuses to remove a prefab component from an instance', async () => {
    const { store, ok } = setup();
    await ok('create_prefab', { id: 'moeda', from: { scene: 'level1', id: 'coin2' }, link: true });
    const i = inspectEntity(store, 'level1', 'coin2');
    expect(i.prefab).toBe('moeda');
    expect(section(i, 'Collectible').fromPrefab).toBe(true);
    expect(field(i, 'Sprite', 'width')).toMatchObject({ value: 16, set: false, fromPrefab: true });

    // Overriding a prefab value stores only the difference; null goes back to the prefab's.
    let r = await applyInspectorEdit(store, 'level1', 'coin2', { action: 'set', section: 'Sprite', key: 'width', value: 30 });
    expect(field(r.inspection!, 'Sprite', 'width')).toMatchObject({ value: 30, set: true });
    r = await applyInspectorEdit(store, 'level1', 'coin2', { action: 'set', section: 'Sprite', key: 'width', value: null });
    expect(field(r.inspection!, 'Sprite', 'width')).toMatchObject({ value: 16, fromPrefab: true });

    r = await applyInspectorEdit(store, 'level1', 'coin2', { action: 'removeComponent', type: 'Collectible' });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/prefab "moeda"/) });
  });

  it('shares the history with the agent process: the agent sees and can undo inspector edits', async () => {
    // The agent's store lives as long as the MCP server; the editor panels use their own (the Vite process).
    const { store: agentStore, dir, ok } = setup();
    await ok('modify_game_object', { scene: 'level1', id: 'coin3', patch: { transform: { x: 10 } } });
    const editorStore = new ProjectStore(dir);
    await applyInspectorEdit(editorStore, 'level1', 'coin3', { action: 'set', section: 'Sprite', key: 'width', value: 24 });
    const seqs = agentStore.history.all().map((e) => [e.seq, e.author]);
    expect(seqs).toEqual([
      [1, 'agent'],
      [2, 'user'],
    ]);
    await ok('undo');
    expect(field(inspectEntity(editorStore, 'level1', 'coin3'), 'Sprite', 'width').value).toBe(16);
    expect(editorStore.history.nextSeq).toBe(4);
  });

  it('moves an entity (viewport drag) in one history entry, from its effective position', async () => {
    const { store, ok } = setup();
    let r = await applyInspectorEdit(store, 'level1', 'coin1', { action: 'move', dx: 12, dy: -4.5 });
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(field(r.inspection!, 'transform', 'x').value).toBe(412);
    expect(field(r.inspection!, 'transform', 'y').value).toBe(385.5);
    const history = await ok<{ entries: { author: string; reason?: string }[] }>('get_history');
    expect(history.entries.at(-1)).toMatchObject({ author: 'user', reason: 'Viewport: move coin1 by (12, -4.5) to (412, 385.5)' });

    // A prefab instance gets the moved position stored on the instance.
    await ok('create_prefab', { id: 'moeda', from: { scene: 'level1', id: 'coin2' }, link: true });
    r = await applyInspectorEdit(store, 'level1', 'coin2', { action: 'move', dx: -100, dy: 0 });
    expect(field(r.inspection!, 'transform', 'x')).toMatchObject({ value: 1000, set: true });

    expect((await applyInspectorEdit(store, 'level1', 'ghost', { action: 'move', dx: 1, dy: 1 })).ok).toBe(false);
  });

  it('fails clearly for unknown entities', () => {
    const { store } = setup();
    expect(() => inspectEntity(store, 'level1', 'ghost')).toThrow(/does not exist/);
  });
});
