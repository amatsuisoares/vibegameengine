/// <reference types="vite/client" />
/// <reference path="./virtual-game.d.ts" />
// Player of an exported game: only the game, full window (letterbox), no editor and no dev server.
// The project comes embedded in the bundle (virtual:vibe-game, written by `vibe export`); assets sit
// next to the page in assets/; the save lives on the device (SaveStore).
import { audioVoices, type ClockOptions } from '@vibe/engine';
import {
  AssetStore,
  capacitorPreferencesBackend,
  attachDomInput,
  attachTextField,
  createVibeApi,
  createWebAudioBackend,
  fitViewport,
  loadHtmlImage,
  Runtime,
  SaveStore,
  SoundPlayer,
  webStorageBackend,
  type CapacitorBridge,
  type KeyValueBackend,
  type VibeApi,
} from '@vibe/runtime';
import { parseProject } from '@vibe/shared';
import game from 'virtual:vibe-game';

declare global {
  interface Window {
    __vibe?: VibeApi;
    __vibeError?: string[];
    /** A host (the Android app) can set where the save goes before the page loads; default: localStorage. */
    __vibeSaveBackend?: KeyValueBackend;
    /** Injected by the Android app (Capacitor native bridge). */
    Capacitor?: CapacitorBridge;
  }
}

const canvas = document.getElementById('game') as HTMLCanvasElement;
const errorEl = document.getElementById('error') as HTMLElement;
const textEl = document.getElementById('text') as HTMLInputElement;
const rotateEl = document.getElementById('rotate') as HTMLElement;
const ASSETS = 'assets/';

function fail(details: string[]) {
  window.__vibeError = details;
  errorEl.textContent = `Não foi possível abrir o jogo:\n${details.join('\n')}`;
  errorEl.hidden = false;
}

async function main() {
  document.title = game.title;
  const parsed = parseProject(game.project);
  if (!parsed.ok) return fail(parsed.errors);
  const project = parsed.value;
  const { width, height } = project.config;
  canvas.classList.toggle('pixelated', project.config.pixelArt);

  const assets = new AssetStore(project.config.assets, ASSETS, loadHtmlImage);
  const report = await assets.loadAll();

  // Where the save lives: the desktop app's files, the Android app's Preferences, else localStorage.
  const backend = window.__vibeSaveBackend ?? capacitorPreferencesBackend(window.Capacitor) ?? webStorageBackend(localStorage);
  const store = new SaveStore(backend, `vibe:${game.name}`, { onError: (m) => console.warn(m) });
  const saved = await store.load();
  let storage = saved.storage;
  let slots = saved.slots;

  const audio = createWebAudioBackend();
  const sound = new SoundPlayer(project.config.assets, ASSETS, audio, (m) => console.warn(m));
  void sound.loadAll().then((errors) => errors.forEach((m) => console.warn(m)));

  // Real date, the latest save and fresh randomness each session (a played game is never replayed).
  const realClock = (): ClockOptions => ({ start: Date.now(), utcOffsetMinutes: -new Date().getTimezoneOffset() });
  const seed = () => Math.floor(Math.random() * 2 ** 31);
  let textField: ReturnType<typeof attachTextField> | undefined;
  const runtime = new Runtime(canvas, project, {
    assets,
    seed: seed(),
    clock: realClock(),
    storage,
    slots,
    realtimeClock: true,
    onStorageChange: (data) => {
      storage = data;
      store.writeStorage(data);
    },
    onSlotsChange: (data) => {
      slots = data;
      store.writeSlots(data);
    },
    onLog: (e) => e.level === 'error' && console.error(e.message),
    onEvents: (events, g) => sound.handle(events, g.frame),
    onFrame: (g) => {
      sound.updateVoices(audioVoices(g.world));
      textField?.sync();
    },
  });
  for (const e of report.errors) runtime.game.console.error(`Asset "${e.id}": ${e.message}`, 'assets');

  attachDomInput(() => runtime.game.input, {
    keyTarget: window,
    canvas,
    viewport: () => project.config,
    onShellKey: (code) => {
      if (code !== 'KeyR' || runtime.game.status === 'running') return false;
      runtime.setProject(project, undefined, { seed: seed(), clock: realClock(), storage, slots });
      return true;
    },
  });

  // Touch screens: the phone keyboard for names and other typed text.
  textField = attachTextField(() => runtime.game.input, canvas, textEl);

  const touchScreen = matchMedia('(pointer: coarse)').matches;
  const layout = () => {
    const box = fitViewport(innerWidth, innerHeight, width, height);
    Object.assign(canvas.style, { width: `${box.width}px`, height: `${box.height}px`, left: `${box.left}px`, top: `${box.top}px` });
    // A landscape game on a phone held upright: ask to turn it (not while the keyboard squeezes the window).
    rotateEl.hidden = !(touchScreen && width > height && innerHeight > innerWidth && !textField?.open);
  };
  addEventListener('resize', layout);
  layout();

  // A phone suspends the app without unloading the page: save when it goes to the background.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void store.flush();
  });
  addEventListener('pagehide', () => void store.flush());
  document.addEventListener('pause', () => void store.flush()); // Capacitor: the Android app went to the background

  window.__vibe = createVibeApi(runtime, game.name);
  runtime.start();
  canvas.focus();
}

main().catch((err) => fail([err instanceof Error ? err.message : String(err)]));
