import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { unifiedDiff } from '../history';
import { normalizeRel, ToolError } from '../project-store';
import { defineTool } from './registry';
import { changeInfo } from './scene-tools';

const Path = z.string().min(1).describe('Path relative to the project folder, e.g. "scenes/level1.json".');
const MAX_READ_LINES = 2000;

function isBinary(buf: Buffer) {
  return buf.subarray(0, 8000).includes(0);
}

export const fileTools = [
  defineTool({
    name: 'list_files',
    description: 'Lists project files (recursively) with sizes. The .vibe/ folder (history, runs) is omitted.',
    input: z.object({ dir: z.string().optional().describe('Subfolder to list (default: whole project).') }),
    run: ({ store }, { dir = '' }) => {
      const root = store.path(dir);
      if (!existsSync(root) || !statSync(root).isDirectory()) throw new ToolError(`Folder "${dir}" does not exist`);
      const out: { path: string; bytes: number }[] = [];
      const walk = (abs: string, rel: string) => {
        for (const d of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const r = rel ? `${rel}/${d.name}` : d.name;
          if (r === '.vibe') continue;
          if (d.isDirectory()) walk(join(abs, d.name), r);
          else out.push({ path: r, bytes: statSync(join(abs, d.name)).size });
        }
      };
      walk(root, normalizeRel(dir));
      return out;
    },
  }),

  defineTool({
    name: 'read_file',
    description: `Reads a text file with line numbers ("12| text"). Use startLine/endLine for large files (max ${MAX_READ_LINES} lines per call).`,
    input: z.object({
      path: Path,
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
    run: ({ store }, { path, startLine = 1, endLine }) => {
      const abs = store.path(path);
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new ToolError(`File "${normalizeRel(path)}" does not exist`);
      const buf = readFileSync(abs);
      if (isBinary(buf)) return { path: normalizeRel(path), binary: true, bytes: buf.length };
      const lines = buf.toString('utf8').split('\n');
      if (lines.at(-1) === '') lines.pop();
      const last = Math.min(endLine ?? lines.length, lines.length, startLine + MAX_READ_LINES - 1);
      const width = String(last).length;
      const text = lines
        .slice(startLine - 1, last)
        .map((l, i) => `${String(startLine + i).padStart(width)}| ${l}`)
        .join('\n');
      return { path: normalizeRel(path), totalLines: lines.length, startLine, endLine: last, text };
    },
  }),

  defineTool({
    name: 'write_file',
    description:
      'Creates or overwrites a text file. Writes to project.json or scenes/*.json are validated and rejected if they break the project. Prefer the scene/entity tools for game data.',
    mutates: true,
    destructive: true,
    input: z.object({ path: Path, content: z.string() }),
    run: ({ store }, { path, content }, meta) => {
      const rel = normalizeRel(path);
      const existed = store.readText(rel) !== null;
      return changeInfo(store.edit(meta(`${existed ? 'Overwrite' : 'Create'} ${rel}`), (tx) => tx.write(rel, content)));
    },
  }),

  defineTool({
    name: 'edit_file',
    description: 'Replaces an exact text fragment in a file. oldText must occur exactly once unless replaceAll is true.',
    mutates: true,
    input: z.object({
      path: Path,
      oldText: z.string().min(1),
      newText: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    run: ({ store }, { path, oldText, newText, replaceAll }, meta) => {
      const rel = normalizeRel(path);
      return changeInfo(
        store.edit(meta(`Edit ${rel}`), (tx) => {
          const text = tx.read(rel);
          if (text === null) throw new ToolError(`File "${rel}" does not exist`);
          const count = text.split(oldText).length - 1;
          if (count === 0) throw new ToolError(`oldText was not found in ${rel}`);
          if (count > 1 && !replaceAll) {
            throw new ToolError(`oldText occurs ${count} times in ${rel}; add surrounding text to make it unique, or set replaceAll`);
          }
          tx.write(rel, replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText));
        }),
      );
    },
  }),

  defineTool({
    name: 'delete_file',
    description: 'Deletes a file (can be undone).',
    mutates: true,
    destructive: true,
    input: z.object({ path: Path }),
    run: ({ store }, { path }, meta) => changeInfo(store.edit(meta(`Delete ${normalizeRel(path)}`), (tx) => tx.delete(path))),
  }),
];

export const historyTools = [
  defineTool({
    name: 'get_history',
    description: 'Recent changes (newest last) with author, tool and reason. Pass `seq` to get the full diff of one change.',
    input: z.object({
      limit: z.number().int().min(1).max(100).optional().describe('Number of entries (default 10).'),
      seq: z.number().int().optional().describe('Show this entry with its diff.'),
    }),
    run: ({ store }, { limit = 10, seq }) => {
      if (seq !== undefined) {
        const e = store.history.get(seq);
        if (!e) throw new ToolError(`No history entry #${seq}`);
        const { changes, ...rest } = e;
        return { ...rest, files: changes.map((c) => c.file), diff: changes.map(unifiedDiff).join('\n') };
      }
      const { done, undone } = store.history.stacks();
      return {
        canUndo: done.length > 0,
        canRedo: undone.length > 0,
        entries: store.history
          .all()
          .slice(-limit)
          .map(({ changes, ...e }) => ({ ...e, files: changes.map((c) => c.file) })),
      };
    },
  }),

  defineTool({
    name: 'undo',
    description: 'Reverts the most recent change that has not been undone. Refused if its files were modified since.',
    mutates: true,
    input: z.object({}),
    run: ({ store, author }, input) => changeInfo(store.undo({ author, tool: 'undo', reason: (input as { reason?: string }).reason })),
  }),

  defineTool({
    name: 'redo',
    description: 'Re-applies the most recently undone change.',
    mutates: true,
    input: z.object({}),
    run: ({ store, author }, input) => changeInfo(store.redo({ author, tool: 'redo', reason: (input as { reason?: string }).reason })),
  }),
];
