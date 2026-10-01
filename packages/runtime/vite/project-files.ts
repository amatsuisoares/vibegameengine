import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { ProjectStore, removeFile, ToolError, writeFileAtomic, type RawProjectData } from '@vibe/server';
import { LIVE_RUN_FILE } from '@vibe/shared';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

/** Node-side access to project folders (projects/<name>/project.json + scenes/*.json + assets/). */

export const PROJECT_NAME = /^[A-Za-z0-9_-]+$/;

/** Resolves `rel` inside `base`, refusing anything that escapes it (../, absolute paths). */
export function resolveInside(base: string, rel: string): string {
  const root = resolve(base);
  const full = resolve(root, rel);
  const r = relative(root, full);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) throw new Error(`Path "${rel}" is outside ${root}`);
  return full;
}

export function listProjects(projectsRoot: string): { name: string; title: string }[] {
  if (!existsSync(projectsRoot)) return [];
  return readdirSync(projectsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && PROJECT_NAME.test(d.name) && existsSync(join(projectsRoot, d.name, 'project.json')))
    .map((d) => {
      let title = d.name;
      try {
        title = JSON.parse(readFileSync(join(projectsRoot, d.name, 'project.json'), 'utf8')).name ?? d.name;
      } catch {
        // Broken project.json: still listed so the error surfaces when it is opened.
      }
      return { name: d.name, title };
    });
}

/**
 * Reads a project folder into the raw `{ config, scenes }` shape through the ProjectStore
 * (not validated; the page validates so it can show the errors).
 */
export function readProjectDir(dir: string): RawProjectData {
  try {
    return new ProjectStore(dir).rawProject();
  } catch (err) {
    if (err instanceof ToolError && err.details.length) throw new Error(err.details.join('\n'));
    throw err;
  }
}

export const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

export interface HttpResult {
  status: number;
  type: string;
  body: string | Buffer;
}

const jsonResult = (status: number, value: unknown): HttpResult => ({
  status,
  type: 'application/json; charset=utf-8',
  body: JSON.stringify(value),
});

/**
 * Routes:
 *   GET /api/projects                  -> [{ name, title }]
 *   GET /api/projects/<name>           -> { config, scenes } (raw) | 500 { error }
 *   GET /api/projects/<name>/live      -> the agent's published run (LiveRun) | { active: false }
 *   GET /projects/<name>/assets/<path> -> asset file
 * Returns null for any other URL.
 */
export function handleProjectRequest(projectsRoot: string, url: string): HttpResult | null {
  const path = decodeURIComponent(new URL(url, 'http://x').pathname);
  if (path === '/api/projects') return jsonResult(200, listProjects(projectsRoot));

  let m = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (m) {
    const name = m[1];
    if (!PROJECT_NAME.test(name) || !existsSync(join(projectsRoot, name, 'project.json'))) {
      return jsonResult(404, { error: `Project "${name}" not found` });
    }
    try {
      return jsonResult(200, readProjectDir(join(projectsRoot, name)));
    } catch (err) {
      return jsonResult(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  m = /^\/api\/projects\/([^/]+)\/live$/.exec(path);
  if (m) {
    const name = m[1];
    if (!PROJECT_NAME.test(name)) return jsonResult(404, { error: 'Not found' });
    const file = join(projectsRoot, name, LIVE_RUN_FILE);
    try {
      return { status: 200, type: 'application/json; charset=utf-8', body: readFileSync(file, 'utf8') };
    } catch {
      return jsonResult(200, { version: 1, active: false, runId: null });
    }
  }

  m = /^\/projects\/([^/]+)\/assets\/(.+)$/.exec(path);
  if (m) {
    const [, name, rel] = m;
    if (!PROJECT_NAME.test(name)) return jsonResult(404, { error: 'Not found' });
    let file: string;
    try {
      file = resolveInside(join(projectsRoot, name, 'assets'), rel);
    } catch {
      return jsonResult(403, { error: 'Forbidden' });
    }
    if (!existsSync(file) || !statSync(file).isFile()) return jsonResult(404, { error: `Asset "${rel}" not found` });
    return { status: 200, type: MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', body: readFileSync(file) };
  }
  return null;
}

/** Where a played game keeps its saved data (game.storage) on disk. */
export const SAVE_FILE = '.vibe/save.json';
export const MAX_SAVE_BYTES = 1024 * 1024;

/**
 * Saved data of a played game, kept on disk so it survives closing the browser (the
 * VS Code Simple Browser does not keep localStorage between sessions):
 *   GET    /api/projects/<name>/save -> the saved object, or null
 *   PUT    /api/projects/<name>/save -> stores a JSON object (204)
 *   DELETE /api/projects/<name>/save -> removes it (204)
 * Returns null for any other URL.
 */
export function handleSaveRequest(projectsRoot: string, method: string, url: string, body = ''): HttpResult | null {
  const m = /^\/api\/projects\/([^/]+)\/save$/.exec(decodeURIComponent(new URL(url, 'http://x').pathname));
  if (!m) return null;
  const name = m[1];
  if (!PROJECT_NAME.test(name) || !existsSync(join(projectsRoot, name, 'project.json'))) {
    return jsonResult(404, { error: `Project "${name}" not found` });
  }
  const file = join(projectsRoot, name, SAVE_FILE);
  if (method === 'GET') {
    if (!existsSync(file)) return jsonResult(200, null);
    return { status: 200, type: 'application/json; charset=utf-8', body: readFileSync(file, 'utf8') };
  }
  if (method === 'PUT' || method === 'POST') {
    if (body.length > MAX_SAVE_BYTES) return jsonResult(413, { error: `Save is too large (max ${MAX_SAVE_BYTES} bytes)` });
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      return jsonResult(400, { error: 'Save must be JSON' });
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return jsonResult(400, { error: 'Save must be a JSON object' });
    writeFileAtomic(file, JSON.stringify(data));
    return { status: 204, type: 'text/plain', body: '' };
  }
  if (method === 'DELETE') {
    removeFile(file);
    return { status: 204, type: 'text/plain', body: '' };
  }
  return jsonResult(405, { error: `Method ${method} not allowed` });
}

/** Project name of a file inside projects/<name>/, ignoring runtime artifacts in .vibe/. */
export function projectOfFile(projectsRoot: string, file: string): { name: string; file: string } | null {
  const r = relative(resolve(projectsRoot), resolve(file)).split(/[\\/]/);
  if (r.length < 2 || r[0] === '..' || !PROJECT_NAME.test(r[0]) || r[1] === '.vibe') return null;
  return { name: r[0], file: r.slice(1).join('/') };
}

/** Project name when `file` is the agent's published run (projects/<name>/.vibe/live.json). */
export function liveRunOfFile(projectsRoot: string, file: string): string | null {
  const r = relative(resolve(projectsRoot), resolve(file)).split(/[\\/]/);
  return r.length === 3 && PROJECT_NAME.test(r[0]) && `${r[1]}/${r[2]}` === LIVE_RUN_FILE ? r[0] : null;
}
