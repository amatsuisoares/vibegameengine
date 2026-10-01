import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProjectStore } from '../project-store';
import { ToolError } from '../project-store';
import { Screenshotter } from './screenshotter';
import { fingerprint, GameSession, type SessionOptions } from './session';

export interface ScreenshotInfo {
  /** Project-relative path of the PNG (under .vibe/runs/). */
  path: string;
  absolutePath: string;
  frame: number;
  /** Set when the browser replay did not reproduce the headless state (should never happen). */
  divergence?: string;
  /** Renderer/asset problems seen while drawing (only visible in the browser). */
  renderWarnings: string[];
}

/**
 * Owns the game run the agent is working with. Runs are headless (a Game in this
 * process); screenshots mirror them in Chromium. Only the project's own files and
 * this runtime are reachable — never the rest of the machine.
 */
export class RuntimeHost {
  session: GameSession | null = null;
  private shots = 0;

  constructor(
    readonly store: ProjectStore,
    private readonly screenshotter: Screenshotter = new Screenshotter(),
  ) {}

  /** Starts a fresh run from the project as it is on disk now. */
  run(options: Partial<SessionOptions> = {}): GameSession {
    const raw = this.store.rawProject();
    const status = this.store.validate();
    if (!status.project) throw new ToolError('Cannot run: the project is invalid', status.errors);
    if (options.scene && !status.project.scenes[options.scene]) {
      throw new ToolError(`Scene "${options.scene}" does not exist. Scenes: ${Object.keys(status.project.scenes).join(', ')}`);
    }
    this.session = new GameSession(raw, status.project, { seed: options.seed ?? 1, scene: options.scene }, fingerprint(raw));
    return this.session;
  }

  stop() {
    const had = this.session !== null;
    this.session = null;
    return had;
  }

  requireSession(): GameSession {
    if (!this.session) throw new ToolError('No game is running. Call run_game first.');
    return this.session;
  }

  /** True when project files changed after the current run started (the run uses the old version). */
  isStale(): boolean {
    if (!this.session) return false;
    try {
      return fingerprint(this.store.rawProject()) !== this.session.fingerprint;
    } catch {
      return true;
    }
  }

  async screenshot(annotate = false): Promise<ScreenshotInfo> {
    const s = this.requireSession();
    const { png, state, warnings } = await this.screenshotter.shoot({
      key: s.id,
      projectName: this.store.name,
      raw: s.raw,
      projectDir: this.store.dir,
      seed: s.options.seed,
      scene: s.options.scene,
      ops: s.ops,
      annotate,
    });
    const frame = s.game.frame;
    const path = `.vibe/runs/${s.id}/${String(++this.shots).padStart(3, '0')}-f${frame}${annotate ? '-debug' : ''}.png`;
    const absolutePath = this.store.path(path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, png);

    const expected = s.game.getState();
    const same = state.frame === expected.frame && JSON.stringify(state.entities) === JSON.stringify(expected.entities);
    return {
      path,
      absolutePath,
      frame,
      renderWarnings: warnings,
      ...(!same && { divergence: `browser replay is at frame ${state.frame} with different entity state than the headless run` }),
    };
  }

  async close() {
    this.session = null;
    await this.screenshotter.close();
  }
}
