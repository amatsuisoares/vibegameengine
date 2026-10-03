import type { HotState } from './hot-state';

/**
 * Minigames: a scene called like a function. startMinigame(scene, params) keeps the calling scene as it
 * is (a hot-state snapshot: positions, variables, component values) and opens the minigame scene, which
 * reads its parameters in game.minigame. endMinigame(result) brings the caller back exactly as it was
 * (scripts start again, like after a hot reload) and emits "minigame_end" {scene, from, params, result, ms}
 * in it, so the caller's scripts (onEvent) and rules ({"event":"minigame_end"}) get the result.
 *
 * The call is part of the running state: hot reload and save slots keep it. Closing the game during a
 * minigame starts from the start scene next time, like any other running state.
 */
export interface MinigameCall {
  scene: string;
  /** The calling scene, restored by endMinigame. */
  from: string;
  params: Record<string, unknown>;
  /** Game time (s) when it started (for "ms" in minigame_end). */
  startedAt: number;
  /** The caller as it was when the minigame started. */
  caller: HotState;
}

/** What a minigame scene sees in game.minigame. */
export interface MinigameInfo {
  scene: string;
  from: string;
  params: Record<string, unknown>;
}

/** Requests made during a frame, applied at its end (like loadScene). */
export type MinigameRequest = { kind: 'start'; scene: string; params: Record<string, unknown> } | { kind: 'end'; result: unknown };

/** What rule actions and scripts use (implemented by the Game). */
export interface MinigameHost {
  startMinigame(scene: string, params?: Record<string, unknown>): void;
  endMinigame(result?: unknown): void;
  readonly minigame: MinigameInfo | null;
}

/** JSON-only copy (params and results cross scenes and go into saves). */
export function jsonCopy<T>(value: T, what: string): T {
  if (value === undefined) return value;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (err) {
    throw new Error(`${what} must be JSON data (${err instanceof Error ? err.message : String(err)})`);
  }
  if (text === undefined) throw new Error(`${what} must be JSON data`);
  if (text.length > 64_000) throw new Error(`${what} is too big (${text.length} chars; max 64000)`);
  return JSON.parse(text) as T;
}
