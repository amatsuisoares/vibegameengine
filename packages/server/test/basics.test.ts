import { describe, expect, it } from 'vitest';
import { formatJson, History, mergePatch, unifiedDiff } from '../src';
import { demoCopy } from './helpers';

describe('formatJson', () => {
  it('keeps short containers on one line and expands long ones', () => {
    const v = { id: 'coin', transform: { x: 1, y: 2 }, tags: [], list: Array.from({ length: 40 }, (_, i) => i) };
    expect(formatJson(v, 60)).toBe(
      [
        '{',
        '  "id": "coin",',
        '  "transform": { "x": 1, "y": 2 },',
        '  "tags": [],',
        '  "list": [',
        ...Array.from({ length: 40 }, (_, i) => `    ${i}${i < 39 ? ',' : ''}`),
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('round-trips values and is idempotent', () => {
    const v = { a: [{ b: 'x'.repeat(200) }, null, true], c: { d: { e: 1.5 } }, s: 'quote " and \\ backslash' };
    const text = formatJson(v, 40);
    expect(JSON.parse(text)).toEqual(v);
    expect(formatJson(JSON.parse(text), 40)).toBe(text);
  });
});

describe('mergePatch (RFC 7386)', () => {
  it('merges objects, deletes with null, replaces arrays', () => {
    const target = { a: 1, b: { c: 2, d: 3 }, tags: ['x', 'y'] };
    expect(mergePatch(target, { b: { c: null, e: 4 }, tags: ['z'], f: { g: 1 } })).toEqual({
      a: 1,
      b: { d: 3, e: 4 },
      tags: ['z'],
      f: { g: 1 },
    });
    expect(target).toEqual({ a: 1, b: { c: 2, d: 3 }, tags: ['x', 'y'] }); // not mutated
  });
});

describe('History', () => {
  it('derives undo/redo stacks from the log and survives a torn last line', async () => {
    const dir = demoCopy();
    const file = `${dir}/.vibe/history.jsonl`;
    const h = new History(file);
    const base = { time: 't', author: 'agent' as const, summary: 's', changes: [] };
    h.append({ ...base, seq: 1, action: 'edit' });
    h.append({ ...base, seq: 2, action: 'edit' });
    h.append({ ...base, seq: 3, action: 'undo', target: 2 });
    expect(h.stacks()).toEqual({ done: [1], undone: [2] });
    h.append({ ...base, seq: 4, action: 'redo', target: 2 });
    expect(h.stacks()).toEqual({ done: [1, 2], undone: [] });
    h.append({ ...base, seq: 5, action: 'undo', target: 2 });
    h.append({ ...base, seq: 6, action: 'edit' });
    expect(h.stacks()).toEqual({ done: [1, 6], undone: [] }); // a new edit clears redo

    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, '{"seq":7,"act');
    const reloaded = new History(file);
    expect(reloaded.all()).toHaveLength(6);
    expect(reloaded.nextSeq).toBe(7);
  });

  it('renders unified diffs, including created and deleted files', () => {
    expect(unifiedDiff({ file: 'a.txt', before: 'one\ntwo\n', after: 'one\n2\n' })).toBe(
      '--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n',
    );
    expect(unifiedDiff({ file: 'n.txt', before: null, after: 'hi\n' })).toContain('--- /dev/null');
    expect(unifiedDiff({ file: 'n.txt', before: 'hi\n', after: null })).toContain('+++ /dev/null');
  });
});
