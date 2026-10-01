import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type Obs = {
  frame: number;
  status: string;
  keysDown: string[];
  players?: { id: string; x: number; y: number; grounded?: boolean }[];
  events: { type: string; frame: number }[];
  console: { level: string; message: string }[];
  projectChanged?: string;
};
type Check = { expr: string; pass: boolean; observed?: Record<string, unknown>; error?: string; waitedMs?: number };
type TestReport = { passed: boolean; checks: Check[]; final: { status: string; vars: Record<string, unknown> }; eventCounts: Record<string, number> };

describe('runtime tools', () => {
  it('requires a running game', async () => {
    const { fail } = setup();
    expect((await fail('wait', { ms: 100 })).error).toBe('No game is running. Call run_game first.');
  });

  it('runs, takes keyboard input and reports what happened', async () => {
    const { ok } = setup();
    const start = await ok<Obs & { runId: string; viewport: object }>('run_game');
    expect(start).toMatchObject({ frame: 0, status: 'running', viewport: { width: 800, height: 450 } });
    expect(start.players![0].id).toBe('player');

    expect(await ok('press_key', { key: 'd' })).toEqual({ keysDown: ['D'] });
    const moved = await ok<Obs>('wait', { ms: 2000 });
    expect(moved.frame).toBe(120);
    expect(moved.players![0].x).toBeGreaterThan(200);
    expect(moved.events.map((e) => e.type)).toEqual(['collect', 'sound']); // coin1 sits on the way (+ its sound); scene_loaded was already reported
    await ok('release_key', { key: 'D' });

    const jump = await ok<Obs>('perform_inputs', { steps: [{ type: 'tap', key: 'Space' }, { type: 'wait', ms: 100 }] });
    expect(jump.events.map((e) => e.type)).toEqual(['jump', 'sound']); // only events since the last observation (the jump and its sound)
    expect(jump.players![0].grounded).toBe(false);
  });

  it('waits until a condition holds', async () => {
    const { ok } = setup();
    await ok('run_game');
    await ok('press_key', { key: 'D' });
    const r = await ok<Obs & { ok: boolean; waitedMs: number }>('wait_until', { expr: 'vars.coins >= 1', maxMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.waitedMs).toBeGreaterThan(500);
    const timeout = await ok<{ ok: boolean }>('wait_until', { expr: "status == 'won'", maxMs: 200 });
    expect(timeout.ok).toBe(false);
  });

  it('inspects state, events and console', async () => {
    const { ok } = setup();
    await ok('run_game');
    await ok('wait', { ms: 500 });
    const state = await ok<{ entities: { id: string; components?: object }[]; vars: object }>('inspect_game_state', { ids: ['enemy1'], components: true });
    expect(state.entities).toHaveLength(1);
    expect(state.entities[0].components).toHaveProperty('Patrol');
    expect(await ok('read_events', { type: 'scene_loaded' })).toMatchObject({ total: 1 });
    const logs = await ok<{ message: string }[]>('read_console');
    expect(logs[0].message).toContain('Scene "level1" loaded');
  });

  it('flags runs that use an outdated project and restarts with the latest version', async () => {
    const { ok } = setup();
    await ok('run_game');
    await ok('modify_game_object', { scene: 'level1', id: 'player', patch: { transform: { x: 200 } } });
    const stale = await ok<Obs>('wait', { ms: 100 });
    expect(stale.projectChanged).toContain('restart_game');
    const fresh = await ok<Obs>('restart_game');
    expect(fresh.projectChanged).toBeUndefined();
    expect(fresh.players![0].x).toBe(200);
  });

  it('refuses to run an invalid project', async () => {
    const { ok, fail, dir } = setup();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(`${dir}/scenes/level1.json`, '{"id": "level1", "camera": {"follow": "ghost"}}');
    const r = await fail('run_game');
    expect(r.error).toBe('Cannot run: the project is invalid');
    expect(r.details![0]).toContain('"ghost" does not exist');
    expect((await fail('run_game', { scene: 'nope' })).ok).toBe(false);
    void ok;
  });

  it('caps long waits', async () => {
    const { ok, fail } = setup();
    await ok('run_game');
    expect((await fail('wait', { ms: 600_000 })).details![0]).toContain('ms');
    expect((await fail('perform_inputs', { steps: [{ type: 'wait', ms: 40_000 }, { type: 'wait', ms: 40_000 }] })).error).toContain('split');
  });
});

describe('run_test', () => {
  it('passes a scripted playthrough and reports observed values', async () => {
    const { ok } = setup();
    const r = await ok<TestReport>('run_test', {
      steps: [
        { type: 'wait', ms: 300 },
        { type: 'assert', expr: "entity('player').grounded" },
        { type: 'keyDown', key: 'D' },
        { type: 'waitUntil', expr: 'vars.coins == 1', maxMs: 3000 },
        { type: 'keyUp', key: 'D' },
      ],
      assertions: ["status == 'running'", "entity('player').x > 300", "events('collect') == 1"],
    });
    expect(r.passed).toBe(true);
    expect(r.checks).toHaveLength(5);
    expect(r.checks[1].waitedMs).toBeGreaterThan(0);
    expect(r.checks[3].observed!["entity(\"player\").x"]).toBeGreaterThan(300);
    expect(r.final.vars.coins).toBe(1);
    expect(r.eventCounts.collect).toBe(1);
  });

  it('reports failures with the values that made them fail, and bad expressions', async () => {
    const { ok } = setup();
    const r = await ok<TestReport>('run_test', {
      steps: [{ type: 'hold', key: 'D', ms: 500 }],
      assertions: ["entity('player').x > 2000", 'vars.coins = 3', "entity('ghost').health > 0"],
    });
    expect(r.passed).toBe(false);
    expect(r.checks[0]).toMatchObject({ pass: false, observed: { "entity(\"player\").x": expect.any(Number) } });
    expect(r.checks[1].error).toContain('Use == for comparison');
    expect(r.checks[2]).toMatchObject({ pass: false, observed: { "entity(\"ghost\").health": null } });
  });

  it('does not touch the current run', async () => {
    const { ok } = setup();
    await ok('run_game');
    await ok('wait', { ms: 200 });
    await ok('run_test', { steps: [{ type: 'wait', ms: 3000 }] });
    expect(await ok<{ frame: number }>('inspect_game_state', { ids: [] })).toMatchObject({ frame: 12 });
  });
});
