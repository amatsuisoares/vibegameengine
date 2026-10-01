/// <reference types="vite/client" />
import { Input, type GameOp, type LogEntry } from '@vibe/engine';
import {
  AssetStore,
  attachDomInput,
  createVibeApi,
  createWebAudioBackend,
  FixedLoop,
  LivePlayer,
  loadHtmlImage,
  Runtime,
  SoundPlayer,
  type AudioBackend,
  type VibeApi,
} from '@vibe/runtime';
import { parseProject, type LiveRun, type Project } from '@vibe/shared';

declare global {
  interface Window {
    __vibe?: VibeApi;
    /** Set when the project could not be loaded, so an external host can report why. */
    __vibeError?: string[];
    /** Follow mode: which agent run is mirrored and how far the replay got. */
    __vibeLive?: () => { runId: string | null; active: boolean; received: number; backlog: number; runFrame?: number };
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
const followBox = $<HTMLInputElement>('follow');
const soundBox = $<HTMLInputElement>('sound');
/** Follow mode: the page mirrors the agent's run (.vibe/live.json) instead of being played. */
const follow = params.get('live') === '1';

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

/**
 * Validates and prepares assets for a project (fetched from disk, or `raw` as given, e.g. the
 * project of the agent's run). Throws with every validation error on failure.
 */
async function loadProject(name: string, raw?: unknown): Promise<{ project: Project; assets: AssetStore; assetErrors: string[] }> {
  raw ??= await fetchJson(`/api/projects/${encodeURIComponent(name)}`);
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
  followBox.checked = follow;
  followBox.onchange = () => {
    if (followBox.checked) params.set('live', '1');
    else params.delete('live');
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

  // Sound: pages driven by a host (screenshots, ?paused=1) stay silent.
  const host = params.get('paused') === '1';
  let audio: AudioBackend | undefined;
  let sound: SoundPlayer | undefined;
  const readMuted = () => {
    try {
      return localStorage.getItem('vibe:muted') === '1';
    } catch {
      return false;
    }
  };
  soundBox.checked = !readMuted();
  soundBox.disabled = host;
  soundBox.onchange = () => {
    sound?.setMuted(!soundBox.checked);
    try {
      localStorage.setItem('vibe:muted', soundBox.checked ? '0' : '1');
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  };
  const setupSound = (project: Project) => {
    if (host) return;
    sound?.stopAll();
    audio ??= createWebAudioBackend();
    const player = new SoundPlayer(project.config.assets, `/projects/${encodeURIComponent(name!)}/assets/`, audio, (m) => appendLog('warn', m));
    player.muted = !soundBox.checked;
    sound = player;
    const count = project.config.assets.filter((a) => a.type === 'audio').length;
    void player.loadAll().then((errors) => {
      errors.forEach((m) => appendLog('error', m));
      if (count) appendLog('log', `Audio: ${count - errors.length}/${count} sounds loaded`);
    });
  };

  const seed = params.has('seed') ? Number(params.get('seed')) : undefined;
  // Follow mode: the runtime stays paused and the agent's ops are played at real-time pace by their own loop.
  let holdLive = false;
  const liveLoop = new FixedLoop((frames) => player.play(frames));
  const runtime = new Runtime(canvas, loaded.project, {
    assets: loaded.assets,
    seed,
    scene: params.get('scene') ?? undefined,
    debug: params.get('debug') === '1',
    paused: follow || params.get('paused') === '1',
    onLog: (e) => appendLog(e.level, e.message, e.frame),
    onTick: follow ? (now) => (holdLive ? liveLoop.reset() : liveLoop.tick(now)) : undefined,
    onEvents: (events, game) => sound?.handle(events, game.frame),
  });
  setupSound(loaded.project);
  const player = new LivePlayer((op) => runtime.game.apply(op));
  const logAssetErrors = (errors: string[]) => errors.forEach((m) => runtime.game.console.error(m, 'assets'));
  logAssetErrors(loaded.assetErrors);
  canvas.classList.toggle('pixelated', loaded.project.config.pixelArt);

  // In follow mode the keyboard must not reach the replayed game (it would diverge from the agent's run).
  const ignoredInput = new Input();
  attachDomInput(() => (follow ? ignoredInput : runtime.game.input), {
    keyTarget: window,
    canvas,
    viewport: () => runtime.project.config,
    onShellKey: (code) => !follow && runtime.handleShellKey(code),
  });

  window.__vibe = createVibeApi(runtime, name);
  runtime.start();
  canvas.focus();

  $<HTMLButtonElement>('restart').onclick = () => (follow ? followRun(true) : runtime.restart());
  pauseBtn.onclick = () => {
    if (follow) holdLive = !holdLive;
    else if (runtime.paused) runtime.resume();
    else runtime.pause();
  };
  $<HTMLButtonElement>('step').onclick = () => {
    if (follow) {
      holdLive = true;
      player.play(1);
    } else {
      runtime.pause();
      runtime.game.step(1);
    }
    runtime.render();
  };
  debugBox.checked = runtime.debug;
  debugBox.onchange = () => {
    runtime.debug = debugBox.checked;
    runtime.render();
  };
  const showStatus = () => {
    const g = runtime.game;
    const paused = follow ? holdLive : runtime.paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    const where = `${g.world.scene.id} · frame ${g.frame} · ${g.status}${paused ? ' · paused' : ''}`;
    statusEl.textContent = !follow
      ? `${where} · ${Math.round(runtime.fps)} fps`
      : !followedRunId
        ? 'Seguindo o agente · aguardando run_game'
        : `Agente${liveRun?.active ? '' : ' (run encerrada)'} · ${where} (run em ${liveRun?.frame ?? '?'})`;
  };
  setInterval(showStatus, 250);

  // Follow mode: mirror the run the agent publishes after every action.
  let liveRun: LiveRun | undefined;
  let followedRunId: string | null = null;
  let liveSeq = 0;
  async function followRun(fromStart = false) {
    const seq = ++liveSeq;
    let run: LiveRun;
    try {
      run = await fetchJson(`/api/projects/${encodeURIComponent(name!)}/live`);
    } catch (err) {
      appendLog('error', `Could not read the agent run: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (seq !== liveSeq) return;
    liveRun = run;
    if (!run.active || !run.runId || !run.raw) return;
    const ops = (run.ops ?? []) as GameOp[];
    if (fromStart || run.runId !== followedRunId || ops.length < player.received) {
      let next;
      try {
        next = await loadProject(name!, run.raw);
      } catch (err) {
        reportLoadError(err);
        return;
      }
      if (seq !== liveSeq) return;
      runtime.setProject(next.project, next.assets, { seed: run.seed, scene: run.scene });
      setupSound(next.project);
      logAssetErrors(next.assetErrors);
      canvas.classList.toggle('pixelated', next.project.config.pixelArt);
      player.reset();
      if (run.runId !== followedRunId) appendLog('log', `Following agent run ${run.runId}`);
      followedRunId = run.runId;
    }
    player.push(ops.slice(player.received));
  }

  if (follow) {
    window.__vibeLive = () => ({
      runId: followedRunId,
      active: !!liveRun?.active,
      received: player.received,
      backlog: player.backlog,
      runFrame: liveRun?.frame,
    });
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    import.meta.hot?.on('vibe:live-changed', (data: { name: string }) => {
      if (data.name !== name) return;
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => followRun(), 30);
    });
    await followRun();
    showStatus();
    return;
  }

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
        const next = await loadProject(name, undefined);
        if (seq !== reloadSeq) return;
        window.__vibeError = undefined;
        runtime.setProject(next.project, next.assets);
        setupSound(next.project);
        logAssetErrors(next.assetErrors);
        appendLog('log', `Project reloaded (${files} changed)`);
      } catch (err) {
        if (seq === reloadSeq) reportLoadError(err);
      }
    }, 80);
  });
}

main().catch(reportLoadError);
