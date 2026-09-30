import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createTwoFilesPatch } from 'diff';

export type Author = 'user' | 'agent';

/** Full contents before and after; `null` means the file did not exist. */
export interface FileChange {
  file: string;
  before: string | null;
  after: string | null;
}

export interface HistoryEntry {
  seq: number;
  time: string;
  author: Author;
  action: 'edit' | 'undo' | 'redo';
  summary: string;
  tool?: string;
  reason?: string;
  /** For undo/redo: the edit entry being undone or redone. */
  target?: number;
  changes: FileChange[];
}

export function unifiedDiff(c: FileChange): string {
  const patch = createTwoFilesPatch(
    c.before === null ? '/dev/null' : `a/${c.file}`,
    c.after === null ? '/dev/null' : `b/${c.file}`,
    c.before ?? '',
    c.after ?? '',
    undefined,
    undefined,
    { context: 2 },
  );
  // Drop the "Index:"/"====" preamble; keep the ---/+++ header and hunks.
  return patch.slice(patch.indexOf('---'));
}

/**
 * Append-only change log (one JSON object per line). Undo and redo are recorded
 * as entries too, so the log is a complete audit trail; the undo/redo stacks are
 * derived by replaying it.
 */
export class History {
  private entries: HistoryEntry[] = [];

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.entries.push(JSON.parse(line));
      } catch {
        // A torn last line (crash mid-append) is ignored rather than losing the whole log.
      }
    }
  }

  all(): readonly HistoryEntry[] {
    return this.entries;
  }

  get(seq: number): HistoryEntry | undefined {
    return this.entries.find((e) => e.seq === seq);
  }

  get nextSeq() {
    return (this.entries.at(-1)?.seq ?? 0) + 1;
  }

  append(entry: HistoryEntry) {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    this.entries.push(entry);
  }

  /** Edit seqs currently applied (undo pops from the end) and undone ones (redo pops from the end). */
  stacks(): { done: number[]; undone: number[] } {
    const done: number[] = [];
    let undone: number[] = [];
    for (const e of this.entries) {
      if (e.action === 'edit') {
        done.push(e.seq);
        undone = [];
      } else if (e.action === 'undo') {
        if (done.at(-1) === e.target) done.pop();
        undone.push(e.target!);
      } else if (undone.at(-1) === e.target) {
        undone.pop();
        done.push(e.target!);
      }
    }
    return { done, undone };
  }
}
