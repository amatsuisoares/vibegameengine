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
});
