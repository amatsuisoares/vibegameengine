/// <reference types="vite/client" />
import { Input, type ClockOptions, type GameOp, type LogEntry } from '@vibe/engine';
import {
  AssetStore,
  attachDomInput,
  buildHierarchy,
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
import { HierarchyPanel, type PanelSelection } from './hierarchy-panel';
import { InspectorPanel } from './inspector-panel';
import { ViewportController } from './viewport-controller';

declare global {
  interface Window {
    __vibe?: VibeApi;
    /** Set when the project could not be loaded, so an external host can report why. */
    __vibeError?: string[];
    /** Set by a host (screenshots) before the page loads: the run's clock and saved data. */
    __vibeRun?: { clock?: ClockOptions; storage?: Record<string, unknown> };
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
const clearSaveBtn = $<HTMLButtonElement>('clearSave');
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

  const fixedSeed = params.has('seed') ? Number(params.get('seed')) : undefined;
  const scene = params.get('scene') ?? undefined;

  // Clock and saved data. A page being played uses the real date and keeps game.storage on
  // disk (projects/<name>/.vibe/save.json, through the dev server) — the VS Code Simple Browser
  // does not keep localStorage between sessions — with localStorage as a fallback copy.
  // Pages driven by a host get the run's own clock and data, so the replay matches the headless run.
  const playing = !follow && !host;
  // A played game is never replayed, so each session gets its own randomness (otherwise every
  // new pet, enemy wave... would come out the same). Replays keep the run's seed.
  const seed = fixedSeed ?? (playing ? Math.floor(Math.random() * 2 ** 31) : undefined);
  const saveKey = `vibe:save:${name}`;
  const saveUrl = `/api/projects/${encodeURIComponent(name)}/save`;
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const readLocal = (): Record<string, unknown> => {
    try {
      const data = JSON.parse(localStorage.getItem(saveKey) ?? '{}');
      return isObject(data) ? data : {};
    } catch {
      return {};
    }
  };
  let save: Record<string, unknown> = {};
  if (playing) {
    try {
      const fromDisk = await fetchJson(saveUrl);
      save = isObject(fromDisk) ? fromDisk : readLocal();
    } catch {
      save = readLocal();
    }
  }
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  const flushSave = (keepalive = false) => {
    clearTimeout(pendingWrite);
    pendingWrite = undefined;
    fetch(saveUrl, { method: 'PUT', body: JSON.stringify(save), headers: { 'Content-Type': 'application/json' }, keepalive }).catch((err) =>
      appendLog('warn', `Could not save game data to disk: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
  const writeSave = (data: Record<string, unknown>) => {
    save = data;
    try {
      localStorage.setItem(saveKey, JSON.stringify(data));
    } catch {
      // The disk copy is the one that matters.
    }
    pendingWrite ??= setTimeout(() => flushSave(), 500);
  };
  // Closing the panel or the browser: write whatever is pending.
  addEventListener('pagehide', () => pendingWrite !== undefined && flushSave(true));
  const realClock = (): ClockOptions => ({ start: Date.now(), utcOffsetMinutes: -new Date().getTimezoneOffset() });
  /** Viewport edit mode: the game is paused, gets no input and (re)starts in the scene being edited. */
  let editing = false;
  let editScene: string | undefined;
  let viewport: ViewportController | undefined;
  /** Starts the played game again from the real date and the latest save. */
  const playStart = () => ({ seed, scene: editScene ?? scene, clock: realClock(), storage: save });
  clearSaveBtn.hidden = !playing;
  clearSaveBtn.onclick = async () => {
    if (!confirm('Apagar os dados salvos deste jogo?')) return;
    clearTimeout(pendingWrite);
    pendingWrite = undefined;
    save = {};
    try {
      localStorage.removeItem(saveKey);
    } catch {
      // Nothing saved locally.
    }
    await fetch(saveUrl, { method: 'DELETE' }).catch(() => undefined);
    runtime.setProject(runtime.project, undefined, playStart());
    appendLog('log', 'Saved data cleared');
  };

  // Follow mode: the runtime stays paused and the agent's ops are played at real-time pace by their own loop.
  let holdLive = false;
  const liveLoop = new FixedLoop((frames) => player.play(frames));
  const runtime = new Runtime(canvas, loaded.project, {
    assets: loaded.assets,
    seed,
    scene,
    ...(playing ? { clock: realClock(), storage: save } : (window.__vibeRun ?? {})),
    onStorageChange: playing ? writeSave : undefined,
    realtimeClock: playing,
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
  // Same in edit mode: the mouse selects and moves entities instead of playing.
  attachDomInput(() => (follow || editing ? ignoredInput : runtime.game.input), {
    keyTarget: window,
    canvas,
    viewport: () => runtime.project.config,
    onShellKey: (code) => {
      if (follow || editing || code !== 'KeyR' || runtime.game.status === 'running') return false;
      restartPlay();
      return true;
    },
  });

  window.__vibe = createVibeApi(runtime, name);
  runtime.start();
  canvas.focus();
  if (!host) setupHierarchy(name);

  // Restarting a played game keeps the saved data and the real date (a host page restarts its run).
  function restartPlay() {
    if (playing) runtime.setProject(runtime.project, undefined, playStart());
    else runtime.restart();
  }
  $<HTMLButtonElement>('restart').onclick = () => (follow ? followRun(true) : restartPlay());
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

  /**
   * Hierarchy panel (editor): scenes and entities, live for the current scene. The selection is
   * outlined on the canvas and saved to .vibe/selection.json, so the agent knows what "this" is.
   */
  function setupHierarchy(project: string) {
    const panelEl = $<HTMLElement>('hierarchy');
    const toggleBtn = $<HTMLButtonElement>('toggleHierarchy');
    toggleBtn.hidden = false;
    const selectionUrl = `/api/projects/${encodeURIComponent(project)}/selection`;
    const outline = (sel: PanelSelection | null) => {
      const next = sel?.entity && sel.scene === runtime.game.world.scene.id ? sel.entity : null;
      if (next === runtime.selected) return;
      runtime.selected = next;
      runtime.render();
    };
    const inspectorEl = $<HTMLElement>('inspector');
    const inspectorBtn = $<HTMLButtonElement>('toggleInspector');
    inspectorBtn.hidden = false;
    const inspector = new InspectorPanel(inspectorEl, {
      project,
      live: (scene, id) =>
        scene === runtime.game.world.scene.id ? ((runtime.game.getState({ ids: [id] }).entities[0] as unknown as Record<string, unknown> | undefined) ?? null) : null,
      log: (level, message) => appendLog(level, message),
    });
    const select = (sel: PanelSelection | null) => {
      outline(sel);
      void inspector.show(sel);
      const req = sel
        ? fetch(selectionUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, ...sel, at: Date.now() }) })
        : fetch(selectionUrl, { method: 'DELETE' });
      req.catch((err) => appendLog('warn', `Could not save the selection: ${err instanceof Error ? err.message : String(err)}`));
    };
    const panel = new HierarchyPanel(panelEl, select);
    if (playing) setupViewport(project, (entity) => {
      const sel = entity ? { scene: runtime.game.world.scene.id, entity } : null;
      panel.setSelection(sel);
      select(sel);
    });
    const refresh = () => {
      if (!inspectorEl.hidden) inspector.updateLive();
      if (panelEl.hidden) return;
      panel.update(buildHierarchy(runtime.game, runtime.project));
      // The scene may have changed: only an entity of the current scene is outlined.
      outline(panel.selected);
    };
    const readShown = () => {
      try {
        return localStorage.getItem('vibe:hierarchy') !== '0';
      } catch {
        return true;
      }
    };
    const show = (on: boolean) => {
      panelEl.hidden = !on;
      toggleBtn.classList.toggle('active', on);
      runtime.selected = on ? runtime.selected : null;
      refresh();
      runtime.render();
    };
    toggleBtn.onclick = () => {
      show(panelEl.hidden);
      try {
        localStorage.setItem('vibe:hierarchy', panelEl.hidden ? '0' : '1');
      } catch {
        // Remembered for this page only.
      }
    };
    show(readShown());
    // Inspector: on by default; it follows the hierarchy's selection.
    const showInspector = (on: boolean) => {
      inspectorEl.hidden = !on;
      inspectorBtn.classList.toggle('active', on);
    };
    inspectorBtn.onclick = () => {
      showInspector(inspectorEl.hidden);
      try {
        localStorage.setItem('vibe:inspector', inspectorEl.hidden ? '0' : '1');
      } catch {
        // Remembered for this page only.
      }
    };
    try {
      showInspector(localStorage.getItem('vibe:inspector') !== '0');
    } catch {
      showInspector(true);
    }
    // Any change to the project files (an inspector edit, the agent, an editor): show the new values.
    let inspectTimer: ReturnType<typeof setTimeout> | undefined;
    import.meta.hot?.on('vibe:project-changed', (data: { name: string }) => {
      if (data.name !== project) return;
      clearTimeout(inspectTimer);
      inspectTimer = setTimeout(() => void inspector.refresh(), 120);
    });
    setInterval(refresh, 250);
    // The previous selection (it survives reloads, like the agent's view of it).
    fetchJson(selectionUrl)
      .then((saved: PanelSelection | null) => {
        if (!saved || panel.selected) return;
        panel.setSelection({ scene: saved.scene, entity: saved.entity });
        outline(panel.selected);
        void inspector.show(panel.selected);
      })
      .catch(() => undefined);
  }

  /**
   * Viewport edit mode ("Editar"): the scene as authored (the game restarts in it, paused) seen
   * through an editor camera; clicking selects, dragging moves (saved as a user edit).
   */
  function setupViewport(project: string, select: (entity: string | null) => void) {
    const editBtn = $<HTMLButtonElement>('toggleEdit');
    const stepBtn = $<HTMLButtonElement>('step');
    editBtn.hidden = false;
    let wasPaused = false;
    const vp = new ViewportController({
      runtime,
      canvas,
      select,
      cannotMove: (id) => {
        const scene = runtime.project.scenes[runtime.game.world.scene.id];
        return scene?.entities.some((e) => e.id === id) ? null : `"${id}" was created while the game ran: it is not in the scene file, so it cannot be moved.`;
      },
      move: async (id, dx, dy) => {
        try {
          const res = await fetch(`/api/projects/${encodeURIComponent(project)}/inspect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scene: runtime.game.world.scene.id, id, edit: { action: 'move', dx, dy } }),
          });
          const result = await res.json();
          return result.ok ? null : [result.error, ...(result.details ?? [])].join('\n');
        } catch (err) {
          return `Could not save the move: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
      log: (level, message) => appendLog(level, message),
    });
    viewport = vp;
    editBtn.onclick = () => {
      editing = !editing;
      editBtn.classList.toggle('active', editing);
      canvas.classList.toggle('editing', editing);
      pauseBtn.disabled = stepBtn.disabled = editing;
      if (editing) {
        wasPaused = runtime.paused;
        editScene = runtime.game.world.scene.id;
        runtime.setProject(runtime.project, undefined, playStart());
        runtime.pause();
        vp.enter();
        appendLog('log', 'Modo edição: clique seleciona, arrastar move, roda do mouse dá zoom, arrastar o fundo move a câmera (F centraliza, 0 volta à câmera do jogo)');
      } else {
        vp.exit();
        editScene = undefined;
        if (!wasPaused) runtime.resume();
      }
      canvas.focus();
    };
  }

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
      runtime.setProject(next.project, next.assets, { seed: run.seed, scene: run.scene, clock: run.clock, storage: run.storage });
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
        runtime.setProject(next.project, next.assets, playing ? playStart() : undefined);
        viewport?.onReload();
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
