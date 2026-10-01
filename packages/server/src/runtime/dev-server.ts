import { fileURLToPath } from 'node:url';
import type { ViteDevServer } from 'vite';

const RUNTIME_VITE_CONFIG = fileURLToPath(new URL('../../../runtime/vite.config.ts', import.meta.url));

/** Port of `npm run dev`; VS Code opens links to it in the Simple Browser (.vscode/settings.json). */
export const VIEW_PORT = 5173;

export type ProbeFn = (baseUrl: string) => Promise<boolean>;

/** True when a VibeGameEngine dev server answers at `baseUrl` (its project API, not just any server). */
export const probeRuntime: ProbeFn = async (baseUrl) => {
  try {
    const res = await fetch(new URL('/api/projects', baseUrl), { signal: AbortSignal.timeout(1500) });
    return res.ok && Array.isArray(await res.json());
  } catch {
    return false;
  }
};

/**
 * The runtime's Vite dev server, started on demand inside this process (once) and shared by
 * screenshots and the game view. It prefers port 5173; when that is taken, Vite picks the next one.
 */
export class DevServer {
  private server?: ViteDevServer;
  private starting?: Promise<string>;

  constructor(
    private readonly port = VIEW_PORT,
    private readonly probe: ProbeFn = probeRuntime,
  ) {}

  /** Base URL of the dev server owned by this process (started on first use). */
  url(): Promise<string> {
    this.starting ??= (async () => {
      const { createServer } = await import('vite');
      this.server = await createServer({
        configFile: RUNTIME_VITE_CONFIG,
        configLoader: 'runner',
        server: { port: this.port, strictPort: false },
        logLevel: 'error',
      });
      await this.server.listen();
      return this.server.resolvedUrls!.local[0];
    })();
    return this.starting.catch((err) => {
      this.starting = undefined;
      throw err;
    });
  }

  /**
   * Where the user should open the game: a dev server already running on the default port
   * (e.g. `npm run dev` or the VS Code task), or else the one owned by this process.
   */
  async viewUrl(): Promise<{ base: string; owned: boolean }> {
    if (!this.server) {
      const base = `http://localhost:${this.port}/`;
      if (await this.probe(base)) return { base, owned: false };
    }
    return { base: await this.url(), owned: true };
  }

  async close() {
    const server = this.server;
    this.server = this.starting = undefined;
    await server?.close();
  }
}
