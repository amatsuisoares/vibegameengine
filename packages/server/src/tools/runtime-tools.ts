import { evaluateExpr, ExprError, Game, msToFrames, expandInputSteps, type InputStep } from '@vibe/engine';
import { z } from 'zod';
import { ToolError } from '../project-store';
import type { RuntimeHost } from '../runtime/host';
import type { GameSession } from '../runtime/session';
import { defineTool, WithImages, type ToolContext } from './registry';

const Key = z.string().min(1).describe('Key name: "A".."Z", "0".."9", "Space", "ArrowLeft", "Enter", "Shift"... (case-insensitive).');
const Button = z.enum(['left', 'right', 'middle']);
const Ms = (max: number) => z.number().min(0).max(max);
const Expr = z.string().min(1).describe(
  "Expression over the game state, e.g. \"entity('player').x > 300 && vars.coins >= 1\". Names: status, frame, time, scene, vars, camera, clock (clock.hour, clock.now). Functions: entity(id) (x, y, vx, vy, grounded, health, state, stateMs, ai, props, anim, nav, timers, tweens, interactable...), exists(id), count(tag), events(type), distance(a, b), pathDistance(a, b) (null = unreachable), abs, min, max, clamp(x, lo, hi).",
);

const MAX_WAIT_MS = 60_000;
const MAX_TEST_MS = 300_000;

const InputStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('keyDown'), key: Key }),
  z.object({ type: z.literal('keyUp'), key: Key }),
  z.object({ type: z.literal('tap'), key: Key, ms: Ms(10_000).optional().describe('Hold duration (default 50).') }),
  z.object({ type: z.literal('hold'), key: Key, ms: Ms(MAX_WAIT_MS) }),
  z.object({ type: z.literal('wait'), ms: Ms(MAX_WAIT_MS) }),
  z.object({ type: z.literal('mouseMove'), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('mouseDown'), button: Button.optional() }),
  z.object({ type: z.literal('mouseUp'), button: Button.optional() }),
  z.object({
    type: z.literal('click'),
    x: z.number().optional(),
    y: z.number().optional(),
    entity: z.string().optional().describe('Click the center of this entity (instead of x/y), wherever it is on screen.'),
    button: Button.optional(),
  }),
  z.object({ type: z.literal('type'), text: z.string().min(1).describe('Characters typed (e.g. a name); "\\b" = Backspace, "\\n" = Enter. Advances 1 frame.') }),
]);

const ClockInput = z
  .object({
    start: z.string().optional().describe('Date and time the game starts at, ISO (e.g. "2026-03-10T21:30:00Z"). Default 2026-01-01T09:00:00Z.'),
    utcOffsetMinutes: z.number().int().min(-840).max(840).optional().describe('Time zone, minutes east of UTC (default 0).'),
    speed: z.number().min(0).max(100_000).optional().describe('Game-clock ms per simulated ms (default 1).'),
  })
  .describe('Calendar clock of the run (game.clock in scripts, clock in expressions).');
const StorageInput = z.record(z.string(), z.unknown()).describe('Saved data the game starts with (game.storage), e.g. a save from a previous session.');

const WaitUntilStep = z.object({ type: z.literal('waitUntil'), expr: Expr, maxMs: Ms(MAX_WAIT_MS).optional().describe('Default 5000.') });
const AssertStep = z.object({ type: z.literal('assert'), expr: Expr });
const AdvanceClockStep = z.object({
  type: z.literal('advanceClock'),
  hours: z.number().min(0).optional(),
  minutes: z.number().min(0).optional(),
  ms: z.number().min(0).optional(),
}).describe('Jumps the calendar clock ahead (no frames simulated).');
const TestStepSchema = z.union([InputStepSchema, WaitUntilStep, AssertStep, AdvanceClockStep]);
type TestStep = z.output<typeof TestStepSchema>;

function host(ctx: ToolContext): RuntimeHost {
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

function totalMs(steps: InputStep[]) {
  const timed = steps.map((s) => (s.type === 'click' ? { ...s, entity: undefined } : s));
  return expandInputSteps(timed).reduce((ms, op) => ms + (op.op === 'step' ? (op.frames * 1000) / 60 : 0), 0);
}

function checkExpr(game: Game, expr: string, sinceFrame: number) {
  try {
    const r = evaluateExpr(expr, { game, sinceFrame });
    return { pass: !!r.value, observed: r.observed };
  } catch (err) {
    if (err instanceof ExprError) return { pass: false, error: err.message };
    throw err;
  }
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
      if (totalMs(steps) > MAX_WAIT_MS) throw new ToolError(`Steps add up to more than ${MAX_WAIT_MS} ms; split them into several calls`);
      session(ctx).perform(steps);
      return observe(ctx);
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
    run: (ctx, { steps, assertions, scene, seed, clock, storage }) => {
      const status = ctx.store.validate();
      if (!status.project) throw new ToolError('Cannot test: the project is invalid', status.errors);
      if (scene && !status.project.scenes[scene]) throw new ToolError(`Scene "${scene}" does not exist`);
      const game = new Game(status.project, { seed: seed ?? 1, scene, clock, storage });
      const checks: { step?: number; expr: string; pass: boolean; observed?: Record<string, unknown>; error?: string; waitedMs?: number }[] = [];
      let simulatedMs = 0;

      steps.forEach((step: TestStep, i) => {
        if (step.type === 'assert') {
          checks.push({ step: i, expr: step.expr, ...checkExpr(game, step.expr, 0) });
        } else if (step.type === 'advanceClock') {
          game.apply({ op: 'advanceClock', ms: (step.hours ?? 0) * 3_600_000 + (step.minutes ?? 0) * 60_000 + (step.ms ?? 0) });
        } else if (step.type === 'waitUntil') {
          const max = msToFrames(step.maxMs ?? 5000);
          let frames = 0;
          let r = checkExpr(game, step.expr, 0);
          while (!r.pass && !('error' in r) && frames < max && game.status === 'running') {
            game.step(1);
            frames++;
            r = checkExpr(game, step.expr, 0);
          }
          simulatedMs += (frames * 1000) / 60;
          checks.push({ step: i, expr: `waitUntil ${step.expr}`, ...r, waitedMs: Math.round((frames * 1000) / 60) });
        } else {
          simulatedMs += totalMs([step]);
          try {
            game.perform([step]);
          } catch (err) {
            throw new ToolError(`step ${i}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (simulatedMs > MAX_TEST_MS) throw new ToolError(`Test exceeds ${MAX_TEST_MS} ms of simulated time`);
      });
      for (const expr of assertions) checks.push({ expr, ...checkExpr(game, expr, 0) });

      const final = game.getState({ tags: ['player'] });
      const counts: Record<string, number> = {};
      for (const e of game.events()) counts[e.type] = (counts[e.type] ?? 0) + 1;
      return {
        passed: checks.every((c) => c.pass),
        checks,
        final: { frame: final.frame, status: final.status, scene: final.scene, vars: final.vars, players: final.entities },
        eventCounts: counts,
        errors: game.console.read(0, 'error').map((e) => e.message),
      };
    },
  }),
];
