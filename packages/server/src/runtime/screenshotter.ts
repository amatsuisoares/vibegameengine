import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import type { ClockOptions, GameOp, GameState } from '@vibe/engine';
import type { Browser, Page, Route } from 'playwright';
import { ToolError } from '../project-store';
import { DevServer } from './dev-server';
import type { RawProject } from './session';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

export interface ShotRequest {
  /** Identifies one replayable run; a different key reloads the page. */
  key: string;
  projectName: string;
  raw: RawProject;
  /** Folder that holds the project's assets/. */
  projectDir: string;
  seed: number;
  scene?: string;
  clock?: ClockOptions;
  storage?: Record<string, unknown>;
  ops: GameOp[];
  annotate: boolean;
}

export interface ShotResult {
  png: Buffer;
  state: GameState;
  /** Renderer/asset problems reported by the page (e.g. a sprite whose image failed to load). */
  warnings: string[];
}

declare global {
  interface Window {
    __vibe?: import('@vibe/runtime').VibeApi;
    __vibeError?: string[];
  }
}

/**
 * Renders a headless session in real Chromium: the runtime page is loaded paused with
 * the session's exact project (served through request interception), the session's ops
 * are replayed, and the canvas is captured. The page is kept and only new ops are
 * replayed on the next shot of the same run.
 */
export class Screenshotter {
  private browser?: Browser;
  private page?: Page;
  private loaded?: { key: string; applied: number };

  /** The dev server is shared with the game view (open_game_view). */
  constructor(readonly devServer: DevServer = new DevServer()) {}

  async shoot(req: ShotRequest): Promise<ShotResult> {
    const page = await this.pageFor(req);
    const pending = req.ops.slice(this.loaded!.applied);
    await page.evaluate(
      ([ops, annotate]) => {
        const v = window.__vibe!;
        v.apply(ops as GameOp[]);
        v.setDebug(annotate as boolean);
        v.render();
      },
      [pending, req.annotate] as const,
    );
    this.loaded!.applied = req.ops.length;
    const png = await page.locator('canvas').screenshot();
    const state = await page.evaluate(() => window.__vibe!.getState());
    const logs = await page.evaluate(() => window.__vibe!.console());
    const warnings = [...new Set(logs.filter((l) => l.source === 'renderer' || l.source === 'assets').map((l) => l.message))];
    return { png, state, warnings };
  }

  async close() {
    await this.browser?.close();
    await this.devServer.close();
    this.browser = this.page = this.loaded = undefined;
  }

  private async pageFor(req: ShotRequest): Promise<Page> {
    if (this.page && this.loaded?.key === req.key && this.loaded.applied <= req.ops.length) return this.page;
    const base = await this.devServer.url();
    if (!this.browser) {
      const { chromium } = await import('playwright');
      this.browser = await chromium.launch();
    }
    await this.page?.close();
    const cfg = req.raw.config as { width?: number; height?: number; name?: string };
    const page = await this.browser.newPage({ viewport: { width: (cfg.width ?? 800) + 64, height: (cfg.height ?? 450) + 320 } });
    this.page = page;
    this.loaded = undefined;

    const name = req.projectName;
    // The page builds its game with the run's clock and saved data (not the browser's).
    await page.addInitScript((run) => Object.assign(window, { __vibeRun: run }), { clock: req.clock, storage: req.storage ?? {} });
    await page.route(
      (url) => url.pathname.startsWith('/api/projects') || url.pathname.startsWith(`/projects/${name}/assets/`),
      (route) => this.serve(route, req),
    );
    const q = new URLSearchParams({ project: name, paused: '1', seed: String(req.seed) });
    if (req.scene) q.set('scene', req.scene);
    await page.goto(`${base}?${q}`);
    await page.waitForFunction(() => window.__vibe?.ready || window.__vibeError, undefined, { timeout: 20_000 });
    const error = await page.evaluate(() => window.__vibeError);
    if (error) throw new ToolError('The runtime page could not load the project', error);
    this.loaded = { key: req.key, applied: 0 };
    return page;
  }

  private serve(route: Route, req: ShotRequest) {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const cfg = req.raw.config as { name?: string };
    if (path === '/api/projects') return route.fulfill({ json: [{ name: req.projectName, title: cfg.name ?? req.projectName }] });
    if (path === `/api/projects/${req.projectName}`) return route.fulfill({ json: req.raw });
    const prefix = `/projects/${req.projectName}/assets/`;
    if (path.startsWith(prefix)) {
      const root = resolve(req.projectDir, 'assets');
      const file = resolve(root, path.slice(prefix.length));
      const rel = relative(root, file);
      if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(file) || !statSync(file).isFile()) {
        return route.fulfill({ status: 404, body: 'Not found' });
      }
      return route.fulfill({ body: readFileSync(file), contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
    }
    return route.fulfill({ status: 404, json: { error: `Project "${path.split('/').pop()}" not found` } });
  }
}
