import { evaluateExpr, expandInputSteps, ExprError, msToFrames, type Game, type InputStep } from '@vibe/engine';
import { ToolError } from '../project-store';
import type { ScreenshotInfo } from './host';
import type { GameSession } from './session';

/**
 * Scripted scenarios on a fresh run: input steps, waits on conditions, checks along the way and
 * at the end, and (verify_game) screenshots. Shared by run_test and verify_game.
 */

export type ScenarioStep =
  | InputStep
  | { type: 'waitUntil'; expr: string; maxMs?: number; name?: string }
  | { type: 'assert'; expr: string; name?: string }
  | { type: 'advanceClock'; hours?: number; minutes?: number; ms?: number }
  | { type: 'screenshot'; label?: string; annotate?: boolean };

export interface Assertion {
  expr: string;
  name?: string;
}

export interface Check {
  /** Index of the step (absent for final assertions). */
  step?: number;
  name?: string;
  expr: string;
  pass: boolean;
  frame: number;
  observed?: Record<string, unknown>;
  error?: string;
  waitedMs?: number;
}

export interface ScenarioShot {
  step?: number;
  label?: string;
  frame: number;
  path?: string;
  absolutePath?: string;
  error?: string;
  warning?: string;
  renderWarnings?: string[];
}

export interface ScenarioResult {
  checks: Check[];
  shots: ScenarioShot[];
  simulatedMs: number;
}

export const MAX_SCENARIO_MS = 300_000;

/** Simulated ms of input steps (a click on an entity takes the same time as one at x/y). */
export function inputMs(steps: InputStep[]) {
  const timed = steps.map((s) => (s.type === 'click' ? { ...s, entity: undefined } : s));
  return expandInputSteps(timed).reduce((ms, op) => ms + (op.op === 'step' ? (op.frames * 1000) / 60 : 0), 0);
}

/** Evaluates a check expression; a bad expression fails the check (with the parser's message). */
export function checkExpr(game: Game, expr: string) {
  try {
    const r = evaluateExpr(expr, { game, sinceFrame: 0 });
    return { pass: !!r.value, observed: r.observed };
  } catch (err) {
    if (err instanceof ExprError) return { pass: false, error: err.message };
    throw err;
  }
}

/**
 * Runs the steps and final assertions on `session` (recorded as ops, so screenshots replay it).
 * Screenshot steps need `shoot`; a screenshot that fails is reported, not thrown.
 */
export async function runScenario(
  session: GameSession,
  steps: ScenarioStep[],
  assertions: Assertion[],
  shoot?: (label?: string, annotate?: boolean) => Promise<ScreenshotInfo>,
): Promise<ScenarioResult> {
  const game = session.game;
  const checks: Check[] = [];
  const shots: ScenarioShot[] = [];
  let simulatedMs = 0;
  const check = (a: Assertion, step?: number): Check => ({
    ...(step !== undefined && { step }),
    ...(a.name && { name: a.name }),
    expr: a.expr,
    ...checkExpr(game, a.expr),
    frame: game.frame,
  });

  for (const [i, step] of steps.entries()) {
    if (step.type === 'assert') {
      checks.push(check(step, i));
    } else if (step.type === 'advanceClock') {
      session.apply({ op: 'advanceClock', ms: (step.hours ?? 0) * 3_600_000 + (step.minutes ?? 0) * 60_000 + (step.ms ?? 0) });
    } else if (step.type === 'waitUntil') {
      const settled = () => {
        const r = checkExpr(game, step.expr);
        return r.pass || 'error' in r;
      };
      const frames = session.stepUntil(settled, msToFrames(step.maxMs ?? 5000));
      simulatedMs += (frames * 1000) / 60;
      checks.push({ ...check(step, i), expr: `waitUntil ${step.expr}`, waitedMs: Math.round((frames * 1000) / 60) });
    } else if (step.type === 'screenshot') {
      if (!shoot) throw new ToolError(`step ${i}: screenshots are not available here`);
      shots.push(await screenshot(shoot, game, step.label, step.annotate, i));
    } else {
      simulatedMs += inputMs([step]);
      try {
        session.perform([step]);
      } catch (err) {
        throw new ToolError(`step ${i}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (simulatedMs > MAX_SCENARIO_MS) throw new ToolError(`The scenario exceeds ${MAX_SCENARIO_MS} ms of simulated time`);
  }
  for (const a of assertions) checks.push(check(a));
  return { checks, shots, simulatedMs: Math.round(simulatedMs) };
}

export async function screenshot(
  shoot: (label?: string, annotate?: boolean) => Promise<ScreenshotInfo>,
  game: Game,
  label?: string,
  annotate?: boolean,
  step?: number,
): Promise<ScenarioShot> {
  const base = { ...(step !== undefined && { step }), ...(label && { label }), frame: game.frame };
  try {
    const s = await shoot(label, annotate);
    return {
      ...base,
      path: s.path,
      absolutePath: s.absolutePath,
      ...(s.divergence && { warning: s.divergence }),
      ...(s.renderWarnings.length && { renderWarnings: s.renderWarnings }),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
