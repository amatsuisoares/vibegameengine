/**
 * The agent's current game run, published by the RuntimeHost to `projects/<name>/.vibe/live.json`
 * after every action so the runtime page can mirror it ("follow the agent" mode).
 *
 * A run is replayable: the same raw project, seed and start scene plus the same ops give the same
 * state. `ops` only grows while `runId` stays the same; a new run gets a new id.
 */
export interface LiveRun {
  version: 1;
  /** False after stop_game (or when the agent switched projects); the page keeps the last frame. */
  active: boolean;
  runId: string | null;
  seed?: number;
  scene?: string;
  /** Clock options and saved data the run started with (see GameClock / GameStorage). */
  clock?: { start?: number | string; utcOffsetMinutes?: number; speed?: number };
  storage?: Record<string, unknown>;
  /** Save slots the run started with. */
  slots?: Record<string, unknown>;
  /** Frame of the headless run after the last action (the page should reach it). */
  frame?: number;
  status?: string;
  /** The exact project the run started from (the files on disk may have changed since). */
  raw?: { config: unknown; scenes: Record<string, unknown>; scripts?: Record<string, string>; prefabs?: Record<string, unknown> };
  /** GameOps applied so far (`{ op: 'keyDown' | 'keyUp' | 'step' | ... }`). */
  ops?: unknown[];
}

/** Project-relative path of the published run. */
export const LIVE_RUN_FILE = '.vibe/live.json';
