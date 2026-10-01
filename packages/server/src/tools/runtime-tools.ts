import { msToFrames, screenToWorld } from '@vibe/engine';
import {
  AdvanceClockStepSchema,
  AssertStepSchema,
  ClockInputSchema,
  ExprSchema,
  InputStepSchema,
  MAX_WAIT_MS,
  StorageInputSchema,
  WaitUntilStepSchema,
} from '@vibe/shared';
import { z } from 'zod';
import { ToolError } from '../project-store';
import type { RuntimeHost } from '../runtime/host';
import { inputMs, runScenario, type Check } from '../runtime/scenario';
import type { GameSession } from '../runtime/session';
import { defineTool, WithImages, type ToolContext } from './registry';

const Key = z.string().min(1).describe('Key name: "A".."Z", "0".."9", "Space", "ArrowLeft", "Enter", "Shift"... (case-insensitive).');
const Button = z.enum(['left', 'right', 'middle']);
const Ms = (max: number) => z.number().min(0).max(max);
const Expr = ExprSchema;
const ClockInput = ClockInputSchema;
const StorageInput = StorageInputSchema;
const TestStepSchema = z.union([InputStepSchema, WaitUntilStepSchema, AssertStepSchema, AdvanceClockStepSchema]);

export function host(ctx: ToolContext): RuntimeHost {
  if (!ctx.host) throw new ToolError('Runtime tools are not available in this context (no RuntimeHost)');
  return ctx.host;
}

function session(ctx: ToolContext): GameSession {
  return host(ctx).requireSession();
}

/** Observation after an action, plus a warning when the run uses an outdated project version. */
function observe(ctx: ToolContext, extra: Record<string, unknown> = {}) {
  const h = host(ctx);
  const s = h.requireSession();
  return {
    ...extra,
    ...s.observe(),
    ...(h.isStale() && { projectChanged: 'Project files changed after this run started; call restart_game to play the latest version.' }),
  };
}

export const runtimeTools = [
  defineTool({
    name: 'run_game',
    changesRun: true,
    description:
      'Starts a new headless run of the current project (replacing any previous run). Time only advances through wait/perform_inputs, so runs are deterministic.',
    input: z.object({
      scene: z.string().optional().describe('Scene to start in (default: startScene).'),
      seed: z.number().int().optional().describe('Random seed (default 1).'),
      clock: ClockInput.optional(),
      storage: StorageInput.optional(),
    }),
    run: (ctx, { scene, seed, clock, storage }) => {
      const s = host(ctx).run({ scene, seed, clock, storage });
      const cfg = s.project.config;
      return observe(ctx, { runId: s.id, viewport: { width: cfg.width, height: cfg.height }, entityCount: s.game.world.entities.length });
    },
  }),

  defineTool({
    name: 'restart_game',
    changesRun: true,
    description: 'Restarts the run from the beginning with the latest project files (same scene, seed, clock and starting saved data). Use after editing the project.',
    input: z.object({}),
    run: (ctx) => {
      const h = host(ctx);
      const prev = h.requireSession();
      const s = h.run(prev.options);
      return observe(ctx, { runId: s.id });
    },
  }),

  defineTool({
    name: 'stop_game',
    changesRun: true,
    description: 'Ends the current run.',
    input: z.object({}),
    run: (ctx) => ({ stopped: host(ctx).stop() }),
  }),

  defineTool({
    name: 'press_key',
    changesRun: true,
    description: 'Presses and holds a key (it stays down until release_key). Time does not advance: call wait afterwards.',
    input: z.object({ key: Key }),
    run: (ctx, { key }) => {
      session(ctx).apply({ op: 'keyDown', key });
      return { keysDown: session(ctx).game.input.snapshot().keys };
    },
  }),

  defineTool({
    name: 'release_key',
    changesRun: true,
    description: 'Releases a key previously pressed with press_key.',
    input: z.object({ key: Key }),
    run: (ctx, { key }) => {
      session(ctx).apply({ op: 'keyUp', key });
      return { keysDown: session(ctx).game.input.snapshot().keys };
    },
  }),

  defineTool({
    name: 'move_mouse',
    changesRun: true,
    description: 'Moves the virtual mouse to viewport coordinates (pixels, origin top-left of the game view).',
    input: z.object({ x: z.number(), y: z.number() }),
    run: (ctx, { x, y }) => {
      session(ctx).apply({ op: 'mouseMove', x, y });
      return { mouse: { x, y } };
    },
  }),

  defineTool({
    name: 'click_mouse',
    changesRun: true,
    description:
      'Clicks (press, 1 frame, release), optionally moving to viewport coordinates first, or to the center of an entity (entity: id) — like a player clicking it. The "click" event says what was hit.',
    input: z.object({
      x: z.number().optional(),
      y: z.number().optional(),
      entity: z.string().optional().describe('Entity to click (its Collider/Sprite center on screen). Use instead of x/y.'),
      button: Button.optional(),
    }),
    run: (ctx, input) => {
      session(ctx).perform([{ type: 'click', ...input }]);
      return observe(ctx);
    },
  }),

  defineTool({
    name: 'wait',
    changesRun: true,
    description: `Advances simulated time (runs faster than real time). Returns what happened: player state, new events, new warnings/errors. Max ${MAX_WAIT_MS} ms.`,
    input: z.object({ ms: Ms(MAX_WAIT_MS) }),
    run: (ctx, { ms }) => {
      session(ctx).apply({ op: 'step', frames: msToFrames(ms) });
      return observe(ctx);
    },
  }),

  defineTool({
    name: 'advance_clock',
    changesRun: true,
    description:
      'Jumps the game calendar clock ahead (e.g. 3 hours) without simulating those frames, then advances 1 frame so the game reacts — like closing the game and coming back later. Scripts see the jump in game.clock.now.',
    input: z.object({
      hours: z.number().min(0).optional(),
      minutes: z.number().min(0).optional(),
      ms: z.number().min(0).optional(),
    }),
    run: (ctx, { hours = 0, minutes = 0, ms = 0 }) => {
      const total = hours * 3_600_000 + minutes * 60_000 + ms;
      if (total <= 0) throw new ToolError('Give hours, minutes or ms (> 0)');
      session(ctx).applyAll([{ op: 'advanceClock', ms: total }, { op: 'step', frames: 1 }]);
      return observe(ctx, { advancedMs: total });
    },
  }),

  defineTool({
    name: 'wait_until',
    changesRun: true,
    description: 'Advances time until an expression becomes true (or maxMs passes, or the game ends). Returns ok=false on timeout.',
    input: z.object({ expr: Expr, maxMs: Ms(MAX_WAIT_MS).optional().describe('Default 5000.') }),
    run: (ctx, { expr, maxMs = 5000 }) => {
      const r = session(ctx).waitUntil(expr, maxMs);
      return observe(ctx, r);
    },
  }),

  defineTool({
    name: 'perform_inputs',
    changesRun: true,
    description:
      'Runs a sequence of input steps in the current run, e.g. [{"type":"hold","key":"D","ms":800},{"type":"tap","key":"Space"},{"type":"wait","ms":500}]. tap/hold/wait advance time.',
    input: z.object({ steps: z.array(InputStepSchema).min(1) }),
    run: (ctx, { steps }) => {
      if (inputMs(steps) > MAX_WAIT_MS) throw new ToolError(`Steps add up to more than ${MAX_WAIT_MS} ms; split them into several calls`);
      session(ctx).perform(steps);
      return observe(ctx);
    },
  }),

  defineTool({
    name: 'observe',
    changesRun: true,
    description:
      'Everything about the current moment of the run in one call: game (frame, status, scene, clock, vars), players, entities on screen (with their box on screen), input (keys, mouse in screen and world coordinates), camera, events and console warnings/errors since the last action, and a screenshot. State says what happened; the screenshot shows how it looks. Does not advance time.',
    input: z.object({
      screenshot: z.boolean().default(true).describe('Attach a screenshot of the current frame (default true).'),
      annotate: z.boolean().default(false).describe('Annotate the screenshot (colliders and ids).'),
      entities: z.enum(['onScreen', 'all', 'none']).default('onScreen').describe('Which entities to list (default: those visible on screen).'),
      components: z.boolean().default(false).describe('Include full component data of the listed entities.'),
    }),
    run: async (ctx, { screenshot, annotate, entities, components }) => {
      const h = host(ctx);
      const s = h.requireSession();
      const g = s.game;
      const obs = s.observe(); // new events and console entries since the last action
      const state = g.getState({ ids: entities === 'none' ? [] : undefined, onScreen: entities === 'onScreen', components });
      const MAX = 60;
      const mouse = state.input.mouse;
      const world = screenToWorld(g.world, mouse.x, mouse.y);
      let shot: Record<string, unknown> | undefined;
      let image: string | undefined;
      if (screenshot) {
        try {
          const info = await h.screenshot(annotate);
          shot = { path: info.path, frame: info.frame, ...(info.divergence && { warning: info.divergence }), ...(info.renderWarnings.length && { renderWarnings: info.renderWarnings }) };
          image = info.absolutePath;
        } catch (err) {
          shot = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      const result = {
        game: { frame: state.frame, time: state.time, status: state.status, scene: state.scene, clock: state.clock.iso, vars: state.vars },
        ...(obs.players && { players: obs.players }),
        ...(entities !== 'none' && {
          entities: state.entities.slice(0, MAX),
          ...(state.entities.length > MAX && { entitiesTruncated: state.entities.length - MAX }),
          entityCount: state.entityCount,
        }),
        input: { keysDown: state.input.keys, mouse: { x: mouse.x, y: mouse.y, world: { x: Math.round(world.x * 100) / 100, y: Math.round(world.y * 100) / 100 }, buttons: mouse.buttons } },
        camera: state.camera,
        events: obs.events,
        ...(obs.eventsTruncated && { eventsTruncated: obs.eventsTruncated }),
        console: obs.console,
        ...(shot && { screenshot: shot }),
        ...(h.isStale() && { projectChanged: 'Project files changed after this run started; call restart_game to play the latest version.' }),
      };
      return image ? new WithImages(result, [{ path: image, mediaType: 'image/png' }]) : result;
    },
  }),

  defineTool({
    name: 'inspect_game_state',
    description: 'Current state: status, variables, camera, clock, input, and entity snapshots (position, velocity, grounded, health). Filter by ids or tags; components=true adds full component data; storage=true adds the saved data.',
    input: z.object({
      ids: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      components: z.boolean().optional(),
      storage: z.boolean().optional().describe('Include the saved data (game.storage).'),
      onScreen: z.boolean().optional().describe('Only entities drawn inside the viewport, each with its box on screen (`screen`).'),
    }),
    run: (ctx, query) => {
      const state = session(ctx).game.getState(query);
      return host(ctx).isStale() ? { ...state, projectChanged: true } : state;
    },
  }),

  defineTool({
    name: 'read_events',
    description: 'Gameplay events (jump, collect, damage, stomp, death, fell, respawn, checkpoint, goal, win, lose, scene_loaded, crash) with their frame.',
    input: z.object({
      sinceFrame: z.number().int().min(0).optional(),
      type: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional().describe('Most recent N (default 100).'),
    }),
    run: (ctx, { sinceFrame, type, limit = 100 }) => {
      const all = session(ctx).game.events(sinceFrame ?? 0, type);
      return { total: all.length, events: all.slice(-limit) };
    },
  }),

  defineTool({
    name: 'read_console',
    description: 'Runtime console: engine logs, warnings (e.g. broken sprite assets) and errors (runtime crashes with stack).',
    input: z.object({
      since: z.number().int().min(0).optional().describe('Only entries with seq greater than this.'),
      level: z.enum(['log', 'warn', 'error']).optional(),
    }),
    run: (ctx, { since, level }) => session(ctx).game.console.read(since, level),
  }),

  defineTool({
    name: 'take_screenshot',
    description:
      'Renders the current frame of the run in Chromium and returns it as an image. annotate=true draws collider boxes (green solid, yellow one-way, blue trigger, magenta dynamic) and entity ids.',
    input: z.object({ annotate: z.boolean().optional() }),
    run: async (ctx, { annotate = false }) => {
      const shot = await host(ctx).screenshot(annotate);
      const s = session(ctx);
      const result = {
        path: shot.path,
        frame: shot.frame,
        viewport: { width: s.project.config.width, height: s.project.config.height },
        camera: s.game.getState({ ids: [] }).camera,
        ...(shot.divergence && { warning: shot.divergence }),
        ...(shot.renderWarnings.length && { renderWarnings: shot.renderWarnings }),
      };
      return new WithImages(result, [{ path: shot.absolutePath, mediaType: 'image/png' }]);
    },
  }),

  defineTool({
    name: 'open_game_view',
    description:
      'Gives the URL of the live game page for the user to open in VS Code (Simple Browser), starting the dev server if needed. The page hot-reloads on every project edit. follow=true mirrors your current run instead (the user watches what you play, in real time).',
    input: z.object({
      follow: z.boolean().default(false).describe('Mirror the agent run (run_game, perform_inputs, wait...) instead of letting the user play.'),
      scene: z.string().optional().describe('Scene to start in when playing (default: startScene).'),
      debug: z.boolean().default(false).describe('Show colliders and entity ids.'),
    }),
    run: async (ctx, { follow, scene, debug }) => {
      if (scene && !ctx.store.validate().project?.scenes[scene]) throw new ToolError(`Scene "${scene}" does not exist`);
      const { url, owned } = await host(ctx).viewUrl({ follow, scene, debug });
      return {
        url,
        server: owned ? 'started by the vibe MCP server (stays up while this Claude Code session lives)' : 'already running (npm run dev or the VS Code task)',
        howToOpen:
          'Show the user this URL as a link: in VS Code it opens in the Simple Browser panel. Or: Command Palette > "Tasks: Run Task" > "Vibe: abrir jogo".',
      };
    },
  }),

  defineTool({
    name: 'run_test',
    description:
      'Runs a scripted test on a fresh game (does not touch the current run): input steps plus {"type":"waitUntil","expr",...} and {"type":"assert","expr"} steps, then final assertions. Reports each check with the observed values.',
    input: z.object({
      steps: z.array(TestStepSchema).default([]),
      assertions: z.array(Expr).default([]).describe('Checked after all steps.'),
      scene: z.string().optional(),
      seed: z.number().int().optional(),
      clock: ClockInput.optional(),
      storage: StorageInput.optional(),
    }),
    run: async (ctx, { steps, assertions, scene, seed, clock, storage }) => {
      const s = host(ctx).newSession({ scene, seed, clock, storage });
      const game = s.game;
      const { checks } = await runScenario(s, steps, assertions.map((expr) => ({ expr })));
      const final = game.getState({ tags: ['player'] });
      const counts: Record<string, number> = {};
      for (const e of game.events()) counts[e.type] = (counts[e.type] ?? 0) + 1;
      return {
        passed: checks.every((c: Check) => c.pass),
        checks,
        final: { frame: final.frame, status: final.status, scene: final.scene, vars: final.vars, players: final.entities },
        eventCounts: counts,
        errors: game.console.read(0, 'error').map((e) => e.message),
      };
    },
  }),
];
