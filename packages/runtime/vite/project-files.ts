import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

function readJson(dir: string, file: string): unknown {
  const text = readFileSync(join(dir, file), 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Reads a project folder into the raw `{ config, scenes }` shape (not validated;
 * validation happens where the project is used so errors can be shown there).
 */
export function readProjectDir(dir: string): { config: unknown; scenes: Record<string, unknown> } {
  const config = readJson(dir, 'project.json');
  const scenes: Record<string, unknown> = {};
  const scenesDir = join(dir, 'scenes');
  if (existsSync(scenesDir)) {
    for (const f of readdirSync(scenesDir).sort()) {
      if (!f.endsWith('.json')) continue;
      const scene = readJson(dir, `scenes/${f}`) as { id?: unknown };
      // Keyed by the id inside the file; fall back to the file name so a missing id is reported by validation.
      const key = typeof scene?.id === 'string' ? scene.id : f.slice(0, -5);
      scenes[key] = scene;
    }
  }
  return { config, scenes };
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

/** Project name of a file inside projects/<name>/, ignoring runtime artifacts in .vibe/. */
export function projectOfFile(projectsRoot: string, file: string): { name: string; file: string } | null {
  const r = relative(resolve(projectsRoot), resolve(file)).split(/[\\/]/);
  if (r.length < 2 || r[0] === '..' || !PROJECT_NAME.test(r[0]) || r[1] === '.vibe') return null;
  return { name: r[0], file: r.slice(1).join('/') };
}
