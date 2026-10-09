import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { packageDesktop } from '../export/desktop';
import type { VibeApi } from '../src';

declare global {
  interface Window {
    __vibe?: VibeApi;
    __vibeError?: string[];
  }
}

// The desktop app (Electron) of a small test game, run from its app folder — the same files the .exe carries.
const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const OUT = repo('test-results/desktop-demo-app');
const SHOTS = repo('test-results/screenshots');
let appDir: string;
let userData: string;

beforeAll(async () => {
  appDir = (await packageDesktop(repo('test-fixtures/demo-app'), { outDir: OUT, appOnly: true })).appDir;
  userData = mkdtempSync(join(tmpdir(), 'vibe-desktop-'));
}, 120_000);

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

// Warnings and errors of the page (a sound or image not loading through app:// shows up here). Electron's
// own CSP warning (only shown for unpackaged apps) is expected: game scripts need 'unsafe-eval'.
const problems: string[] = [];

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), VIBE_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE; // set inside VS Code terminals: would run Electron as plain Node
  const app = await _electron.launch({ args: [appDir], env });
  const page = await app.firstWindow();
  page.on('console', (m) => {
    if ((m.type() === 'error' || m.type() === 'warning') && !m.text().includes('Electron Security Warning')) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  await page.waitForFunction(() => window.__vibe?.ready || window.__vibeError, undefined, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__vibeError)).toBeUndefined();
  return { app, page };
}

describe('desktop app (Electron)', () => {
  it('opens the game in its own window, saves to a file, and after closing and opening again the pet is still there', async () => {
    let { app, page } = await launch();
    expect(await page.title()).toBe('Demo App');
    // The window fits the game (640×360 content); the canvas fills it.
    const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    expect(size).toEqual({ w: 640, h: 360 });

    await page.locator('canvas').click({ position: { x: 5, y: 5 } });
    await page.keyboard.type('Biscoito');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__vibe!.getState().vars.petName === 'Biscoito', undefined, { timeout: 10_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/desktop-demo-app.png` });
    // Nothing goes to localStorage: the save is a file in the user's data folder.
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    await app.close(); // closing the window writes what is pending

    const file = join(userData, 'save', `${encodeURIComponent('vibe:demo-app:save')}.json`);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).pet?.name).toBe('Biscoito');

    ({ app, page } = await launch());
    await page.waitForFunction(() => window.__vibe!.getState().vars.petName === 'Biscoito', undefined, { timeout: 10_000 });
    expect(await page.evaluate(() => window.__vibe!.getState().scene)).toBe('sala');
    await page.waitForTimeout(1000); // sounds finish loading
    await app.close();
    expect(problems).toEqual([]);
  }, 90_000);
});
