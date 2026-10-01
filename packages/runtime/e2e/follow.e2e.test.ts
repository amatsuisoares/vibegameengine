import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentTools, ProjectStore, RuntimeHost } from '@vibe/server';
import type { VibeApi } from '../src';

declare global {
  interface Window {
    __vibe?: VibeApi;
    __vibeError?: string[];
    __vibeLive?: () => { runId: string | null; active: boolean; received: number; backlog: number; runFrame?: number };
  }
}

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const RUNS_DIR = repo('projects/demo-platformer/.vibe/runs');
const NAME = 'e2e-follow';
const TMP_PROJECT = repo(`projects/${NAME}`);

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  mkdirSync(RUNS_DIR, { recursive: true });
  rmSync(TMP_PROJECT, { recursive: true, force: true });
  cpSync(repo('projects/demo-platformer'), TMP_PROJECT, { recursive: true, filter: (src) => !src.includes('.vibe') });
  server = await createServer({ configFile: repo('packages/runtime/vite.config.ts'), configLoader: 'runner', server: { port: 0 }, logLevel: 'error' });
  await server.listen();
  baseUrl = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(TMP_PROJECT, { recursive: true, force: true });
});

function agent() {
  const store = new ProjectStore(TMP_PROJECT);
  const host = new RuntimeHost(store);
  const tools = createAgentTools();
  const ok = async <T = Record<string, unknown>>(name: string, input: unknown = {}) => {
    const r = await tools.call(name, input, { store, host, author: 'agent' });
    if (!r.ok) throw new Error(`${name} failed: ${r.error}`);
    return r.result as T;
  };
  return { host, ok };
}

/** Waits until the page replayed the whole published run, then returns its state. */
async function caughtUp(page: Page, runId: string, frame: number) {
  await page.waitForFunction(
    ([id, f]) => {
      const live = window.__vibeLive!();
      return live.runId === id && live.backlog === 0 && window.__vibe!.getState({ ids: [] }).frame === f;
    },
    [runId, frame] as const,
    { timeout: 20_000 },
  );
  return page.evaluate(() => window.__vibe!.getState());
}

describe('follow mode (Chromium)', () => {
  it('mirrors the agent run in real time, follows restarts and ignores the keyboard', async () => {
    const { host, ok } = agent();
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${baseUrl}?project=${NAME}&live=1`);
    await page.waitForFunction(() => window.__vibeLive, undefined, { timeout: 20_000 });
    expect(await page.textContent('#status')).toBe('Seguindo o agente · aguardando run_game');

    const { runId } = await ok<{ runId: string }>('run_game');
    await ok('perform_inputs', {
      steps: [{ type: 'keyDown', key: 'D' }, { type: 'wait', ms: 550 }, { type: 'tap', key: 'Space', ms: 150 }, { type: 'wait', ms: 600 }, { type: 'keyUp', key: 'D' }],
    });
    // Real keys pressed in the panel must not reach the mirrored game.
    await page.keyboard.down('KeyA');
    const t0 = Date.now();
    const mirrored = await caughtUp(page, runId, host.session!.game.frame);
    await page.keyboard.up('KeyA');
    expect(mirrored.entities).toEqual(host.session!.game.getState().entities);
    expect(mirrored.vars).toEqual({ coins: 1, score: 100 });
    // 78 frames are played at real-time pace, not instantly.
    expect(Date.now() - t0).toBeGreaterThan(700);
    await page.locator('canvas').screenshot({ path: `${RUNS_DIR}/e2e-follow.png` });

    const second = (await ok<{ runId: string }>('restart_game')).runId;
    await ok('wait', { ms: 300 });
    const restarted = await caughtUp(page, second, 18);
    expect(restarted.vars.coins).toBe(0);

    await ok('stop_game');
    await page.waitForFunction(() => !window.__vibeLive!().active, undefined, { timeout: 10_000 });
    expect(errors).toEqual([]);
    await page.close();
  });
});
