import { existsSync } from 'node:fs';
import { Game } from '@vibe/engine';
import { describe, expect, it } from 'vitest';
import { ProjectStore, RuntimeHost, Screenshotter, type ShotRequest, type ShotResult } from '../src';
import { createAgentTools } from '../src/tools';
import { demoCopy, fixedClock } from './helpers';

/** Replays the run headless instead of in Chromium (same contract: PNG + replayed state). */
class FakeScreenshotter extends Screenshotter {
  readonly requests: ShotRequest[] = [];
  override async shoot(req: ShotRequest): Promise<ShotResult> {
    this.requests.push({ ...req, ops: [...req.ops] });
    const game = Game.fromRaw(req.raw as Parameters<typeof Game.fromRaw>[0], { seed: req.seed, scene: req.scene, clock: req.clock, storage: req.storage });
    for (const op of req.ops) game.apply(op);
    return { png: Buffer.from('\x89PNG fake'), state: game.getState(), warnings: [] };
  }
}

function setup() {
  const store = new ProjectStore(demoCopy(), { clock: fixedClock });
  const shots = new FakeScreenshotter();
  const host = new RuntimeHost(store, shots);
  const tools = createAgentTools();
  const call = (name: string, input: unknown = {}) => tools.call(name, input, { store, author: 'agent', host });
  return { store, host, shots, call };
}

type Report = {
  scenario: string;
  passed: boolean;
  summary: string;
  report: string[];
  checks: { name?: string; expr: string; pass: boolean; frame: number; step?: number }[];
  screenshots: { label?: string; path?: string; frame: number; step?: number; warning?: string; error?: string }[];
  final: { frame: number; status: string; vars: Record<string, unknown>; simulatedMs: number };
  eventCounts: Record<string, number>;
  errors: string[];
};

describe('verify_game', () => {
  it('plays a scenario, checks it, screenshots it and reports PASS per check', async () => {
    const { call, store, shots } = setup();
    const r = await call('verify_game', {
      scenario: 'player collects the first coin',
      steps: [
        { type: 'wait', ms: 300 },
        { type: 'assert', name: 'player spawned on the ground', expr: "entity('player').grounded" },
        { type: 'keyDown', key: 'D' },
        { type: 'waitUntil', name: 'coin collected', expr: 'vars.coins == 1', maxMs: 3000 },
        { type: 'keyUp', key: 'D' },
        { type: 'screenshot', label: 'after the coin' },
      ],
      assertions: [{ name: 'coin is gone', expr: "!exists('coin1')" }, "events('collect') == 1"],
    });
    if (!r.ok) throw new Error(r.error);
    const v = r.result as Report;
    expect(v.passed).toBe(true);
    expect(v.summary).toBe('PASS: 4/4 checks passed');
    expect(v.report).toEqual(['PASS player spawned on the ground', 'PASS coin collected', 'PASS coin is gone', "PASS events('collect') == 1"]);
    expect(v.final).toMatchObject({ status: 'running', vars: { coins: 1 } });
    expect(v.eventCounts.collect).toBe(1);
    // A screenshot mid-scenario and one of the final frame; both replay the same run without divergence.
    expect(v.screenshots.map((s) => [s.label, s.step])).toEqual([['after the coin', 5], ['final', undefined]]);
    expect(v.screenshots[0].path).toMatch(/^\.vibe\/runs\/run-.*-after-the-coin\.png$/);
    expect(v.screenshots.every((s) => !s.warning && existsSync(store.path(s.path!)))).toBe(true);
    expect(r.images).toHaveLength(2);
    expect(shots.requests.map((q) => q.ops.length)).toEqual([4, 4]); // the final shot comes right after the last step
  });

  it('reports failures with the observed values, timeouts and bad expressions', async () => {
    const { call } = setup();
    const r = await call('verify_game', {
      scenario: 'player reaches the far end',
      screenshot: false,
      steps: [{ type: 'waitUntil', name: 'reached x 2000', expr: "entity('player').x > 2000", maxMs: 500 }],
      assertions: [{ name: 'three coins', expr: 'vars.coins == 3' }, 'vars.coins = 3'],
    });
    if (!r.ok) throw new Error(r.error);
    const v = r.result as Report;
    expect(v.passed).toBe(false);
    expect(v.summary).toBe('FAIL: 0/3 checks passed');
    expect(v.report[0]).toMatch(/^FAIL reached x 2000 — waitUntil entity\('player'\)\.x > 2000; not true after waiting 500 ms; observed entity\("player"\)\.x = 80 \(frame 30\)$/);
    expect(v.report[1]).toBe('FAIL three coins — vars.coins == 3; observed vars.coins = 0 (frame 30)');
    expect(v.report[2]).toMatch(/^FAIL vars.coins = 3 — error: .*Use == for comparison/);
    expect(r.images).toBeUndefined();
  });

  it('fails on runtime errors unless allowed, and does not touch the current run', async () => {
    const { call } = setup();
    expect((await call('write_file', { path: 'scripts/boom.js', content: 'function onUpdate(self) { if (self.game) {} undefinedThing(); }' })).ok).toBe(true);
    expect((await call('create_component', { scene: 'level1', id: 'coin2', type: 'Script', data: { src: 'scripts/boom.js' } })).ok).toBe(true);
    expect((await call('run_game')).ok).toBe(true);
    expect((await call('wait', { ms: 100 })).ok).toBe(true);

    const input = { scenario: 'smoke', screenshot: false, steps: [{ type: 'wait', ms: 200 }], assertions: ["status == 'running'"] };
    const v = (await call('verify_game', input)) as { ok: true; result: Report };
    expect(v.result.passed).toBe(false);
    expect(v.result.summary).toBe('FAIL: 1/1 checks passed, 1 runtime error(s)');
    expect(v.result.report[1]).toMatch(/^FAIL runtime errors \(1\): Script error: .*undefinedThing/);
    const allowed = (await call('verify_game', { ...input, allowErrors: true })) as { ok: true; result: Report };
    expect(allowed.result.passed).toBe(true);
    expect(allowed.result.report[1]).toMatch(/^NOTE runtime errors/);

    const state = await call('inspect_game_state', { ids: [] });
    expect(state.ok && (state.result as { frame: number }).frame).toBe(6);
  });

  it('notes missing checks and failed screenshots without failing the call', async () => {
    const { store, call } = setup();
    const host = new RuntimeHost(store, Object.assign(new Screenshotter(), { shoot: () => Promise.reject(new Error('no browser')) }));
    const r = await createAgentTools().call('verify_game', { scenario: 'just look' }, { store, author: 'agent', host });
    if (!r.ok) throw new Error(r.error);
    const v = r.result as Report;
    expect(v.passed).toBe(true);
    expect(v.report).toEqual(['NOTE no checks: add assertions or assert/waitUntil steps', 'NOTE screenshot "final" failed: no browser']);
    expect(v.screenshots).toEqual([{ label: 'final', frame: 0, error: 'no browser' }]);
    expect((await call('verify_game', { scenario: 'x', steps: Array(6).fill({ type: 'screenshot' }) })).ok).toBe(false);
  });
});
