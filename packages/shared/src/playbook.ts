import { z } from 'zod';
import { AssertionSchema } from './assertions';

/**
 * Scenario steps (input, waits, checks, clock jumps, screenshots) and playbooks: saved, reusable
 * verification scenarios (playbooks/<id>.json). A playbook is exactly a verify_game call kept in the
 * project, so the agent can re-run it as a regression test after later changes.
 */

const Key = z.string().min(1).describe('Key name: "A".."Z", "0".."9", "Space", "ArrowLeft", "Enter", "Shift"... (case-insensitive).');
const Button = z.enum(['left', 'right', 'middle']);
const Ms = (max: number) => z.number().min(0).max(max);

export const MAX_WAIT_MS = 60_000;

export const ExprSchema = z
  .string()
  .min(1)
  .describe(
    "Expression over the game state, e.g. \"entity('player').x > 300 && vars.coins >= 1\". Names: status, frame, time, scene, vars, camera, clock (clock.hour, clock.now). Functions: entity(id) (x, y, vx, vy, grounded, health, state, stateMs, ai, props, anim, nav, timers, tweens, interactable...), exists(id), count(tag), events(type), distance(a, b), pathDistance(a, b) (null = unreachable), abs, min, max, clamp(x, lo, hi).",
  );

export const InputStepSchema = z.discriminatedUnion('type', [
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

export const ClockInputSchema = z
  .object({
    start: z.string().optional().describe('Date and time the game starts at, ISO (e.g. "2026-03-10T21:30:00Z"). Default 2026-01-01T09:00:00Z.'),
    utcOffsetMinutes: z.number().int().min(-840).max(840).optional().describe('Time zone, minutes east of UTC (default 0).'),
    speed: z.number().min(0).max(100_000).optional().describe('Game-clock ms per simulated ms (default 1).'),
  })
  .describe('Calendar clock of the run (game.clock in scripts, clock in expressions).');
export const StorageInputSchema = z.record(z.string(), z.unknown()).describe('Saved data the game starts with (game.storage), e.g. a save from a previous session.');

/** Expression-only check steps (run_test). */
export const WaitUntilStepSchema = z.object({ type: z.literal('waitUntil'), expr: ExprSchema, maxMs: Ms(MAX_WAIT_MS).optional().describe('Default 5000.') });
export const AssertStepSchema = z.object({ type: z.literal('assert'), expr: ExprSchema });
export const AdvanceClockStepSchema = z
  .object({
    type: z.literal('advanceClock'),
    hours: z.number().min(0).optional(),
    minutes: z.number().min(0).optional(),
    ms: z.number().min(0).optional(),
  })
  .describe('Jumps the calendar clock ahead (no frames simulated).');
export const ScreenshotStepSchema = z
  .object({
    type: z.literal('screenshot'),
    label: z.string().max(60).optional().describe('Shown in the report and in the file name.'),
    annotate: z.boolean().optional().describe('Draw collider boxes and entity ids.'),
  })
  .describe('Takes a screenshot at this point of the scenario.');

const CheckName = z.string().min(1).max(120).describe('What this checks, in plain words (shown in the report), e.g. "coin collected".');
const Structured = AssertionSchema.describe(
  'Structured assertion, e.g. {"assert":"variable","var":"coins","equals":1}, {"assert":"eventOccurred","event":"collect","match":{"entity":"coin1"}}.',
);

/** A step check: "expr" (expression) or "check" (structured assertion), exactly one. */
const stepCheck = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({ ...shape, expr: ExprSchema.optional(), check: Structured.optional(), name: CheckName.optional() })
    .refine((st: { expr?: unknown; check?: unknown }) => (st.expr === undefined) !== (st.check === undefined), 'give either "expr" or "check"');

export const ScenarioStepSchema = z.union([
  InputStepSchema,
  stepCheck({ type: z.literal('waitUntil'), maxMs: Ms(MAX_WAIT_MS).optional().describe('Default 5000.') }),
  stepCheck({ type: z.literal('assert') }),
  AdvanceClockStepSchema,
  ScreenshotStepSchema,
]);

/** A final check: an expression, {name, expr}, or a structured assertion. */
export const ScenarioCheckSchema = z.union([ExprSchema, z.object({ name: CheckName, expr: ExprSchema }), AssertionSchema]);

/** Everything verify_game needs to play and check one scenario. */
export const PlaybookSchema = z.object({
  scenario: z.string().min(1).max(120).describe('What is being verified, e.g. "player collects the coin".'),
  tags: z.array(z.string().min(1).max(40)).max(10).optional().describe('Groups for run_playbooks, e.g. ["smoke", "feeding"].'),
  steps: z.array(ScenarioStepSchema).default([]),
  assertions: z.array(ScenarioCheckSchema).default([]).describe('Checked after all steps: expressions, {name, expr}, or structured assertions {"assert": ..., "name"?}.'),
  screenshot: z.boolean().default(true).describe('Screenshot of the final frame (default true).'),
  annotate: z.boolean().default(false).describe('Annotate the final screenshot (colliders and ids).'),
  allowErrors: z.boolean().default(false).describe('By default any runtime error (script crash, broken rule...) fails the verification.'),
  scene: z.string().optional(),
  seed: z.number().int().optional(),
  clock: ClockInputSchema.optional(),
  storage: StorageInputSchema.optional(),
});

export type Playbook = z.output<typeof PlaybookSchema>;
export type PlaybookInput = z.input<typeof PlaybookSchema>;

/** playbooks/<id>.json (id = file name). */
export const PLAYBOOK_FILE = /^playbooks\/[A-Za-z][A-Za-z0-9_-]*\.json$/;
export const playbookFile = (id: string) => `playbooks/${id}.json`;
