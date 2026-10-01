import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseProject } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { handleProjectRequest, handleSaveRequest, liveRunOfFile, projectOfFile, readProjectDir, resolveInside } from '../vite/project-files';
import { PROJECTS_ROOT } from './helpers';

const get = (url: string) => handleProjectRequest(PROJECTS_ROOT, url);
const json = (url: string) => JSON.parse(String(get(url)!.body));

describe('project files', () => {
  it('resolveInside refuses paths that escape the base', () => {
    expect(resolveInside('/base/dir', 'a/b.png')).toBe(resolve('/base/dir', 'a/b.png'));
    expect(() => resolveInside('/base/dir', '../x')).toThrow(/outside/);
    expect(() => resolveInside('/base/dir', 'a/../../x')).toThrow(/outside/);
    expect(() => resolveInside('/base/dir', '/etc/passwd')).toThrow(/outside/);
    expect(() => resolveInside('/base/dir', '')).toThrow(/outside/);
  });

  it('reads the demo project into a valid project', () => {
    const r = parseProject(readProjectDir(join(PROJECTS_ROOT, 'demo-platformer')));
    expect(r.ok).toBe(true);
  });
});

describe('dev server routes', () => {
  it('lists projects', () => {
    expect(json('/api/projects')).toContainEqual({ name: 'demo-platformer', title: 'Demo Platformer' });
  });

  it('serves a project as raw JSON', () => {
    const body = json('/api/projects/demo-platformer');
    expect(body.config.startScene).toBe('level1');
    expect(Object.keys(body.scenes)).toEqual(['level1']);
  });

  it('serves assets with a content type', () => {
    const r = get('/projects/demo-platformer/assets/hero.svg')!;
    expect(r.status).toBe(200);
    expect(r.type).toBe('image/svg+xml');
    expect(String(r.body)).toContain('<svg');
  });

  it('rejects traversal, unknown projects and missing files', () => {
    expect(get('/projects/demo-platformer/assets/..%2Fproject.json')!.status).toBe(403);
    // The URL parser collapses encoded dot segments before routing, so this never reaches the asset route.
    expect(get('/projects/demo-platformer/assets/%2E%2E/%2E%2E/package.json')?.status ?? 404).not.toBe(200);
    expect(get('/api/projects/..')?.status ?? 404).toBe(404);
    expect(get('/api/projects/a.b')!.status).toBe(404);
    expect(get('/api/projects/nope')!.status).toBe(404);
    expect(get('/projects/demo-platformer/assets/nope.png')!.status).toBe(404);
    expect(get('/index.html')).toBeNull();
  });

  it('maps changed files to their project, ignoring run artifacts', () => {
    expect(projectOfFile(PROJECTS_ROOT, join(PROJECTS_ROOT, 'demo-platformer', 'scenes', 'level1.json'))).toEqual({
      name: 'demo-platformer',
      file: 'scenes/level1.json',
    });
    expect(projectOfFile(PROJECTS_ROOT, join(PROJECTS_ROOT, 'demo-platformer', '.vibe', 'runs', 'a.png'))).toBeNull();
    expect(projectOfFile(PROJECTS_ROOT, join(PROJECTS_ROOT, '..', 'package.json'))).toBeNull();
  });

  it('serves the agent run published in .vibe/live.json, or an inactive one', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibe-live-'));
    try {
      mkdirSync(join(root, 'game', '.vibe'), { recursive: true });
      expect(JSON.parse(String(handleProjectRequest(root, '/api/projects/game/live')!.body))).toEqual({ version: 1, active: false, runId: null });
      writeFileSync(join(root, 'game', '.vibe', 'live.json'), JSON.stringify({ version: 1, active: true, runId: 'run-1', ops: [] }));
      const r = handleProjectRequest(root, '/api/projects/game/live')!;
      expect(r.status).toBe(200);
      expect(JSON.parse(String(r.body)).runId).toBe('run-1');
      expect(handleProjectRequest(root, '/api/projects/a.b/live')!.status).toBe(404);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the saved data of a played game on disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'vibe-save-'));
    try {
      mkdirSync(join(root, 'game'), { recursive: true });
      writeFileSync(join(root, 'game', 'project.json'), '{}');
      const call = (method: string, body?: string) => handleSaveRequest(root, method, '/api/projects/game/save', body)!;
      expect(JSON.parse(String(call('GET').body))).toBeNull();
      expect(call('PUT', JSON.stringify({ pet: { name: 'Mimi' } })).status).toBe(204);
      expect(JSON.parse(String(call('GET').body))).toEqual({ pet: { name: 'Mimi' } });
      expect(call('PUT', '[1,2]').status).toBe(400);
      expect(call('PUT', 'nope').status).toBe(400);
      expect(call('PUT', JSON.stringify({ big: 'x'.repeat(1_100_000) })).status).toBe(413);
      expect(call('PATCH', '{}').status).toBe(405);
      expect(call('DELETE').status).toBe(204);
      expect(JSON.parse(String(call('GET').body))).toBeNull();
      expect(handleSaveRequest(root, 'GET', '/api/projects/nope/save')!.status).toBe(404);
      expect(handleSaveRequest(root, 'GET', '/api/projects/game')).toBeNull();
      // Saves are runtime data: they do not count as project edits (no hot reload).
      expect(projectOfFile(root, join(root, 'game', '.vibe', 'save.json'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognizes the published run file among project files', () => {
    expect(liveRunOfFile(PROJECTS_ROOT, join(PROJECTS_ROOT, 'demo-platformer', '.vibe', 'live.json'))).toBe('demo-platformer');
    expect(liveRunOfFile(PROJECTS_ROOT, join(PROJECTS_ROOT, 'demo-platformer', '.vibe', 'history.jsonl'))).toBeNull();
    expect(liveRunOfFile(PROJECTS_ROOT, join(PROJECTS_ROOT, 'demo-platformer', 'live.json'))).toBeNull();
    expect(projectOfFile(PROJECTS_ROOT, join(PROJECTS_ROOT, 'demo-platformer', '.vibe', 'live.json'))).toBeNull();
  });
});
