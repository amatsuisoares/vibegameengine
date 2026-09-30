import type { GameEvent, GameState, InputStep, LogEntry, LogLevel, MouseButton, StateQuery } from '@vibe/engine';
import type { Runtime } from './runtime';

export interface StepResult {
  frame: number;
  status: string;
  scene: string;
}

/**
 * External control surface installed as `window.__vibe`. The RuntimeHost (stage 4)
 * drives it through Playwright's page.evaluate; everything returned is plain JSON.
 *
 * For deterministic runs, load the page with `?paused=1` (or call pause()) and advance
 * only with step/advance/perform: the real-time loop then never moves the simulation.
 */
export interface VibeApi {
  readonly version: 1;
  readonly ready: true;
  info(): { project: string; scenes: string[]; scene: string; width: number; height: number; paused: boolean; debug: boolean };
  pause(): void;
  resume(): void;
  step(frames?: number): StepResult;
  advance(ms: number): StepResult;
  perform(steps: InputStep[]): StepResult;
  keyDown(key: string): void;
  keyUp(key: string): void;
  mouseMove(x: number, y: number): void;
  mouseDown(button?: MouseButton): void;
  mouseUp(button?: MouseButton): void;
  getState(query?: StateQuery): GameState;
  events(sinceFrame?: number, type?: string): GameEvent[];
  console(since?: number, level?: LogLevel): LogEntry[];
  restart(): StepResult;
  loadScene(id: string): StepResult;
  setDebug(on: boolean): void;
  /** Forces a redraw (e.g. before a screenshot). */
  render(): void;
}

export function createVibeApi(runtime: Runtime, projectName: string): VibeApi {
  const result = (): StepResult => ({ frame: runtime.game.frame, status: runtime.game.status, scene: runtime.game.world.scene.id });
  const mutate = (fn: () => void) => {
    fn();
    runtime.render();
    return result();
  };
  const json = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  return {
    version: 1,
    ready: true,
    info: () => ({
      project: projectName,
      scenes: Object.keys(runtime.project.scenes),
      scene: runtime.game.world.scene.id,
      width: runtime.project.config.width,
      height: runtime.project.config.height,
      paused: runtime.paused,
      debug: runtime.debug,
    }),
    pause: () => runtime.pause(),
    resume: () => runtime.resume(),
    step: (frames = 1) => mutate(() => runtime.game.step(frames)),
    advance: (ms) => mutate(() => runtime.game.advance(ms)),
    perform: (steps) => mutate(() => runtime.game.perform(steps)),
    keyDown: (key) => runtime.game.input.keyDown(key),
    keyUp: (key) => runtime.game.input.keyUp(key),
    mouseMove: (x, y) => runtime.game.input.mouseMove(x, y),
    mouseDown: (button) => runtime.game.input.mouseDown(button),
    mouseUp: (button) => runtime.game.input.mouseUp(button),
    getState: (query) => json(runtime.game.getState(query)),
    events: (sinceFrame, type) => json(runtime.game.events(sinceFrame, type)),
    console: (since, level) => json(runtime.game.console.read(since, level)),
    restart: () => mutate(() => runtime.restart()),
    loadScene: (id) => mutate(() => runtime.game.loadScene(id)),
    setDebug: (on) => {
      runtime.debug = on;
      runtime.render();
    },
    render: () => runtime.render(),
  };
}
