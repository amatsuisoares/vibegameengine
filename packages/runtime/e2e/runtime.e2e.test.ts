import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEditingTools, ProjectStore } from '@vibe/server';
import type { VibeApi } from '../src';

declare global {
  interface Window {
    __vibe?: VibeApi;
    __vibeError?: string[];
  }
}

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const RUNS_DIR = repo('test-results/screenshots');
const TMP_PROJECT = repo('projects/e2e-tmp');

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  mkdirSync(RUNS_DIR, { recursive: true });
  rmSync(TMP_PROJECT, { recursive: true, force: true });
  cpSync(repo('test-fixtures/demo-platformer'), TMP_PROJECT, { recursive: true, filter: (src) => !src.includes('.vibe') });
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

async function open(query: string) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${baseUrl}?${query}`);
  await page.waitForFunction(() => window.__vibe?.ready || window.__vibeError, undefined, { timeout: 20_000 });
  return { page, errors };
}

const vibe = <T>(page: Page, fn: (api: VibeApi) => T) =>
  page.evaluate(`(${fn.toString()})(window.__vibe)`) as Promise<T>;

/** RGB of a canvas pixel in viewport coordinates. */
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => {
    const c = document.querySelector('canvas')!;
    return [...c.getContext('2d')!.getImageData(px, py, 1, 1).data.slice(0, 3)];
  }, [Math.round(x), Math.round(y)]);

const shot = (page: Page, name: string) => page.locator('canvas').screenshot({ path: `${RUNS_DIR}/${name}.png` });

describe('runtime page (Chromium)', () => {
  it('loads the demo, its assets, and draws the scene', async () => {
    const { page, errors } = await open('project=e2e-tmp&paused=1');
    expect(await page.evaluate(() => window.__vibeError)).toBeUndefined();
    await vibe(page, (v) => v.advance(500));
    const state = await vibe(page, (v) => v.getState({ ids: ['player', 'coin1'] }));
    const [player, coin] = state.entities;
    const toScreen = (e: { x: number; y: number }) => [e.x - state.camera.x, e.y - state.camera.y] as const;

    expect(await pixel(page, 700, 150)).toEqual([0x1d, 0x2b, 0x53]); // sky = scene background
    expect(await pixel(page, ...toScreen(player))).not.toEqual([0x1d, 0x2b, 0x53]); // hero sprite
    const [cx, cy] = toScreen(coin);
    expect(await pixel(page, cx, cy + 2)).not.toEqual([0x1d, 0x2b, 0x53]); // coin sprite
    expect(await pixel(page, 400, 440)).toEqual([0x5a, 0x3a, 0x22]); // ground rectangle

    const logs = await vibe(page, (v) => v.console());
    expect(logs.filter((l) => l.level !== 'log')).toEqual([]); // no asset or renderer problems
    expect(errors).toEqual([]);
    await shot(page, 'e2e-start');
    await page.close();
  });

  it('loads and decodes the demo sounds', async () => {
    const { page, errors } = await open('project=e2e-tmp');
    await page.waitForFunction(() => /Audio: \d+\/\d+ sounds loaded/.test(document.getElementById('console')!.textContent ?? ''), undefined, {
      timeout: 10_000,
    });
    const line = await page.evaluate(() => document.getElementById('console')!.textContent!.match(/Audio: (\d+)\/(\d+)/)!.slice(1));
    expect(line[0]).toBe(line[1]);
    expect(Number(line[0])).toBeGreaterThan(0);
    expect(await page.locator('#console .error').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('is fully controllable through window.__vibe and shows the outcome', async () => {
    const { page } = await open('project=e2e-tmp&paused=1&debug=1');
    const before = await vibe(page, (v) => v.getState({ ids: ['player'] }).entities[0].x);
    await vibe(page, (v) => v.perform([{ type: 'hold', key: 'D', ms: 1000 }]));
    const after = await vibe(page, (v) => v.getState({ ids: ['player'] }).entities[0].x);
    expect(after).toBeGreaterThan(before + 100);
    await shot(page, 'e2e-debug');

    // Play to the flag with a tiny bot running inside the page.
    const result = await page.evaluate(() => {
      const v = window.__vibe!;
      v.restart();
      v.keyDown('D');
      let lastJump = -99;
      for (let f = 0; f < 60 * 25; f++) {
        const s = v.getState({ tags: ['player', 'enemy', 'ground'] });
        if (s.status !== 'running') break;
        const p = s.entities.find((e) => e.id === 'player')!;
        const enemyAhead = s.entities.some((e) => e.tags.includes('enemy') && e.x > p.x && e.x - p.x < 90 && Math.abs(e.y - p.y) < 40);
        const gapAhead = !s.entities.some((e) => e.tags.includes('ground') && Math.abs(e.x - (p.x + 22)) < e.width! / 2);
        if ((enemyAhead || gapAhead) && p.grounded && f - lastJump > 20) {
          v.keyDown('Space');
          lastJump = f;
        }
        if (f - lastJump === 14) v.keyUp('Space');
        v.step(1);
      }
      return v.getState({ ids: [] }).status;
    });
    expect(result).toBe('won');
    expect(await pixel(page, 5, 400)).not.toEqual([0x1d, 0x2b, 0x53]); // dimmed by the win banner
    await shot(page, 'e2e-won');
    await page.close();
  });

  it('plays in real time with the real keyboard', async () => {
    const { page, errors } = await open('project=e2e-tmp');
    await page.waitForFunction(() => window.__vibe!.getState().frame > 30);
    const x0 = await vibe(page, (v) => v.getState({ ids: ['player'] }).entities[0].x);
    await page.keyboard.down('d');
    await page.waitForTimeout(700);
    await page.keyboard.up('d');
    const x1 = await vibe(page, (v) => v.getState({ ids: ['player'] }).entities[0].x);
    expect(x1).toBeGreaterThan(x0 + 50);
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__vibe!.events(0, 'jump').length > 0, undefined, { timeout: 2000 });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('hot-reloads when project files change and reports invalid edits', async () => {
    const { page } = await open('project=e2e-tmp&paused=1');
    const sceneFile = `${TMP_PROJECT}/scenes/level1.json`;
    const scene = JSON.parse(readFileSync(sceneFile, 'utf8'));
    const count = await vibe(page, (v) => v.getState().entityCount);

    scene.entities = scene.entities.filter((e: { id: string }) => e.id !== 'enemy2');
    writeFileSync(sceneFile, JSON.stringify(scene, null, 2));
    await page.waitForFunction((n) => window.__vibe!.getState().entityCount === n - 1, count, { timeout: 10_000 });

    scene.entities[0].components.Body = { type: 'flying' };
    writeFileSync(sceneFile, JSON.stringify(scene, null, 2));
    await page.waitForFunction(() => !!window.__vibeError, undefined, { timeout: 10_000 });
    const problems = await page.evaluate(() => window.__vibeError!);
    expect(problems.join('\n')).toContain('entities[0](player).components.Body.type');
    // The last valid version keeps running.
    expect(await vibe(page, (v) => v.getState().entityCount)).toBe(count - 1);
    await page.close();
  });

  it('shows agent tool edits live and reverts them with undo', async () => {
    // The previous test leaves the scene invalid on purpose.
    cpSync(repo('test-fixtures/demo-platformer/scenes/level1.json'), `${TMP_PROJECT}/scenes/level1.json`);
    const { page } = await open('project=e2e-tmp&paused=1');
    const store = new ProjectStore(TMP_PROJECT);
    const tools = createEditingTools();
    const call = (name: string, input: unknown) => tools.call(name, input, { store, author: 'agent' });
    const coinCount = () => vibe(page, (v) => v.getState({ tags: ['coin'] }).entities.length);
    const before = await coinCount();

    expect((await call('duplicate_game_object', { scene: 'level1', id: 'coin1', newId: 'coin9', patch: { transform: { x: 300 } } })).ok).toBe(true);
    await page.waitForFunction((n) => window.__vibe!.getState({ tags: ['coin'] }).entities.length === n + 1, before, { timeout: 10_000 });
    const coin = await vibe(page, (v) => v.getState({ ids: ['coin9'] }).entities[0]);
    expect(coin.x).toBe(300);

    expect((await call('undo', {})).ok).toBe(true);
    await page.waitForFunction((n) => window.__vibe!.getState({ tags: ['coin'] }).entities.length === n, before, { timeout: 10_000 });
    await page.close();
  });

  it('lists scenes and entities in the hierarchy panel and shares the selection', async () => {
    cpSync(repo('test-fixtures/demo-platformer/scenes/level1.json'), `${TMP_PROJECT}/scenes/level1.json`);
    rmSync(`${TMP_PROJECT}/.vibe/selection.json`, { force: true });
    const { page, errors } = await open('project=e2e-tmp');
    const panel = page.locator('#hierarchy');
    await panel.locator('[data-entity="coin1"]').waitFor({ timeout: 10_000 });
    expect(await panel.locator('summary').first().textContent()).toContain('atual');
    const ids = await panel.locator('.hierarchy-entity').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.entity));
    expect(ids).toEqual(expect.arrayContaining(['player', 'ground1', 'coin1', 'enemy1', 'flag', 'hud']));

    // Filtering, then selecting: the row is marked, the entity outlined, the agent can read it.
    await panel.locator('input[type=search]').fill('coin');
    expect(await panel.locator('.hierarchy-entity').count()).toBe(4);
    await panel.locator('[data-entity="coin1"]').click();
    await expect.poll(() => panel.locator('[data-entity="coin1"]').getAttribute('aria-selected')).toBe('true');
    const selFile = `${TMP_PROJECT}/.vibe/selection.json`;
    await expect.poll(() => (existsSync(selFile) ? JSON.parse(readFileSync(selFile, 'utf8')) : null), { timeout: 5000 }).toMatchObject({
      version: 1,
      scene: 'level1',
      entity: 'coin1',
    });
    await page.screenshot({ path: `${RUNS_DIR}/hierarchy-selection.png` });

    // Survives a reload; clicking again clears it.
    await page.reload();
    await page.waitForFunction(() => window.__vibe?.ready, undefined, { timeout: 20_000 });
    await expect.poll(() => panel.locator('[data-entity="coin1"]').getAttribute('aria-selected'), { timeout: 5000 }).toBe('true');
    await panel.locator('[data-entity="coin1"]').click();
    await expect.poll(() => existsSync(selFile), { timeout: 5000 }).toBe(false);

    // Hiding the panel is remembered.
    await page.locator('#toggleHierarchy').click();
    expect(await panel.isHidden()).toBe(true);
    await page.locator('#toggleHierarchy').click();
    expect(await panel.isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();

    // Pages driven by a host (screenshots) have no editor panels.
    const host = await open('project=e2e-tmp&paused=1');
    expect(await host.page.locator('#hierarchy').isHidden()).toBe(true);
    expect(await host.page.locator('#toggleHierarchy').isHidden()).toBe(true);
    await host.page.close();
  });

  it('outlines the selected entity on the canvas', async () => {
    const { page } = await open('project=e2e-tmp');
    await page.locator('#hierarchy [data-entity="player"]').waitFor({ timeout: 10_000 });
    await vibe(page, (v) => v.pause());
    await page.locator('#hierarchy [data-entity="player"]').click();
    const cyan = await page.waitForFunction(
      () => {
        const c = document.querySelector('canvas')!;
        const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 40 && data[i + 1] > 200 && data[i + 2] > 230) n++;
        return n > 20 ? n : 0;
      },
      undefined,
      { timeout: 5000 },
    );
    expect(await cyan.jsonValue()).toBeGreaterThan(20);
    await page.locator('#hierarchy [data-entity="player"]').click();
    await page.close();
  });
});

