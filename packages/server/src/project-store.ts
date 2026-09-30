import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { parseProject, type Project } from '@vibe/shared';
import { removeFile, writeFileAtomic } from './fs-atomic';
import { History, unifiedDiff, type Author, type FileChange, type HistoryEntry } from './history';
import { formatJson } from './json-format';

/** An error meant to be read by the agent: a message plus optional itemized details. */
export class ToolError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ChangeMeta {
  author: Author;
  summary: string;
  tool?: string;
  reason?: string;
}

export interface CommitResult {
  /** History sequence number, or null when nothing changed. */
  seq: number | null;
  files: { file: string; diff: string }[];
  warnings: string[];
  /** Validation errors that already existed before this change (it did not add any). */
  remainingErrors: string[];
}

export interface SceneFile {
  file: string;
  id: string;
  data?: unknown;
  error?: string;
}

export interface Snapshot {
  config?: unknown;
  configError?: string;
  scenes: SceneFile[];
}

export interface ValidationStatus {
  ok: boolean;
  project?: Project;
  errors: string[];
  warnings: string[];
}

type Changes = Map<string, string | null>;

const PROJECT_FILE = 'project.json';
const HISTORY_FILE = '.vibe/history.jsonl';

/** Normalizes a project-relative path to forward slashes without leading "./". */
export function normalizeRel(rel: string) {
  return rel.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
}

export function isProjectDataFile(rel: string) {
  return rel === PROJECT_FILE || /^scenes\/[^/]+\.json$/.test(rel);
}

function parseJsonText(file: string, text: string): { data?: unknown; error?: string } {
  try {
    return { data: JSON.parse(text) };
  } catch (err) {
    return { error: `${file}: invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Reads and writes one project folder. Every write goes through a transaction that
 * validates the whole project, writes files atomically and appends to the history.
 *
 * Files are re-read from disk on every operation, so edits made outside the store
 * (by hand, in an editor) are always seen; they are just not in the history.
 */
export class ProjectStore {
  readonly dir: string;
  readonly name: string;
  readonly history: History;
  private readonly clock: () => Date;

  constructor(dir: string, options: { clock?: () => Date } = {}) {
    this.dir = resolve(dir);
    this.name = basename(this.dir);
    if (!existsSync(join(this.dir, PROJECT_FILE))) throw new ToolError(`No ${PROJECT_FILE} in ${this.dir}`);
    this.history = new History(join(this.dir, HISTORY_FILE));
    this.clock = options.clock ?? (() => new Date());
  }

  /** Absolute path of a project-relative path; refuses anything outside the project. */
  path(rel: string): string {
    const full = resolve(this.dir, normalizeRel(rel));
    const r = relative(this.dir, full);
    if (r.startsWith('..') || isAbsolute(r)) throw new ToolError(`Path "${rel}" is outside the project`);
    return full;
  }

  readText(rel: string): string | null {
    const file = this.path(rel);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  /** Scene files on disk, with pending changes applied on top. */
  sceneFiles(changes: Changes = new Map()): string[] {
    const dir = join(this.dir, 'scenes');
    const files = new Set(existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => `scenes/${f}`) : []);
    for (const [file, content] of changes) {
      if (!isProjectDataFile(file) || file === PROJECT_FILE) continue;
      if (content === null) files.delete(file);
      else files.add(file);
    }
    return [...files].sort();
  }

  snapshot(changes: Changes = new Map()): Snapshot {
    const read = (f: string) => (changes.has(f) ? changes.get(f)! : this.readText(f));
    const snap: Snapshot = { scenes: [] };
    const configText = read(PROJECT_FILE);
    if (configText === null) snap.configError = `${PROJECT_FILE} is missing`;
    else {
      const r = parseJsonText(PROJECT_FILE, configText);
      snap.config = r.data;
      snap.configError = r.error;
    }
    for (const file of this.sceneFiles(changes)) {
      const r = parseJsonText(file, read(file) ?? '');
      const id = (r.data as { id?: unknown } | undefined)?.id;
      snap.scenes.push({ file, id: typeof id === 'string' ? id : basename(file, '.json'), ...r });
    }
    return snap;
  }

  validate(snap: Snapshot = this.snapshot()): ValidationStatus {
    const errors: string[] = [];
    if (snap.configError) errors.push(snap.configError);
    const scenes: Record<string, unknown> = {};
    const owner = new Map<string, string>();
    for (const s of snap.scenes) {
      if (s.error) errors.push(s.error);
      else if (owner.has(s.id)) errors.push(`${owner.get(s.id)} and ${s.file} both define scene "${s.id}"`);
      else {
        owner.set(s.id, s.file);
        scenes[s.id] = s.data;
      }
    }
    if (errors.length) return { ok: false, errors, warnings: [] };
    const r = parseProject({ config: snap.config, scenes });
    if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings };
    return { ok: true, project: r.value, errors: [], warnings: r.warnings };
  }

  /** The validated, normalized project; throws a ToolError listing problems if it is invalid. */
  project(): Project {
    const v = this.validate();
    if (!v.project) throw new ToolError('The project is currently invalid', v.errors);
    return v.project;
  }

  /** Runs `fn` against a transaction and commits what it changed. */
  edit(meta: ChangeMeta, fn: (tx: Transaction) => void): CommitResult {
    const tx = new Transaction(this);
    fn(tx);
    return this.commit({ ...meta, action: 'edit' }, tx.changes);
  }

  undo(meta: Omit<ChangeMeta, 'summary'>): CommitResult {
    const target = this.history.stacks().done.at(-1);
    if (target === undefined) throw new ToolError('Nothing to undo');
    const entry = this.history.get(target)!;
    this.assertUnchanged(entry, 'after', `undo #${target}`);
    const changes: Changes = new Map(entry.changes.map((c) => [c.file, c.before]));
    return this.commit({ ...meta, summary: `Undo #${target}: ${entry.summary}`, action: 'undo', target }, changes);
  }

  redo(meta: Omit<ChangeMeta, 'summary'>): CommitResult {
    const target = this.history.stacks().undone.at(-1);
    if (target === undefined) throw new ToolError('Nothing to redo');
    const entry = this.history.get(target)!;
    this.assertUnchanged(entry, 'before', `redo #${target}`);
    const changes: Changes = new Map(entry.changes.map((c) => [c.file, c.after]));
    return this.commit({ ...meta, summary: `Redo #${target}: ${entry.summary}`, action: 'redo', target }, changes);
  }

  private assertUnchanged(entry: HistoryEntry, side: 'before' | 'after', what: string) {
    const changed = entry.changes.filter((c) => this.readText(c.file) !== c[side]).map((c) => c.file);
    if (changed.length) {
      throw new ToolError(`Cannot ${what}: these files were modified afterwards`, changed);
    }
  }

  private commit(meta: ChangeMeta & { action: HistoryEntry['action']; target?: number }, pending: Changes): CommitResult {
    const changes: FileChange[] = [];
    for (const [file, after] of pending) {
      const before = this.readText(file);
      if (before !== after) changes.push({ file, before, after });
    }
    if (!changes.length) return { seq: null, files: [], warnings: [], remainingErrors: [] };

    let status: ValidationStatus = { ok: true, errors: [], warnings: [] };
    if (changes.some((c) => isProjectDataFile(c.file))) {
      status = this.validate(this.snapshot(pending));
      if (!status.ok) {
        const existing = new Set(this.validate().errors);
        const introduced = status.errors.filter((e) => !existing.has(e));
        if (introduced.length) throw new ToolError('Change rejected: the project would become invalid (nothing was written)', introduced);
      }
    }

    const written: FileChange[] = [];
    try {
      for (const c of changes) {
        if (c.after === null) removeFile(this.path(c.file));
        else writeFileAtomic(this.path(c.file), c.after);
        written.push(c);
      }
    } catch (err) {
      for (const c of written.reverse()) {
        if (c.before === null) removeFile(this.path(c.file));
        else writeFileAtomic(this.path(c.file), c.before);
      }
      throw new ToolError(`Write failed, changes rolled back: ${err instanceof Error ? err.message : String(err)}`);
    }

    const entry: HistoryEntry = {
      seq: this.history.nextSeq,
      time: this.clock().toISOString(),
      author: meta.author,
      action: meta.action,
      summary: meta.summary,
      ...(meta.tool && { tool: meta.tool }),
      ...(meta.reason && { reason: meta.reason }),
      ...(meta.target !== undefined && { target: meta.target }),
      changes,
    };
    this.history.append(entry);
    return {
      seq: entry.seq,
      files: changes.map((c) => ({ file: c.file, diff: unifiedDiff(c) })),
      warnings: status.warnings,
      remainingErrors: status.errors,
    };
  }
}

/** Pending edits; reads see earlier writes of the same transaction. */
export class Transaction {
  readonly changes: Changes = new Map();

  constructor(readonly store: ProjectStore) {}

  read(rel: string): string | null {
    const f = normalizeRel(rel);
    return this.changes.has(f) ? this.changes.get(f)! : this.store.readText(f);
  }

  readJson(rel: string): unknown {
    const text = this.read(rel);
    if (text === null) throw new ToolError(`File "${normalizeRel(rel)}" does not exist`);
    const r = parseJsonText(normalizeRel(rel), text);
    if (r.error) throw new ToolError(r.error);
    return r.data;
  }

  write(rel: string, content: string) {
    const f = normalizeRel(rel);
    this.store.path(f);
    if (f === '.vibe' || f.startsWith('.vibe/')) throw new ToolError('.vibe/ is managed by the platform and cannot be written');
    if (!f) throw new ToolError('Empty path');
    this.changes.set(f, content);
  }

  writeJson(rel: string, value: unknown) {
    this.write(rel, formatJson(value));
  }

  delete(rel: string) {
    const f = normalizeRel(rel);
    if (this.read(f) === null) throw new ToolError(`File "${f}" does not exist`);
    if (f === PROJECT_FILE) throw new ToolError('project.json cannot be deleted');
    this.write(f, '');
    this.changes.set(f, null);
  }

  /** File that defines scene `id` (considering pending changes). */
  sceneFile(id: string): string {
    const hit = this.store.snapshot(this.changes).scenes.find((s) => s.id === id);
    if (!hit) {
      const ids = this.store.snapshot(this.changes).scenes.map((s) => s.id);
      throw new ToolError(`Scene "${id}" does not exist. Scenes: ${ids.join(', ') || '(none)'}`);
    }
    return hit.file;
  }

  hasScene(id: string) {
    return this.store.snapshot(this.changes).scenes.some((s) => s.id === id);
  }

  scene(id: string): Record<string, unknown> {
    return this.readJson(this.sceneFile(id)) as Record<string, unknown>;
  }

  setScene(id: string, data: Record<string, unknown>) {
    this.writeJson(this.sceneFile(id), data);
  }
}
