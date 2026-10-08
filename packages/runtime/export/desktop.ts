import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportWeb } from './export';
import { iconPng } from './icon';

/**
 * `vibe package desktop <project>`: the exported game inside an Electron shell (runtime/desktop/main.cjs:
 * game served from app://game/, save in files under the user's data folder, F11 full screen), then
 * electron-builder makes the Windows .exe files: an installer and a portable one.
 *
 *   build/<project>/desktop/app   the Electron app (web/ + main.cjs + preload.cjs + game.json); runnable as is
 *   build/<project>/desktop/dist  the .exe files (and win-unpacked/)
 */

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

export interface DesktopOptions {
  outDir?: string;
  /** Skip electron-builder (only the runnable app folder): tests and quick checks. */
  appOnly?: boolean;
}

export interface DesktopResult {
  appDir: string;
  /** Built .exe files (empty with appOnly). */
  executables: string[];
}

/** Lowercase ASCII id for package names and the app id ("Meu Pet" → "meu-pet"). */
export function appSlug(name: string) {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'game';
}

export async function packageDesktop(projectDir: string, o: DesktopOptions = {}): Promise<DesktopResult> {
  const outDir = o.outDir ?? repo(`build/${basename(resolve(projectDir))}/desktop`);
  const appDir = join(outDir, 'app');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(appDir, { recursive: true });

  const web = await exportWeb(projectDir, join(appDir, 'web'));
  const slug = appSlug(web.game.name);
  for (const f of ['main.cjs', 'preload.cjs']) copyFileSync(repo(`packages/runtime/desktop/${f}`), join(appDir, f));
  writeFileSync(join(appDir, 'game.json'), JSON.stringify(web.game, null, 2));
  // 256×256: what electron-builder needs to make the .exe's icon (and the window's).
  if (web.icon) writeFileSync(join(appDir, 'icon.png'), iconPng(web.icon.sprite, { size: 256, background: web.icon.background }));
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: slug, productName: web.game.title, version: '1.0.0', description: web.game.title, main: 'main.cjs', private: true }, null, 2),
  );
  if (o.appOnly) return { appDir, executables: [] };

  const electronVersion: string = (await import('electron/package.json', { with: { type: 'json' } })).default.version;
  const { build } = await import('electron-builder');
  const files = await build({
    projectDir: appDir,
    publish: 'never',
    config: {
      appId: `com.vibegame.${slug.replaceAll('-', '')}`,
      productName: web.game.title,
      // Reuse the Electron already in node_modules (no download).
      electronVersion,
      electronDist: repo('node_modules/electron/dist'),
      directories: { output: join(outDir, 'dist') },
      files: ['**/*'],
      npmRebuild: false,
      win: { target: ['nsis', 'portable'], ...(web.icon && { icon: join(appDir, 'icon.png') }) },
      nsis: { oneClick: false, allowToChangeInstallationDirectory: true, artifactName: '${productName} Setup ${version}.${ext}' },
      portable: { artifactName: '${productName} ${version}.${ext}' },
    },
  });
  return { appDir, executables: files.filter((f) => f.endsWith('.exe')) };
}
