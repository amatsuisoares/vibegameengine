import { z } from 'zod';
import { ToolError } from '../project-store';
import { runScenario, screenshot, type Check, type ScenarioShot } from '../runtime/scenario';
import { defineTool, WithImages } from './registry';
import { AdvanceClockStep, AssertStep, ClockInput, Expr, host, InputStepSchema, StorageInput, WaitUntilStep } from './runtime-tools';

const MAX_SHOTS = 6;

const Name = z.string().min(1).max(120).describe('What this checks, in plain words (shown in the report), e.g. "coin collected".');
const NamedCheck = z.union([Expr, z.object({ name: Name, expr: Expr })]);
const ScreenshotStep = z
  .object({
    type: z.literal('screenshot'),
    label: z.string().max(60).optional().describe('Shown in the report and in the file name.'),
    annotate: z.boolean().optional().describe('Draw collider boxes and entity ids.'),
  })
  .describe('Takes a screenshot at this point of the scenario.');
const VerifyStep = z.union([
  InputStepSchema,
  WaitUntilStep.extend({ name: Name.optional() }),
  AssertStep.extend({ name: Name.optional() }),
  AdvanceClockStep,
  ScreenshotStep,
]);

/** Observed values of a check as "a = 1, b = null" (short). */
function evidence(observed: Record<string, unknown> | undefined) {
  const parts = Object.entries(observed ?? {}).map(([k, v]) => {
    const text = v === undefined ? 'undefined' : JSON.stringify(v);
    return `${k} = ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`;
  });
  return parts.join(', ');
}

/** One report line per check: "PASS coin collected" / "FAIL coin collected: vars.coins == 1 (vars.coins = 0) at frame 180". */
export function reportLine(c: Check) {
  const label = c.name ?? c.expr;
  if (c.pass) return `PASS ${label}`;
  const why = c.error
    ? `error: ${c.error}`
    : [
        c.name && c.expr,
        c.waitedMs !== undefined && `not true after waiting ${c.waitedMs} ms`,
        evidence(c.observed) && `observed ${evidence(c.observed)}`,
      ]
        .filter(Boolean)
        .join('; ');
  return `FAIL ${label}${why ? ` — ${why}` : ''} (frame ${c.frame})`;
}

export const verifyTools = [
  defineTool({
    name: 'verify_game',
    description:
      'Verifies a feature in one call: plays a scenario on a fresh game (does not touch the current run), checks it and reports PASS/FAIL per check with the observed values, runtime errors, final state and screenshots. Steps: input steps (tap, hold, wait, click {entity}...), {"type":"waitUntil","expr"}, {"type":"assert","expr","name"?}, {"type":"advanceClock"}, {"type":"screenshot","label"?}. Use it after implementing or changing a feature.',
    input: z.object({
      scenario: z.string().min(1).max(120).describe('What is being verified, e.g. "player collects the coin".'),
      steps: z.array(VerifyStep).default([]),
      assertions: z
        .array(NamedCheck)
        .default([])
        .describe('Checked after all steps: expressions, or {name, expr} to give them a readable name in the report.'),
      screenshot: z.boolean().default(true).describe('Screenshot of the final frame (default true).'),
      annotate: z.boolean().default(false).describe('Annotate the final screenshot (colliders and ids).'),
      allowErrors: z.boolean().default(false).describe('By default any runtime error (script crash, broken rule...) fails the verification.'),
      scene: z.string().optional(),
      seed: z.number().int().optional(),
      clock: ClockInput.optional(),
      storage: StorageInput.optional(),
    }),
    run: async (ctx, input) => {
      const h = host(ctx);
      const s = h.newSession({ scene: input.scene, seed: input.seed, clock: input.clock, storage: input.storage });
      const game = s.game;
      const shoot = (label?: string, annotate?: boolean) => h.screenshotOf(s, annotate, label);
      const shotSteps = input.steps.filter((st) => st.type === 'screenshot').length + (input.screenshot ? 1 : 0);
      if (shotSteps > MAX_SHOTS) throw new ToolError(`At most ${MAX_SHOTS} screenshots per verification`);

      const assertions = input.assertions.map((a) => (typeof a === 'string' ? { expr: a } : a));
      const { checks, shots, simulatedMs } = await runScenario(s, input.steps, assertions, shoot);
      if (input.screenshot) shots.push(await screenshot(shoot, game, 'final', input.annotate));

      const errors = game.console.read(0, 'error').map((e) => e.message);
      const warnings = [...new Set(game.console.read(0, 'warn').map((e) => e.message))].slice(0, 10);
      const failed = checks.filter((c) => !c.pass).length;
      const errorsFail = errors.length > 0 && !input.allowErrors;
      const report = checks.map(reportLine);
      if (errors.length) report.push(`${input.allowErrors ? 'NOTE' : 'FAIL'} runtime errors (${errors.length}): ${errors[0].split('\n')[0]}`);
      if (!checks.length) report.push('NOTE no checks: add assertions or assert/waitUntil steps');
      for (const shot of shots) if (shot.error) report.push(`NOTE screenshot${shot.label ? ` "${shot.label}"` : ''} failed: ${shot.error}`);

      const passed = failed === 0 && !errorsFail;
      const state = game.getState({ ids: [] });
      const eventCounts: Record<string, number> = {};
      for (const e of game.events()) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
      const result = {
        scenario: input.scenario,
        passed,
        summary: `${passed ? 'PASS' : 'FAIL'}: ${checks.length - failed}/${checks.length} checks passed${errors.length ? `, ${errors.length} runtime error(s)` : ''}`,
        report,
        checks,
        screenshots: shots.map(({ absolutePath: _abs, ...shot }: ScenarioShot) => shot),
        final: { frame: state.frame, simulatedMs, status: state.status, scene: state.scene, vars: state.vars, clock: state.clock.iso },
        eventCounts,
        errors,
        ...(warnings.length && { warnings }),
      };
      const images = shots.filter((sh) => sh.absolutePath).map((sh) => ({ path: sh.absolutePath!, mediaType: 'image/png' as const }));
      return images.length ? new WithImages(result, images) : result;
    },
  }),
];
