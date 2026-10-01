import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentTools } from '../src/tools';
import { setup } from './helpers';

type View = {
  summary: string;
  features: { id: string; text: string; status: string; evidence?: string }[];
  todos: { id: string; status: string }[];
  issues: { id: string; text: string; status: string }[];
  notes: { id: string; text: string }[];
  project: { scenes: { id: string; entities: number }[]; assets: string[] };
  recentChanges: { seq: number; summary: string }[];
};

describe('project memory', () => {
  it('starts empty and derives scenes, assets and recent changes from the project', async () => {
    const { ok } = setup();
    const m = await ok<View>('read_memory');
    expect(m).toMatchObject({ summary: '', features: [], todos: [], issues: [], notes: [] });
    expect(m.project.scenes).toEqual([{ id: 'level1', entities: 15 }]);
    expect(m.project.assets.slice(0, 3)).toEqual(['hero (spritesheet)', 'coin (spritesheet)', 'sfx_jump (audio)']);
    expect(m.recentChanges).toEqual([]);
  });

  it('records features, todos, issues and notes, and updates them by id', async () => {
    const { ok, fail, dir } = setup();
    const r = await ok<{ created: string[]; open: number }>('update_memory', {
      summary: 'Platformer: collect coins, avoid enemies, reach the flag.',
      upsert: [
        { kind: 'feature', text: 'Fourth coin above ground1, needs a jump' },
        { kind: 'feature', text: 'Enemies patrol' },
        { kind: 'todo', text: 'Add a second level' },
        { kind: 'issue', text: 'Enemies overlap each other' },
        { kind: 'note', text: 'HUD total is hard-coded: update it when adding coins' },
      ],
    });
    expect(r).toEqual({ created: ['f1', 'f2', 't1', 'i1', 'n1'], open: 4, done: 0, verified: 0 });

    await ok('update_memory', {
      upsert: [
        { id: 'f1', status: 'verified', evidence: 'collect event for coin4 at frame 52; not collected when walking' },
        { id: 'i1', status: 'done' },
        { kind: 'todo', text: 'Moving platforms' },
      ],
      remove: ['f2'],
    });
    const m = await ok<View>('read_memory');
    expect(m.summary).toMatch(/^Platformer/);
    expect(m.features).toEqual([
      { id: 'f1', text: 'Fourth coin above ground1, needs a jump', status: 'verified', evidence: 'collect event for coin4 at frame 52; not collected when walking' },
    ]);
    expect(m.todos.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(m.issues).toEqual([{ id: 'i1', text: 'Enemies overlap each other', status: 'done' }]);
    expect(m.notes[0].id).toBe('n1');

    // Stored as a readable file, outside the undo history.
    const stored = JSON.parse(readFileSync(join(dir, '.vibe', 'memory.json'), 'utf8'));
    expect(stored.items).toHaveLength(5);
    expect((await ok<{ entries: unknown[] }>('get_history')).entries).toEqual([]);

    expect((await fail('update_memory', { remove: ['zz'] })).error).toBe('No memory item with id zz');
    expect((await fail('update_memory', { upsert: [{ text: 'no kind' }] })).error).toMatch(/kind and text are required/);
    expect((await fail('update_memory', { upsert: [{ id: 'x9', status: 'done' }] })).error).toMatch(/no item "x9"/);
  });

  it('shows open items in the project summary, and reports a broken memory file', async () => {
    const { ok, dir } = setup();
    await ok('update_memory', { upsert: [{ kind: 'todo', text: 'Add audio' }, { kind: 'feature', text: 'Coins', status: 'verified' }, { kind: 'note', text: 'n' }] });
    expect((await ok<{ memory: string[] }>('get_project_summary')).memory).toEqual(['t1 [todo] Add audio']);

    writeFileSync(join(dir, '.vibe', 'memory.json'), '{"items": 3}');
    expect((await ok<{ memory: unknown }>('get_project_summary')).memory).toEqual({ error: '.vibe/memory.json is invalid' });
  });

  it('marks update_memory as writing for MCP clients', () => {
    const tools = createAgentTools();
    expect(tools.annotations('update_memory')).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(tools.annotations('read_memory')).toEqual({ readOnlyHint: true, destructiveHint: false });
  });
});
