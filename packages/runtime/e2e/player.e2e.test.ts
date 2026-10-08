import { readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportWeb } from '../export/export';
import type { VibeApi } from '../src';

declare global {
  interface Window {
    __vibe?: VibeApi;
    __vibeError?: string[];
  }
}

// The exported game (vibe export) served by a plain static server: no Vite, no /api.
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const OUT = repo('test-results/export-meu-pet');
const SHOTS = repo('test-results/screenshots');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.wav': 'audio/wav', '.json': 'application/json' };

let server: Server;
let browser: Browser;
let baseUrl: string;
const requests: string[] = [];

beforeAll(async () => {
  const r = await exportWeb(repo('projects/meu-pet'), OUT);
  expect(r.files).toContain('index.html');
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url!, 'http://x').pathname);
    requests.push(path);
    const file = normalize(join(OUT, path === '/' ? 'index.html' : path));
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}/`;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((ok) => server?.close(ok));
  rmSync(OUT, { recursive: true, force: true });
});

async function open(page: Page) {
  await page.goto(baseUrl);
  await page.waitForFunction(() => window.__vibe?.ready || window.__vibeError, undefined, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__vibeError)).toBeUndefined();
}

describe('exported game (static folder, Chromium)', () => {
  it('plays with no dev server, fills the window with letterbox, and keeps the save on the device across a reload', async () => {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await open(page);
    expect(await page.title()).toBe('Meu Pet');

    // Letterbox: 960×540 scaled to the full width (1200 → 675 tall), centered vertically.
    const box = (await page.locator('canvas').boundingBox())!;
    expect(box.width).toBe(1200);
    expect(box.height).toBe(675);
    expect(box.y).toBe(112);

    // Name the pet with the keyboard (the start scene asks for it).
    await page.locator('canvas').click({ position: { x: 5, y: 5 } });
    await page.keyboard.type('Bolinha');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__vibe!.getState().vars.petName === 'Bolinha', undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => window.__vibe!.getState().scene)).toBe('quarto');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/player-meu-pet.png` });
    // The save went to the device (localStorage), not to a server.
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('vibe:meu-pet:save') ?? '{}'));
    expect(saved.pet?.name).toBe('Bolinha');

    // Closing and opening again: straight back to the room with the same pet.
    await page.reload();
    await open(page);
    await page.waitForFunction(() => window.__vibe!.getState().vars.petName === 'Bolinha', undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => window.__vibe!.getState().scene)).toBe('quarto');

    // A phone-shaped window: the game keeps its proportions (bars at the sides).
    await page.setViewportSize({ width: 800, height: 360 });
    const phone = (await page.locator('canvas').boundingBox())!;
    expect(phone.height).toBe(360);
    expect(phone.width).toBe(640);
    expect(phone.x).toBe(80);

    expect(requests.filter((r) => r.startsWith('/api'))).toEqual([]);
    expect(requests.some((r) => r.startsWith('/assets/'))).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('on a phone (touch): a tap opens the virtual keyboard to name the pet, which closes after; upright asks to turn it', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 360 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page);
    const active = () => page.evaluate(() => document.activeElement?.id ?? '');
    expect(await page.locator('#rotate').isHidden()).toBe(true);

    // Tapping the screen while the game asks for a name focuses the text field (the phone keyboard).
    await page.locator('canvas').tap({ position: { x: 320, y: 120 } });
    expect(await active()).toBe('text');
    await page.keyboard.type('Pipoca');
    // The name field shows what was typed on the phone keyboard.
    const field = () => page.evaluate(() => JSON.stringify(window.__vibe!.getState({ ids: ['campoNome'], components: true }).entities));
    await expect.poll(field).toContain('Pipoca');
    await page.screenshot({ path: `${SHOTS}/player-celular-nome.png` });
    await page.keyboard.press('Backspace');
    await page.keyboard.type('a');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__vibe!.getState().vars.petName === 'Pipoca', undefined, { timeout: 10_000 });
    // The game no longer reads text: the keyboard goes away.
    await page.waitForFunction(() => document.activeElement?.id !== 'text', undefined, { timeout: 5000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${SHOTS}/player-celular.png` });

    // Taps play the game like clicks; the page itself does not zoom or scroll.
    expect(await page.evaluate(() => getComputedStyle(document.body).touchAction)).toBe('none');
    await page.locator('canvas').tap({ position: { x: 320, y: 300 } });
    expect(await active()).not.toBe('text');

    // Held upright: a landscape game asks to turn the phone.
    await page.setViewportSize({ width: 360, height: 800 });
    await expect.poll(() => page.locator('#rotate').isVisible()).toBe(true);
    await page.setViewportSize({ width: 800, height: 360 });
    await expect.poll(() => page.locator('#rotate').isHidden()).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  it('inside the Android app (Capacitor bridge): the save goes to the Preferences plugin, written when the app is paused', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 360 } });
    // What the Capacitor native bridge injects: the app's plugins and nativePromise (here backed by a Map).
    await context.addInitScript(() => {
      const prefs = new Map<string, string>();
      const calls: string[] = [];
      Object.assign(window, {
        __prefs: prefs,
        __prefCalls: calls,
        Capacitor: {
          isNativePlatform: () => true,
          PluginHeaders: [{ name: 'Preferences' }],
          nativePromise: async (plugin: string, method: string, o: { key: string; value?: string }) => {
            calls.push(`${plugin}.${method}`);
            if (method === 'get') return { value: prefs.get(o.key) ?? null };
            if (method === 'set') prefs.set(o.key, o.value!);
            return undefined;
          },
        },
      });
    });
    const page = await context.newPage();
    await open(page);
    await page.locator('canvas').click({ position: { x: 5, y: 5 } });
    await page.keyboard.type('Nina');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__vibe!.getState().vars.petName === 'Nina', undefined, { timeout: 10_000 });
    // Capacitor fires "pause" on the document when the app goes to the background: the save is written at once.
    await page.evaluate(() => document.dispatchEvent(new Event('pause')));
    const saved = await page.evaluate(() => (window as unknown as { __prefs: Map<string, string> }).__prefs.get('vibe:meu-pet:save'));
    expect(JSON.parse(saved!).pet?.name).toBe('Nina');
    expect(await page.evaluate(() => localStorage.getItem('vibe:meu-pet:save'))).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { __prefCalls: string[] }).__prefCalls[0])).toBe('Preferences.get');
    await context.close();
  });
});
