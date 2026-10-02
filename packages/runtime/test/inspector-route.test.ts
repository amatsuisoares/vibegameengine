import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleInspectRequest } from '../vite/project-files';
import { FIXTURES_ROOT } from './helpers';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function copy() {
  root = mkdtempSync(join(tmpdir(), 'vibe-inspect-'));
  cpSync(join(FIXTURES_ROOT, 'demo-platformer'), join(root, 'game'), { recursive: true, filter: (src) => !src.includes('.vibe') });
  return root;
}

const body = (r: { body: string | Buffer } | null) => JSON.parse(String(r!.body));

describe('inspector route', () => {
  it('describes an entity and applies edits as the user', async () => {
    const dir = copy();
    const get = await handleInspectRequest(dir, 'GET', '/api/projects/game/inspect?scene=level1&id=coin1');
    expect(get!.status).toBe(200);
    expect(body(get).sections.map((s: { id: string }) => s.id)).toContain('Collectible');

    const post = await handleInspectRequest(
      dir,
      'POST',
      '/api/projects/game/inspect',
      JSON.stringify({ scene: 'level1', id: 'coin1', edit: { action: 'set', section: 'Sprite', key: 'width', value: 20 } }),
    );
    expect(post!.status).toBe(200);
    expect(body(post)).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(join(dir, 'game', 'scenes', 'level1.json'), 'utf8')).toMatch(/"width": 20/);
    const history = readFileSync(join(dir, 'game', '.vibe', 'history.jsonl'), 'utf8');
    expect(JSON.parse(history.trim().split('\n').at(-1)!)).toMatchObject({ author: 'user', tool: 'modify_game_object' });
  });

  it('reports rejected edits and bad requests', async () => {
    const dir = copy();
    const post = (b: unknown) => handleInspectRequest(dir, 'POST', '/api/projects/game/inspect', typeof b === 'string' ? b : JSON.stringify(b));
    const bad = await post({ scene: 'level1', id: 'coin1', edit: { action: 'set', section: 'Sprite', key: 'width', value: -1 } });
    expect(bad!.status).toBe(200);
    expect(body(bad)).toMatchObject({ ok: false, error: expect.stringMatching(/rejected/i) });
    expect((await post('nope'))!.status).toBe(400);
    expect((await post({ scene: 'level1', id: 'coin1', edit: { action: 'explode' } }))!.status).toBe(400);
    expect((await handleInspectRequest(dir, 'GET', '/api/projects/game/inspect?scene=level1&id=ghost'))!.status).toBe(404);
    expect((await handleInspectRequest(dir, 'GET', '/api/projects/game/inspect?scene=level1'))!.status).toBe(400);
    expect((await handleInspectRequest(dir, 'GET', '/api/projects/nope/inspect?scene=a&id=b'))!.status).toBe(404);
    expect((await handleInspectRequest(dir, 'DELETE', '/api/projects/game/inspect'))!.status).toBe(405);
    expect(await handleInspectRequest(dir, 'GET', '/api/projects/game/save')).toBeNull();
  });
});
