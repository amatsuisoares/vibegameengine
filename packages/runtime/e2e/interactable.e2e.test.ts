import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VibeApi } from '../src';

declare global {
  interface Window {
    __vibe?: VibeApi;
  }
}

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const NAME = 'e2e-interactable';
const DIR = repo(`projects/${NAME}`);
const SHOTS = repo('test-results/screenshots');

// A player that walks with A/D next to a door (E opens it) and a lamp you click.
const FILES: Record<string, unknown> = {
  'project.json': { formatVersion: 1, name: 'Interactable', width: 400, height: 300, gravity: 0, startScene: 'main' },
  'scenes/main.json': {
    id: 'main',
    width: 400,
    height: 300,
    background: '#203040',
    vars: { opened: 0 },
    entities: [
      { id: 'player', tags: ['player'], transform: { x: 100, y: 150 }, components: { Sprite: { width: 20, height: 20, color: '#ffcc00' }, Collider: { width: 20, height: 20 }, Script: { src: 'scripts/walk.js' } } },
      { id: 'door', transform: { x: 200, y: 150 }, components: { Sprite: { width: 40, height: 60, color: '#8b5a2b' }, Interactable: { action: 'open', label: 'Abrir', via: ['key'] } } },
      { id: 'lamp', transform: { x: 330, y: 60 }, components: { Sprite: { width: 30, height: 30, color: '#88ccff' }, Interactable: { action: 'toggle', via: ['click'], cooldownMs: 300 }, Script: { src: 'scripts/lamp.js' } } },
    ],
    rules: [{ id: 'open', when: { event: 'interact', match: { action: 'open' } }, do: [{ action: 'addVar', var: 'opened', amount: 1 }] }],
  },
  'scripts/walk.js': `function onUpdate(self, game, dt) {
    if (game.input.isDown('right')) self.x += 120 * dt;
    if (game.input.isDown('left')) self.x -= 120 * dt;
  }`,
  'scripts/lamp.js': `function onInteract(self, by, game) {
    const s = self.get('Sprite');
    s.color = s.color === '#88ccff' ? '#ffffff' : '#88ccff';
  }`,
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
  mkdirSync(SHOTS, { recursive: true });
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

const interactions = (page: Page) => page.evaluate(() => window.__vibe!.events(0, 'interact').map((e) => `${e.entity}:${e.via}`));

describe('Interactable in the browser (Chromium)', () => {
  it('opens a door with the real keyboard when close, shows the prompt, and toggles a lamp with the real mouse', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${baseUrl}?project=${NAME}`);
    await page.waitForFunction(() => window.__vibe?.ready, undefined, { timeout: 20_000 });
    await page.locator('canvas').click({ position: { x: 5, y: 5 } }); // focus the game

    // Too far: E does nothing.
    await page.keyboard.press('E');
    await page.waitForTimeout(100);
    expect(await interactions(page)).toEqual([]);

    // Walk right until the door is in range, then E.
    await page.keyboard.down('D');
    await page.waitForFunction(() => window.__vibe!.getState().entities.find((e) => e.id === 'door')?.interactable?.inRange.includes('player'), undefined, { timeout: 5000 });
    await page.keyboard.up('D');
    await page.locator('canvas').screenshot({ path: `${SHOTS}/interactable-prompt.png` });
    await page.keyboard.press('E');
    await page.waitForFunction(() => window.__vibe!.getState().vars.opened === 1, undefined, { timeout: 5000 });

    // Click the lamp (canvas coordinates scale with the CSS size of the canvas).
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.click(box.x + (330 * box.width) / 400, box.y + (60 * box.height) / 300);
    await page.waitForFunction(() => window.__vibe!.events(0, 'interact').length === 2, undefined, { timeout: 5000 });
    expect(await interactions(page)).toEqual(['door:key', 'lamp:click']);
    expect(await page.evaluate(() => (window.__vibe!.getState({ ids: ['lamp'], components: true }).entities[0].components!.Sprite as { color: string }).color)).toBe('#ffffff');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('the page API clicks entities by id, reproducing the headless run', async () => {
    const page = await browser.newPage();
    await page.goto(`${baseUrl}?project=${NAME}&paused=1`);
    await page.waitForFunction(() => window.__vibe?.ready, undefined, { timeout: 20_000 });
    const r = await page.evaluate(() => {
      window.__vibe!.perform([{ type: 'click', entity: 'lamp' }, { type: 'wait', ms: 100 }, { type: 'click', entity: 'lamp' }, { type: 'wait', ms: 400 }, { type: 'click', entity: 'lamp' }]);
      return window.__vibe!.events().filter((e) => e.type.startsWith('interact')).map((e) => `${e.type}:${e.reason ?? ''}`);
    });
    expect(r).toEqual(['interact:', 'interact_blocked:cooldown', 'interact:']);
    await page.close();
  });
});
