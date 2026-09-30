import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ProjectStore, ToolError } from '../src';
import { demoCopy, fixedClock } from './helpers';

const meta = { author: 'agent' as const, summary: 'test change', tool: 'test' };

function store() {
  const dir = demoCopy();
  return { dir, store: new ProjectStore(dir, { clock: fixedClock }) };
}

const scenePath = (dir: string) => `${dir}/scenes/level1.json`;
const readScene = (dir: string) => JSON.parse(readFileSync(scenePath(dir), 'utf8'));

function moveCoin(s: ProjectStore, x: number) {
  return s.edit(meta, (tx) => {
    const scene = tx.scene('level1') as { entities: { id: string; transform: { x: number } }[] };
    scene.entities.find((e) => e.id === 'coin1')!.transform.x = x;
    tx.setScene('level1', scene);
  });
}

describe('ProjectStore', () => {
  it('loads and validates the project', () => {
    const { store: s } = store();
    expect(s.name).toBe('demo');
    expect(s.validate().ok).toBe(true);
    expect(Object.keys(s.project().scenes)).toEqual(['level1']);
  });

  it('commits edits to disk, records history with a diff, and leaves no temp files', () => {
    const { dir, store: s } = store();
    const r = moveCoin(s, 450);
    expect(r.seq).toBe(1);
    expect(readScene(dir).entities.find((e: { id: string }) => e.id === 'coin1').transform.x).toBe(450);
    expect(r.files[0].file).toBe('scenes/level1.json');
    expect(r.files[0].diff).toMatch(/-.*"x": 400/);
    expect(r.files[0].diff).toMatch(/\+.*"x": 450/);
    const entry = s.history.get(1)!;
    expect(entry).toMatchObject({ author: 'agent', action: 'edit', tool: 'test', time: expect.stringMatching(/^2026-01-01T/) });
    expect(readdirSync(`${dir}/scenes`)).toEqual(['level1.json']);
    expect(readFileSync(`${dir}/.vibe/history.jsonl`, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('does nothing (and records nothing) when content is unchanged', () => {
    const { store: s } = store();
    moveCoin(s, 450);
    expect(moveCoin(s, 450).seq).toBeNull();
    expect(s.history.all()).toHaveLength(1);
  });

  it('rejects edits that would make the project invalid, writing nothing', () => {
    const { dir, store: s } = store();
    const before = readFileSync(scenePath(dir), 'utf8');
    try {
      s.edit(meta, (tx) => {
        const scene = tx.scene('level1') as { entities: { components: Record<string, unknown> }[] };
        scene.entities[0].components.Body = { type: 'flying' };
        tx.setScene('level1', scene);
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).details.join()).toContain('entities[0](player).components.Body.type');
    }
    expect(readFileSync(scenePath(dir), 'utf8')).toBe(before);
    expect(s.history.all()).toHaveLength(0);
  });

  it('allows unrelated edits while pre-existing errors remain, and reports them', () => {
    const { dir, store: s } = store();
    const scene = readScene(dir);
    scene.camera.follow = 'ghost';
    writeFileSync(scenePath(dir), JSON.stringify(scene)); // broken by hand, outside the store
    const r = s.edit(meta, (tx) => tx.write('notes.txt', 'hello\n'));
    expect(r.seq).toBe(1);
    const r2 = moveCoin(s, 10);
    expect(r2.remainingErrors).toEqual(['scenes.level1.camera.follow: entity "ghost" does not exist']);
  });

  it('undoes and redoes, recording both as history entries', () => {
    const { dir, store: s } = store();
    const original = readFileSync(scenePath(dir), 'utf8');
    moveCoin(s, 450);
    const edited = readFileSync(scenePath(dir), 'utf8');
    s.edit(meta, (tx) => tx.write('scripts/a.txt', 'x\n'));

    s.undo({ author: 'user' });
    expect(existsSync(`${dir}/scripts/a.txt`)).toBe(false);
    s.undo({ author: 'user' });
    expect(readFileSync(scenePath(dir), 'utf8')).toBe(original);
    expect(() => s.undo({ author: 'user' })).toThrow('Nothing to undo');

    s.redo({ author: 'user' });
    expect(readFileSync(scenePath(dir), 'utf8')).toBe(edited);
    expect(s.history.all().map((e) => `${e.action}${e.target ?? ''}`)).toEqual(['edit', 'edit', 'undo2', 'undo1', 'redo1']);
    expect(s.history.stacks()).toEqual({ done: [1], undone: [2] });

    // A fresh store sees the same stacks (the log is the source of truth).
    expect(new ProjectStore(dir).history.stacks()).toEqual({ done: [1], undone: [2] });
  });

  it('refuses to undo over changes made outside the store', () => {
    const { dir, store: s } = store();
    moveCoin(s, 450);
    writeFileSync(scenePath(dir), readFileSync(scenePath(dir), 'utf8').replace('"x": 450', '"x": 451'));
    expect(() => s.undo({ author: 'agent' })).toThrow(/modified afterwards/);
  });

  it('keeps writes inside the project and away from .vibe/', () => {
    const { store: s } = store();
    expect(() => s.edit(meta, (tx) => tx.write('../escape.txt', 'x'))).toThrow(/outside the project/);
    expect(() => s.edit(meta, (tx) => tx.write('.vibe/history.jsonl', 'x'))).toThrow(/managed by the platform/);
    expect(() => s.edit(meta, (tx) => tx.delete('project.json'))).toThrow(/cannot be deleted/);
  });

  it('reports broken JSON files with the file name', () => {
    const { dir, store: s } = store();
    writeFileSync(scenePath(dir), '{ "id": "level1", ');
    const v = s.validate();
    expect(v.ok).toBe(false);
    expect(v.errors[0]).toMatch(/^scenes\/level1\.json: invalid JSON/);
  });
});
