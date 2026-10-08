import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '@vibe/server';
import { build, type Plugin } from 'vite';
import { decodePng, iconPng, type Rgba } from './icon';

/**
 * `vibe export <project>`: turns a project into a static web folder that plays the game with no dev
 * server — index.html + one JS bundle (player + engine + the project, validated here) + assets/.
 * Any static server, Electron or a Capacitor WebView can open it.
 */

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const VIRTUAL = 'virtual:vibe-game';

export interface ExportResult {
  outDir: string;
  /** Files written (relative to outDir). */
  files: string[];
  assets: number;
  /** Project folder name, window title and viewport size (for the app shells). */
  game: { name: string; title: string; width: number; height: number };
  /** The app icon's sprite (config.app.icon) and background, for the app shells; null without one. */
  icon: { sprite: Rgba; background: string } | null;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

export function defaultExportDir(projectDir: string) {
  return repo(`build/${basename(resolve(projectDir))}/web`);
}

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = join(dir, d.name);
    return d.isDirectory() ? listFiles(full, base) : [full.slice(base.length + 1).replaceAll('\\', '/')];
  });
}

export async function exportWeb(projectDir: string, outDir = defaultExportDir(projectDir)): Promise<ExportResult> {
  const store = new ProjectStore(projectDir);
  const status = store.validate();
  if (status.errors.length || !status.project) throw new Error(`The project has errors:\n${status.errors.join('\n')}`);
  const raw = store.rawProject();
  const name = basename(resolve(projectDir));
  const game = { name, title: status.project.config.name ?? name, project: raw };

  const embed: Plugin = {
    name: 'vibe-embed-game',
    resolveId: (id) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
    load: (id) => (id === `\0${VIRTUAL}` ? `export default ${JSON.stringify(game)};` : null),
  };
  rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: false,
    logLevel: 'error',
    root: repo('packages/runtime/player'),
    base: './',
    resolve: {
      alias: {
        '@vibe/shared': repo('packages/shared/src/index.ts'),
        '@vibe/engine': repo('packages/engine/src/index.ts'),
        '@vibe/runtime': repo('packages/runtime/src/index.ts'),
      },
    },
    plugins: [embed],
    build: { outDir, emptyOutDir: true, assetsDir: 'js', chunkSizeWarningLimit: 4096 },
  });

  // The assets the project declares, with the same paths (the player loads them from assets/).
  const assetsDir = join(projectDir, 'assets');
  let assets = 0;
  for (const a of status.project.config.assets) {
    const from = join(assetsDir, a.path);
    if (!existsSync(from)) throw new Error(`Asset "${a.id}": ${a.path} not found in ${assetsDir}`);
    const to = join(outDir, 'assets', a.path);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    assets++;
  }
  const { width, height, app } = status.project.config;

  // The page shows the title (tab and loading screen) before its script runs; the icon is the tab's/home screen's.
  let icon: ExportResult['icon'] = null;
  let head = `<title>${escapeHtml(game.title)}</title>`;
  if (app?.icon) {
    const asset = status.project.config.assets.find((a) => a.id === app.icon)!;
    let sprite: Rgba;
    try {
      sprite = decodePng(readFileSync(join(assetsDir, asset.path)));
    } catch (err) {
      throw new Error(`config.app.icon: ${asset.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    icon = { sprite, background: app.iconBackground };
    writeFileSync(join(outDir, 'icon.png'), iconPng(sprite, { size: 192, background: app.iconBackground }));
    head += '\n    <link rel="icon" href="icon.png" />\n    <link rel="apple-touch-icon" href="icon.png" />';
  }
  const page = join(outDir, 'index.html');
  writeFileSync(
    page,
    readFileSync(page, 'utf8')
      .replace(/<title>.*<\/title>/, head)
      .replace(
        '<div id="loading-title"></div>',
        `${icon ? '<img id="loading-icon" src="icon.png" alt="" />' : ''}<div id="loading-title">${escapeHtml(game.title)}</div>`,
      ),
  );
  return { outDir, files: listFiles(outDir), assets, game: { name, title: game.title, width, height }, icon };
}
