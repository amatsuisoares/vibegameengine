import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createVibeMcpServer, Workspace } from '../src';

const DEMO = fileURLToPath(new URL('../../../test-fixtures/demo-platformer', import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** An MCP client connected in-process to a server over a temporary projects folder. */
async function connect(projects: string[] = ['demo-platformer']) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-mcp-'));
  for (const name of projects) cpSync(DEMO, join(root, name), { recursive: true, filter: (s) => !s.includes('.vibe') });
  const workspace = new Workspace(root);
  const server = createVibeMcpServer(workspace);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(async () => {
    await client.close();
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = (r: CallToolResult) => (r.content[0] as { text: string }).text;
  const json = async (name: string, args?: Record<string, unknown>) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(text(r));
    return JSON.parse(text(r).split('\n')[0]);
  };
  return { root, client, call, text, json };
}

describe('MCP server', () => {
  it('describes itself and lists every tool with annotations', async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toContain('VibeGameEngine');
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(tools.length).toBe(62);
    for (const name of ['list_projects', 'create_project', 'get_project_summary', 'create_game_object', 'run_game', 'take_screenshot', 'run_test', 'verify_game', 'run_playbooks', 'save_playbook', 'observe', 'get_mouse_target', 'drag_mouse', 'press_mouse', 'release_mouse', 'undo']) {
      expect(byName[name], name).toBeDefined();
    }
    expect(byName.get_scene.annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(byName.wait.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(byName.delete_game_object.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect(byName.create_game_object.inputSchema).toMatchObject({ type: 'object', required: ['scene', 'entity'] });
  });

  it('opens the only project automatically and keeps the run across calls', async () => {
    const { json, text, call } = await connect();
    expect((await json('get_project_summary')).name).toBe('demo-platformer');
    await json('run_game');
    await json('press_key', { key: 'D' });
    const after = await json('wait', { ms: 2000 });
    expect(after.frame).toBe(120);
    expect(after.events.map((e: { type: string }) => e.type)).toContain('collect');

    // Edits come back as a readable diff after the JSON summary.
    const edit = await call('modify_game_object', { scene: 'level1', id: 'enemy1', patch: { name: 'Bob' }, reason: 'rename' });
    expect(text(edit)).toMatch(/^\{"changed":true,"historySeq":1\}\n--- a\/scenes\/level1\.json/);
  });

  it('requires choosing a project when there are several, and creates new ones', async () => {
    const { json, call, text, root } = await connect(['alpha', 'beta']);
    const noProject = await call('get_project_summary');
    expect(noProject.isError).toBe(true);
    expect(text(noProject)).toContain('No project is open');

    expect(await json('open_project', { name: 'beta' })).toMatchObject({ opened: 'beta', valid: true });
    expect((await json('list_projects')).find((p: { name: string }) => p.name === 'beta').open).toBe(true);

    expect(await json('create_project', { name: 'cat-game', title: 'Cat Game', sceneWidth: 3000 })).toMatchObject({ created: 'cat-game' });
    expect(existsSync(join(root, 'cat-game', 'scenes', 'main.json'))).toBe(true);
    const summary = await json('get_project_summary');
    expect(summary).toMatchObject({ name: 'cat-game', valid: true, config: { name: 'Cat Game', startScene: 'main' } });
    expect((await call('create_project', { name: 'cat-game' })).isError).toBe(true);
    expect(text(await call('create_project', { name: '../escape' }))).toContain('Invalid project name');
  });

  it('reports invalid input and tool errors as MCP errors', async () => {
    const { call, text } = await connect();
    const bad = await call('modify_game_object', { scene: 'level1' });
    expect(bad.isError).toBe(true);
    expect(JSON.parse(text(bad)).error).toBe('Invalid input for modify_game_object');
    const missing = await call('wait', { ms: 10 });
    expect(JSON.parse(text(missing)).error).toContain('run_game');
  });
});
