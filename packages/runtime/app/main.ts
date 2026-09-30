/// <reference types="vite/client" />
import type { LogEntry } from '@vibe/engine';
import { AssetStore, attachDomInput, createVibeApi, loadHtmlImage, Runtime, type VibeApi } from '@vibe/runtime';
import { parseProject, type Project } from '@vibe/shared';

declare global {
  interface Window {
    __vibe?: VibeApi;
    /** Set when the project could not be loaded, so an external host can report why. */
    __vibeError?: string[];
  }
}

const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('game');
const consoleEl = $<HTMLElement>('console');
const statusEl = $<HTMLElement>('status');
const projectSelect = $<HTMLSelectElement>('project');
const pauseBtn = $<HTMLButtonElement>('pause');
const debugBox = $<HTMLInputElement>('debug');

const MAX_CONSOLE_LINES = 300;

function appendLog(level: LogEntry['level'], message: string, frame?: number) {
  const line = document.createElement('div');
  line.className = level;
  if (frame !== undefined) {
    const f = document.createElement('span');
    f.className = 'frame';
    f.textContent = `[${frame}] `;
    line.append(f);
  }
  line.append(message);
  consoleEl.append(line);
  while (consoleEl.childElementCount > MAX_CONSOLE_LINES) consoleEl.firstElementChild?.remove();
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

async function fetchJson(url: string) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `${url}: HTTP ${res.status}`);
  return body;
}

/** Loads, validates and prepares assets. Throws with every validation error on failure. */
async function loadProject(name: string): Promise<{ project: Project; assets: AssetStore; assetErrors: string[] }> {
  const raw = await fetchJson(`/api/projects/${encodeURIComponent(name)}`);
  const parsed = parseProject(raw);
  if (!parsed.ok) throw Object.assign(new Error('Invalid project'), { details: parsed.errors });
  for (const w of parsed.warnings) appendLog('warn', w);
  const assets = new AssetStore(parsed.value.config.assets, `/projects/${encodeURIComponent(name)}/assets/`, loadHtmlImage);
  const report = await assets.loadAll();
  return { project: parsed.value, assets, assetErrors: report.errors.map((e) => `Asset "${e.id}": ${e.message}`) };
}

function reportLoadError(err: unknown) {
  const details: string[] = (err as { details?: string[] }).details ?? [err instanceof Error ? err.message : String(err)];
  window.__vibeError = details;
  appendLog('error', `Could not load project:\n${details.join('\n')}`);
}

async function main() {
  const projects: { name: string; title: string }[] = await fetchJson('/api/projects');
  const name = params.get('project') ?? projects[0]?.name;
  for (const p of projects) projectSelect.add(new Option(p.title, p.name, false, p.name === name));
  projectSelect.onchange = () => {
    params.set('project', projectSelect.value);
    location.search = params.toString();
  };
  if (!name) {
    appendLog('error', 'No projects found in projects/');
    return;
  }

  let loaded;
  try {
    loaded = await loadProject(name);
  } catch (err) {
    reportLoadError(err);
    return;
  }

  const seed = params.has('seed') ? Number(params.get('seed')) : undefined;
  const runtime = new Runtime(canvas, loaded.project, {
    assets: loaded.assets,
    seed,
    scene: params.get('scene') ?? undefined,
    debug: params.get('debug') === '1',
    paused: params.get('paused') === '1',
    onLog: (e) => appendLog(e.level, e.message, e.frame),
  });
  const logAssetErrors = (errors: string[]) => errors.forEach((m) => runtime.game.console.error(m, 'assets'));
  logAssetErrors(loaded.assetErrors);
  canvas.classList.toggle('pixelated', loaded.project.config.pixelArt);

  attachDomInput(() => runtime.game.input, {
    keyTarget: window,
    canvas,
    viewport: () => runtime.project.config,
    onShellKey: (code) => runtime.handleShellKey(code),
  });

  window.__vibe = createVibeApi(runtime, name);
  runtime.start();
  canvas.focus();

  $<HTMLButtonElement>('restart').onclick = () => runtime.restart();
  pauseBtn.onclick = () => (runtime.paused ? runtime.resume() : runtime.pause());
  $<HTMLButtonElement>('step').onclick = () => {
    runtime.pause();
    runtime.game.step(1);
    runtime.render();
  };
  debugBox.checked = runtime.debug;
  debugBox.onchange = () => {
    runtime.debug = debugBox.checked;
    runtime.render();
  };
  setInterval(() => {
    const g = runtime.game;
    pauseBtn.textContent = runtime.paused ? 'Resume' : 'Pause';
    statusEl.textContent = `${g.world.scene.id} · frame ${g.frame} · ${g.status}${runtime.paused ? ' · paused' : ''} · ${Math.round(runtime.fps)} fps`;
  }, 250);

  // Hot reload: when a file of this project changes on disk, reload and restart it.
  // One save can emit several change events, and loads can finish out of order: bursts are
  // debounced and only the newest load is applied.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadSeq = 0;
  const changed = new Set<string>();
  import.meta.hot?.on('vibe:project-changed', (data: { name: string; file: string }) => {
    if (data.name !== name) return;
    changed.add(data.file);
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      const seq = ++reloadSeq;
      const files = [...changed].join(', ');
      changed.clear();
      try {
        const next = await loadProject(name);
        if (seq !== reloadSeq) return;
        window.__vibeError = undefined;
        runtime.setProject(next.project, next.assets);
        logAssetErrors(next.assetErrors);
        appendLog('log', `Project reloaded (${files} changed)`);
      } catch (err) {
        if (seq === reloadSeq) reportLoadError(err);
      }
    }, 80);
  });
}

main().catch(reportLoadError);
