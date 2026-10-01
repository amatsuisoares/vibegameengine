import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VibeApi } from '../src';

declare global {
  interface Window {
    __vibe?: VibeApi;
    __vibeError?: string[];
  }
}

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const NAME = 'e2e-interact';
const DIR = repo(`projects/${NAME}`);

const FILES: Record<string, unknown> = {
  'project.json': { formatVersion: 1, name: 'Interact', width: 400, height: 300, gravity: 0, startScene: 'main' },
  'scenes/main.json': {
    id: 'main',
    width: 400,
    height: 300,
    entities: [
      { id: 'field', transform: { x: 10, y: 10 }, components: { Text: { text: '' }, Script: { src: 'scripts/field.js' } } },
      { id: 'button', transform: { x: 200, y: 200 }, components: { Sprite: { width: 120, height: 40, color: '#3366cc' }, Script: { src: 'scripts/button.js' } } },
    ],
  },
  'scripts/field.js': `
    function onStart(self, game) {
      const saved = game.storage.get('name');
      self.state.name = '';
      if (saved) game.vars.welcome = 'de volta: ' + saved;
    }
    function onUpdate(self, game) {
      for (const ch of game.input.text) {
        if (ch === '\\b') self.state.name = self.state.name.slice(0, -1);
        else if (ch === '\\n') game.storage.set('name', self.state.name);
        else self.state.name += ch;
      }
      self.get('Text').text = self.state.name;
    }`,
  'scripts/button.js': 'function onClick(self, game) { game.vars.clicks = (game.vars.clicks || 0) + 1; }',
};

let server: ViteDevServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  rmSync(DIR, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(FILES)) {
    const file = `${DIR}/${rel}`;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  server = await createServer({ configFile: repo('packages/runtime/vite.config.ts'), configLoader: 'runner', server: { port: 0 }, logLevel: 'error' });
  await server.listen();
  baseUrl = server.resolvedUrls!.local[0];
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(DIR, { recursive: true, force: true });
});

const state = (page: Page) => page.evaluate(() => window.__vibe!.getState({ ids: [], storage: true }));

/** waitForFunction that reports the game state and console when it times out. */
async function waitFor(page: Page, fn: () => boolean) {
  try {
    await page.waitForFunction(fn, undefined, { timeout: 5000 });
  } catch (err) {
    const s = await state(page).catch(() => null);
    const log = await page.textContent('#console').catch(() => '');
    throw new Error(`${(err as Error).message}\nstate: ${JSON.stringify(s?.vars)} storage=${JSON.stringify(s?.storage)}\nconsole: ${log}`);
  }
}

describe('typing, clicking, saved data and the real clock (Chromium)', () => {
  it('types a name with the keyboard, clicks an entity, and keeps saved data across a reload', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${baseUrl}?project=${NAME}`);
    await page.waitForFunction(() => window.__vibe?.ready, undefined, { timeout: 20_000 });

    // The played page runs on the real date.
    const s0 = await state(page);
    expect(Math.abs(s0.clock.now - Date.now())).toBeLessThan(10_000);

    await page.locator('canvas').click({ position: { x: 5, y: 5 } }); // focus the game
    await page.keyboard.type('Mimix');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    await waitFor(page, () => window.__vibe!.getState({ storage: true }).storage?.name === 'Mimi');

    // Click the button: canvas coordinates map to viewport coordinates even when CSS scales the canvas.
    const box = (await page.locator('canvas').boundingBox())!;
    const sx = box.width / 400;
    const sy = box.height / 300;
    await page.mouse.click(box.x + 200 * sx, box.y + 200 * sy);
    await page.mouse.click(box.x + 380 * sx, box.y + 20 * sy); // nothing clickable there
    await waitFor(page, () => window.__vibe!.getState().vars.clicks === 1);

    // The save is on disk: a brand-new browser profile (no localStorage) finds it,
    // like reopening the VS Code Simple Browser.
    await page.waitForTimeout(800); // the disk write is debounced
    await context.close();
    expect(JSON.parse(readFileSync(`${DIR}/.vibe/save.json`, 'utf8'))).toEqual({ name: 'Mimi' });
    const fresh = await browser.newContext();
    const page2 = await fresh.newPage();
    page2.on('pageerror', (e) => errors.push(e.message));
    await page2.goto(`${baseUrl}?project=${NAME}`);
    await page2.waitForFunction(() => window.__vibe?.ready, undefined, { timeout: 20_000 });
    expect((await state(page2)).storage).toEqual({ name: 'Mimi' });
    await waitFor(page2, () => window.__vibe!.getState().vars.welcome === 'de volta: Mimi');

    // "Apagar save" clears it (and restarts with empty data).
    page2.once('dialog', (d) => d.accept());
    await page2.click('#clearSave');
    await waitFor(page2, () => Object.keys(window.__vibe!.getState({ storage: true }).storage ?? {}).length === 0);
    expect(await page2.evaluate(() => localStorage.getItem('vibe:save:e2e-interact'))).toBeNull();
    expect(existsSync(`${DIR}/.vibe/save.json`)).toBe(false);
    expect(errors).toEqual([]);
    await fresh.close();
  });
});
