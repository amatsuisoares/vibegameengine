import { describe, expect, it } from 'vitest';
import { createVibeApi, Runtime, type AssetResolver } from '../src';
import { demoProject, fakeCanvas, manualScheduler, project } from './helpers';

const noAssets: AssetResolver = { resolve: () => 'not loaded in tests' };

function runtime(opts: { paused?: boolean } = {}) {
  const c = fakeCanvas();
  const s = manualScheduler();
  const rt = new Runtime(c.canvas, demoProject(), { scheduler: s.scheduler, assets: noAssets, ...opts });
  return { rt, ...c, sched: s };
}

describe('Runtime', () => {
  it('sizes the canvas to the project viewport and draws immediately', () => {
    const { rt, canvas, calls } = runtime();
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(450);
    expect(calls('fillRect')[0]).toEqual([0, 0, 800, 450]);
    expect(rt.game.frame).toBe(0);
  });

  it('advances in real time while running and not while paused', () => {
    const { rt, sched } = runtime();
    rt.start();
    for (let i = 0; i <= 30; i++) sched.run((i * 1000) / 60);
    expect(rt.game.frame).toBe(30);

    rt.pause();
    for (let i = 31; i <= 60; i++) sched.run((i * 1000) / 60);
    expect(rt.game.frame).toBe(30);

    rt.resume();
    sched.run(5000); // time spent paused is not replayed
    sched.run(5000 + 1000 / 60);
    expect(rt.game.frame).toBe(31);

    rt.stop();
    expect(sched.hasPending).toBe(false);
  });

  it('reports each broken sprite asset once in the game console', () => {
    const { rt } = runtime();
    rt.render();
    rt.render();
    const warnings = rt.game.console.read(0, 'warn').map((e) => e.message);
    expect(warnings).toContain('Sprite of "player": not loaded in tests');
    expect(warnings.filter((m) => m.startsWith('Sprite of "player"'))).toHaveLength(1);
  });

  it('R restarts only after the game is over', () => {
    const { rt } = runtime();
    rt.game.step(10);
    expect(rt.handleShellKey('KeyR')).toBe(false);
    rt.game.world.status = 'lost';
    expect(rt.handleShellKey('KeyR')).toBe(true);
    expect(rt.game.status).toBe('running');
    expect(rt.game.entity('player')!.x).toBe(80);
  });

  it('draws the game-over banner', () => {
    const { rt, calls } = runtime();
    rt.game.world.status = 'won';
    rt.render();
    expect(calls('fillText').map((a) => a[0])).toContain('YOU WIN!');
  });

  it('hot-swaps the project', () => {
    const { rt, canvas } = runtime();
    rt.game.step(20);
    rt.setProject(project([{ id: 'solo', components: { Sprite: {} } }]));
    expect(canvas.width).toBe(400);
    expect(rt.game.frame).toBe(0);
    expect(rt.game.entity('solo')).toBeDefined();
  });
});

describe('window.__vibe API', () => {
  it('drives the game deterministically and returns plain data', () => {
    const { rt } = runtime({ paused: true });
    const api = createVibeApi(rt, 'demo-platformer');
    expect(api.info()).toMatchObject({ project: 'demo-platformer', scenes: ['level1'], width: 800, paused: true });

    const r = api.perform([{ type: 'hold', key: 'D', ms: 1000 }]);
    expect(r).toEqual({ frame: 60, status: 'running', scene: 'level1' });
    const s = api.getState({ ids: ['player'] });
    expect(s.entities[0].x).toBeGreaterThan(200);

    // Same inputs on a fresh runtime give the same state.
    const other = createVibeApi(runtime({ paused: true }).rt, 'demo-platformer');
    other.perform([{ type: 'hold', key: 'D', ms: 1000 }]);
    expect(other.getState({ ids: ['player'] })).toEqual(s);
  });

  it('supports low-level input with explicit stepping', () => {
    const { rt } = runtime({ paused: true });
    const api = createVibeApi(rt, 'demo');
    api.keyDown('Space');
    api.step(10);
    api.keyUp('Space');
    expect(api.events(0, 'jump')).toHaveLength(1);
    expect(api.getState({ ids: ['player'] }).entities[0].y).toBeLessThan(402);
  });

  it('returns copies that callers cannot use to mutate the game', () => {
    const { rt } = runtime({ paused: true });
    const api = createVibeApi(rt, 'demo');
    api.getState().vars.coins = 99;
    expect(rt.game.world.vars.coins).toBe(0);
  });

  it('restarts, reads the console and toggles debug', () => {
    const { rt, calls } = runtime({ paused: true });
    const api = createVibeApi(rt, 'demo');
    api.advance(500);
    expect(api.restart()).toMatchObject({ frame: 0, status: 'running' });
    expect(api.console().some((e) => e.message === 'Game restarted')).toBe(true);
    api.setDebug(true);
    expect(calls('strokeRect').length).toBeGreaterThan(0);
  });
});
