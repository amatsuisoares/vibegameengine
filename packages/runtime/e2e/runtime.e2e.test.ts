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

  it('keeps the played state on hot reload, with file edits winning', async () => {
    cpSync(repo('test-fixtures/demo-platformer/scenes/level1.json'), `${TMP_PROJECT}/scenes/level1.json`);
    const { page, errors } = await open('project=e2e-tmp');
    // Play deterministically from the page: walk right until coin1 is collected, then stand still.
    const played = await vibe(page, (v) => {
      v.pause();
      v.apply([{ op: 'keyDown', key: 'ArrowRight' }]);
      for (let i = 0; i < 300 && v.getState().vars.coins !== 1; i++) v.step(1);
      v.apply([{ op: 'keyUp', key: 'ArrowRight' }]);
      v.step(40);
      const s = v.getState({ ids: ['player'] });
      return { frame: s.frame, x: s.entities[0].x, coins: s.vars.coins };
    });
    expect(played.coins).toBe(1);

    // An edit (here by the agent, through the store): the game reloads but keeps going.
    const store = new ProjectStore(TMP_PROJECT);
    const move = (x: number) => createEditingTools().call('modify_game_object', { scene: 'level1', id: 'coin2', patch: { transform: { x } } }, { store, author: 'agent' });
    await move(1000);
    const consoleText = () => page.locator('#console').textContent();
    await expect.poll(consoleText, { timeout: 10_000 }).toMatch(/Hot reload: state kept in "level1" \(\d+ entities\); edited: coin2; still destroyed: 1/);
    const after = await vibe(page, (v) => {
      const s = v.getState({ ids: ['player', 'coin1', 'coin2'] });
      return { frame: s.frame, vars: s.vars, ids: s.entities.map((e) => [e.id, e.x]) };
    });
    expect(after.frame).toBe(played.frame);
    expect(after.vars.coins).toBe(1);
    expect(after.ids).toEqual([
      ['player', played.x],
      ['coin2', 1000],
    ]);

    // "Manter estado" off: the reload starts the game over.
    await page.locator('#keepState').uncheck();
    await move(1050);
    await page.waitForFunction(() => window.__vibe!.getState({ ids: ['coin2'] }).entities[0]?.x === 1050, undefined, { timeout: 10_000 });
    const fresh = await vibe(page, (v) => v.getState({ ids: ['coin1'] }));
    expect(fresh.vars.coins).toBe(0);
    expect(fresh.entities.map((e) => e.id)).toEqual(['coin1']);
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

  it('edits the selected entity in the inspector, through the store', async () => {
    cpSync(repo('test-fixtures/demo-platformer/scenes/level1.json'), `${TMP_PROJECT}/scenes/level1.json`);
    rmSync(`${TMP_PROJECT}/.vibe/selection.json`, { force: true });
    const { page, errors } = await open('project=e2e-tmp');
    await page.locator('#hierarchy [data-entity="coin1"]').click();
    const inspector = page.locator('#inspector');
    const width = inspector.locator('[data-section="Sprite"] [data-key="width"] input');
    await width.waitFor({ timeout: 10_000 });
    expect(await width.inputValue()).toBe('16');
    // Live values of the running game.
    await expect.poll(() => inspector.locator('.inspector-live dt').allTextContents()).toContain('x');

    // A valid edit: written to the scene file (as the user) and the game reloads with it.
    await width.fill('40');
    await width.press('Enter');
    const sceneFile = `${TMP_PROJECT}/scenes/level1.json`;
    const coin = () => JSON.parse(readFileSync(sceneFile, 'utf8')).entities.find((e: { id: string }) => e.id === 'coin1');
    await expect.poll(() => coin().components.Sprite.width, { timeout: 5000 }).toBe(40);
    await page.waitForFunction(
      () => (window.__vibe!.getState({ ids: ['coin1'], components: true }).entities[0] as { components?: { Sprite?: { width?: number } } }).components?.Sprite?.width === 40,
      undefined,
      { timeout: 10_000 },
    );
    const history = readFileSync(`${TMP_PROJECT}/.vibe/history.jsonl`, 'utf8').trim().split('\n');
    expect(JSON.parse(history.at(-1)!)).toMatchObject({ author: 'user', reason: 'Inspector: Sprite.width of coin1 = 40' });

    // An invalid edit is rejected: nothing written, the reason is shown, the field goes back.
    await width.fill('-3');
    await width.press('Enter');
    await expect.poll(() => inspector.locator('.inspector-message').textContent()).toMatch(/Sprite\.width/);
    expect(coin().components.Sprite.width).toBe(40);
    await expect.poll(() => width.inputValue()).toBe('40');

    // Enum field and reset to the default.
    await inspector.locator('[data-section="Sprite"] [data-key="shape"] select').selectOption('circle');
    await expect.poll(() => coin().components.Sprite.shape, { timeout: 5000 }).toBe('circle');
    await inspector.locator('[data-section="Sprite"] [data-key="shape"] .reset').click();
    await expect.poll(() => coin().components.Sprite.shape, { timeout: 5000 }).toBeUndefined();

    // Edits by someone else (the agent) show up in the open inspector.
    const store = new ProjectStore(TMP_PROJECT);
    await createEditingTools().call('modify_component', { scene: 'level1', id: 'coin1', type: 'Sprite', patch: { height: 30 } }, { store, author: 'agent' });
    await expect.poll(() => inspector.locator('[data-section="Sprite"] [data-key="height"] input').inputValue(), { timeout: 10_000 }).toBe('30');
    await page.screenshot({ path: `${RUNS_DIR}/inspector.png` });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('selects and moves entities in the viewport edit mode, through the store', async () => {
    cpSync(repo('test-fixtures/demo-platformer/scenes/level1.json'), `${TMP_PROJECT}/scenes/level1.json`);
    rmSync(`${TMP_PROJECT}/.vibe/selection.json`, { force: true });
    const { page, errors } = await open('project=e2e-tmp');
    const frame = () => vibe(page, (api) => api.getState().frame);
    /** Client position of a viewport point (the canvas may be scaled by CSS). */
    const client = async (x: number, y: number) => {
      const r = (await page.locator('canvas').boundingBox())!;
      return { x: r.x + (x * r.width) / 800, y: r.y + (y * r.height) / 450 };
    };
    const sceneFile = `${TMP_PROJECT}/scenes/level1.json`;
    const coin = () => JSON.parse(readFileSync(sceneFile, 'utf8')).entities.find((e: { id: string }) => e.id === 'coin1');
    const selection = () => JSON.parse(readFileSync(`${TMP_PROJECT}/.vibe/selection.json`, 'utf8'));

    await page.locator('#toggleEdit').click();
    // The game restarts in the scene as authored, paused.
    const f0 = await frame();
    await page.waitForTimeout(300);
    expect(await frame()).toBe(f0);
    const cam = await vibe(page, (api) => api.getState().camera);
    const at = { x: 400 - cam.x, y: 390 - cam.y };

    // A click selects (the hierarchy, the inspector and the agent see it).
    let p = await client(at.x, at.y);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => page.locator('#hierarchy [data-entity="coin1"]').getAttribute('class')).toMatch(/selected/);
    await expect.poll(() => selection().entity).toBe('coin1');
    await page.locator('#inspector [data-section="Sprite"]').waitFor({ timeout: 10_000 });

    // A drag moves it: saved to the scene file as the user, and the game reloads with it.
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    const to = await client(at.x + 60, at.y - 20);
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => coin().transform.x, { timeout: 5000 }).not.toBe(400);
    expect(Math.abs(coin().transform.x - 460)).toBeLessThanOrEqual(1);
    expect(Math.abs(coin().transform.y - 370)).toBeLessThanOrEqual(1);
    const moved = coin().transform;
    await page.waitForFunction((x) => window.__vibe!.getState({ ids: ['coin1'] }).entities[0]?.x === x, moved.x, { timeout: 10_000 });
    const history = () => readFileSync(`${TMP_PROJECT}/.vibe/history.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(history().at(-1)).toMatchObject({ author: 'user', tool: 'modify_game_object', reason: expect.stringMatching(/^Viewport: move coin1 by/) });
    // Still paused after the reload.
    const f1 = await frame();
    await page.waitForTimeout(300);
    expect(await frame()).toBe(f1);

    // Arrow keys nudge the selection (Shift = 10 px), saved as one change once they rest.
    const entries = history().length;
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => coin().transform.x, { timeout: 5000 }).toBe(moved.x + 11);
    expect(history().length).toBe(entries + 1);

    // Wheel zoom (editor camera only), then a click on empty space clears the selection.
    p = await client(400, 225);
    await page.mouse.move(p.x, p.y);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
    await page.locator('canvas').screenshot({ path: `${RUNS_DIR}/viewport.png` });
    p = await client(790, 10);
    await page.mouse.click(p.x, p.y);
    await expect.poll(() => (existsSync(`${TMP_PROJECT}/.vibe/selection.json`) ? selection()?.entity ?? null : null)).toBeNull();

    // Leaving edit mode: the game runs again and the mouse plays it.
    await page.locator('#toggleEdit').click();
    const f2 = await frame();
    await expect.poll(frame, { timeout: 5000 }).toBeGreaterThan(f2);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('browses assets, uses one on the selection and places a prefab, through the store', async () => {
    cpSync(repo('test-fixtures/demo-platformer/scenes/level1.json'), `${TMP_PROJECT}/scenes/level1.json`);
    rmSync(`${TMP_PROJECT}/prefabs`, { recursive: true, force: true });
    rmSync(`${TMP_PROJECT}/.vibe/selection.json`, { force: true });
    const store = new ProjectStore(TMP_PROJECT);
    const made = await createEditingTools().call('create_prefab', { id: 'moeda', from: { scene: 'level1', id: 'coin2' }, link: true }, { store, author: 'agent' });
    expect(made.ok).toBe(true);
    const { page, errors } = await open('project=e2e-tmp');
    const panel = page.locator('#assets');
    await page.locator('#toggleAssets').click();

    // Images: thumbnails of the project files, with size and frames.
    const hero = panel.locator('[data-key="asset:hero"]');
    await hero.waitFor({ timeout: 10_000 });
    await expect.poll(() => hero.textContent()).toContain('4×1 quadros');
    await expect.poll(() => hero.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    // Use it on the selected entity: a user edit of Sprite.asset.
    await page.locator('#hierarchy [data-entity="coin1"]').click();
    await hero.click();
    const use = panel.locator('[data-action="use"]');
    await expect.poll(() => use.textContent()).toContain('coin1');
    await expect.poll(() => panel.locator('.asset-frame').count()).toBe(4);
    await use.click();
    const sceneFile = `${TMP_PROJECT}/scenes/level1.json`;
    const entity = (id: string) => JSON.parse(readFileSync(sceneFile, 'utf8')).entities.find((e: { id: string }) => e.id === id);
    await expect.poll(() => entity('coin1').components.Sprite.asset, { timeout: 5000 }).toBe('hero');
    const last = () => JSON.parse(readFileSync(`${TMP_PROJECT}/.vibe/history.jsonl`, 'utf8').trim().split('\n').at(-1)!);
    expect(last()).toMatchObject({ author: 'user', reason: 'Inspector: Sprite.asset of coin1 = "hero"' });

    // Audio: length, the events that play it, a player.
    await panel.locator('[data-tab="audio"]').click();
    const coinSound = panel.locator('[data-key="asset:sfx_coin"]');
    await expect.poll(() => coinSound.textContent()).toContain('collect');
    await coinSound.click();
    await panel.locator('.assets-detail audio').waitFor();

    // Prefabs: place an instance in the scene (selected afterwards).
    await panel.locator('[data-tab="prefabs"]').click();
    await panel.locator('[data-key="prefab:moeda"]').click();
    await panel.locator('[data-action="place"]').click();
    await expect.poll(() => entity('moeda1')?.prefab, { timeout: 5000 }).toBe('moeda');
    expect(last()).toMatchObject({ author: 'user', reason: expect.stringMatching(/^Asset browser: place prefab moeda as moeda1/) });
    await page.waitForFunction(() => window.__vibe!.getState({ ids: ['moeda1'] }).entities.length === 1, undefined, { timeout: 10_000 });
    await expect.poll(() => JSON.parse(readFileSync(`${TMP_PROJECT}/.vibe/selection.json`, 'utf8')).entity).toBe('moeda1');
    // The catalog follows the change: two instances now.
    await expect.poll(() => panel.locator('[data-key="prefab:moeda"]').textContent(), { timeout: 10_000 }).toContain('2 na cena');
    await page.screenshot({ path: `${RUNS_DIR}/assets.png` });
    expect(errors).toEqual([]);
    await page.close();
  });
});

