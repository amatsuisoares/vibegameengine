import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Game, type GameOp } from '@vibe/engine';
import type { LiveRun } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { DevServer, ProjectStore, RuntimeHost, Screenshotter } from '../src';
import { createAgentTools } from '../src/tools';
import { demoCopy, fixedClock, setup } from './helpers';

const readLive = (dir: string) => JSON.parse(readFileSync(join(dir, '.vibe', 'live.json'), 'utf8')) as LiveRun;

describe('published agent run (follow mode)', () => {
  it('is written after every action that changes the run, and replays to the same state', async () => {
    const { dir, ok, call, host } = setup();
    await call('inspect_game_state');
    expect(existsSync(join(dir, '.vibe', 'live.json'))).toBe(false);

    const { runId } = await ok<{ runId: string }>('run_game');
    expect(readLive(dir)).toMatchObject({ version: 1, active: true, runId, seed: 1, frame: 0, ops: [] });

    await ok('perform_inputs', { steps: [{ type: 'hold', key: 'D', ms: 500 }, { type: 'tap', key: 'Space' }] });
    await call('wait_until', { expr: 'frame >= 60', maxMs: 2000 });
    const live = readLive(dir);
    expect(live.frame).toBe(host.session!.game.frame);
    expect(live.ops).toEqual(host.session!.ops);

    const replay = Game.fromRaw(live.raw, { seed: live.seed, scene: live.scene });
    (live.ops as GameOp[]).forEach((op) => replay.apply(op));
    expect(replay.getState()).toEqual(host.session!.game.getState());

    // Reading tools do not rewrite it; stopping marks it inactive.
    await ok('inspect_game_state');
    await ok('stop_game');
    expect(readLive(dir)).toEqual({ version: 1, active: false, runId: null });
  });

  it('a new run (restart) gets a new id', async () => {
    const { dir, ok } = setup();
    const first = (await ok<{ runId: string }>('run_game')).runId;
    await ok('wait', { ms: 100 });
    await ok('restart_game');
    const live = readLive(dir);
    expect(live.runId).not.toBe(first);
    expect(live.ops).toEqual([]);
  });
});

describe('open_game_view', () => {
  function withProbe(running: boolean) {
    const store = new ProjectStore(demoCopy(), { clock: fixedClock });
    const devServer = new DevServer(5173, async () => running);
    const host = new RuntimeHost(store, new Screenshotter(devServer));
    const tools = createAgentTools();
    return { store, call: (input: unknown) => tools.call('open_game_view', input, { store, host, author: 'agent' }) };
  }

  it('points at the dev server already running on the default port', async () => {
    const { store, call } = withProbe(true);
    const r = await call({});
    expect(r.ok).toBe(true);
    const result = (r as { result: { url: string; server: string } }).result;
    expect(result.url).toBe(`http://localhost:5173/?project=${store.name}`);
    expect(result.server).toMatch(/already running/);

    const follow = await call({ follow: true, debug: true, scene: 'level1' });
    expect((follow as { result: { url: string } }).result.url).toBe(`http://localhost:5173/?project=${store.name}&scene=level1&live=1&debug=1`);
  });

  it('rejects unknown scenes', async () => {
    const { call } = withProbe(true);
    const r = await call({ scene: 'nope' });
    expect(r).toMatchObject({ ok: false, error: 'Scene "nope" does not exist' });
  });
});
