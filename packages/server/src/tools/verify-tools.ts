import type { SaveSlot } from '@vibe/engine';
import { IdSchema, PlaybookSchema, playbookFile, type Playbook } from '@vibe/shared';
import { z } from 'zod';
import { ToolError, type ChangeMeta } from '../project-store';
import { diagnose } from '../runtime/diagnosis';
import { runScenario, screenshot, type Check, type CheckSpec, type ScenarioShot, type ScenarioStep } from '../runtime/scenario';
import { defineTool, WithImages, type ToolContext, type ToolImage } from './registry';
import { host } from './runtime-tools';
import { changeInfo } from './scene-tools';

const MAX_SHOTS = 6;
const MAX_PLAYBOOK_IMAGES = 6;

const short = (v: unknown, max = 60) => {
  const text = v === undefined ? 'undefined' : JSON.stringify(v);
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
};

/** Observed values of a check as "a = 1, b = null" (short). */
function evidence(observed: Record<string, unknown> | undefined) {
  return Object.entries(observed ?? {})
    .map(([k, v]) => `${k} = ${short(v)}`)
    .join(', ');
}

/** One report line per check: "PASS coin collected" / "FAIL coin collected — vars.coins == 1; observed vars.coins = 0 (frame 180)". */
export function reportLine(c: Check) {
  const what = c.expr ?? c.check;
  const label = c.name ?? what;
  if (c.pass) return `PASS ${label}`;
  const why = c.error
    ? `error: ${c.error}`
    : [
        c.name && what,
        c.waitedMs !== undefined && `not true after waiting ${c.waitedMs} ms`,
        c.assert ? `expected ${c.expected}, got ${short(c.actual)}` : evidence(c.observed) && `observed ${evidence(c.observed)}`,
        c.evidence && `evidence ${short(c.evidence, 160)}`,
      ]
        .filter(Boolean)
        .join('; ');
  return `FAIL ${label}${why ? ` — ${why}` : ''} (frame ${c.frame})`;
}

/** Plays and checks one scenario on a fresh game; the report plus the screenshots taken. */
export async function verifyScenario(ctx: ToolContext, p: Playbook) {
  const h = host(ctx);
  const s = h.newSession({ scene: p.scene, seed: p.seed, clock: p.clock, storage: p.storage, slots: p.slots as Record<string, SaveSlot> | undefined });
  const game = s.game;
  const shoot = (label?: string, annotate?: boolean) => h.screenshotOf(s, annotate, label);
  const shotSteps = p.steps.filter((st) => st.type === 'screenshot').length + (p.screenshot ? 1 : 0);
  if (shotSteps > MAX_SHOTS) throw new ToolError(`At most ${MAX_SHOTS} screenshots per verification`);

  const assertions = p.assertions.map((a): CheckSpec => (typeof a === 'string' ? { expr: a } : 'assert' in a ? { check: a, name: a.name } : a));
  // The schema guarantees each check step has exactly one of expr / check.
  const { checks, shots, simulatedMs } = await runScenario(s, p.steps as ScenarioStep[], assertions, shoot);
  if (p.screenshot) shots.push(await screenshot(shoot, game, 'final', p.annotate));

  const errors = game.console.read(0, 'error').map((e) => e.message);
  const warnings = [...new Set(game.console.read(0, 'warn').map((e) => e.message))].slice(0, 10);
  const failed = checks.filter((c) => !c.pass).length;
  const errorsFail = errors.length > 0 && !p.allowErrors;
  const report = checks.map(reportLine);
  if (errors.length) report.push(`${p.allowErrors ? 'NOTE' : 'FAIL'} runtime errors (${errors.length}): ${errors[0].split('\n')[0]}`);
  if (!checks.length) report.push('NOTE no checks: add assertions or assert/waitUntil steps');
  for (const shot of shots) if (shot.error) report.push(`NOTE screenshot${shot.label ? ` "${shot.label}"` : ''} failed: ${shot.error}`);

  const passed = failed === 0 && !errorsFail;
  let diagnosis: ReturnType<typeof diagnose> | undefined;
  if (!passed) {
    // Structured checks keep their assertion (step checks by step index, final ones in order).
    const finals = assertions.map((a) => a.check);
    let f = 0;
    const raw = (c: Check) => {
      const spec = c.step !== undefined ? (p.steps[c.step] as { check?: unknown }).check : finals[f++];
      return spec as Record<string, unknown> | undefined;
    };
    const withRaw = checks.map((c) => ({ check: c, raw: raw(c) })).filter((x) => !x.check.pass);
    const errorEntries = errorsFail ? game.console.read(0, 'error') : [];
    diagnosis = diagnose(game, s.project, s.raw.scripts ?? {}, withRaw, errorEntries);
    const top = diagnosis.likelySystems.slice(0, 3);
    if (top.length) report.push(`LIKELY ${top.map((g) => `${g.system} (${g.why[0]})`).join('; ')}`);
  }
  const state = game.getState({ ids: [] });
  const eventCounts: Record<string, number> = {};
  for (const e of game.events()) eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
  const result = {
    scenario: p.scenario,
    passed,
    summary: `${passed ? 'PASS' : 'FAIL'}: ${checks.length - failed}/${checks.length} checks passed${errors.length ? `, ${errors.length} runtime error(s)` : ''}`,
    report,
    checks,
    screenshots: shots.map(({ absolutePath: _abs, ...shot }: ScenarioShot) => shot),
    final: { frame: state.frame, simulatedMs, status: state.status, scene: state.scene, vars: state.vars, clock: state.clock.iso },
    eventCounts,
    errors,
    ...(warnings.length && { warnings }),
    ...(diagnosis && { diagnosis }),
  };
  const images: ToolImage[] = shots.filter((sh) => sh.absolutePath).map((sh) => ({ path: sh.absolutePath!, mediaType: 'image/png' }));
  return { result, images };
}

const PlaybookId = IdSchema.describe('Playbook id (file playbooks/<id>.json), e.g. "player_collects_coin".');

/** Writes a playbook through the store (validated, in the history, undoable). */
function savePlaybook(ctx: ToolContext, id: string, playbook: Playbook, meta: (summary: string) => ChangeMeta) {
  const file = playbookFile(id);
  const existed = ctx.store.readText(file) !== null;
  const r = ctx.store.edit(meta(`${existed ? 'Update' : 'Save'} playbook ${id}: ${playbook.scenario}`), (tx) => tx.writeJson(file, playbook));
  return { playbook: id, file, ...(existed && { replaced: true }), ...changeInfo(r) };
}

export interface PlaybookRunResult {
  id: string;
  scenario?: string;
  passed: boolean;
  summary: string;
  failures?: string[];
  likelySystems?: string[];
  screenshots?: string[];
}

/** Runs saved playbooks (all, or by ids / tags), each on a fresh game: the run_playbooks scoreboard. */
export async function runPlaybooks(ctx: ToolContext, { ids, tags, screenshots = false }: { ids?: string[]; tags?: string[]; screenshots?: boolean }) {
  const all = ctx.store.playbooks();
  if (!all.length) throw new ToolError('No playbooks yet: save one with save_playbook or verify_game saveAs');
  const unknown = (ids ?? []).filter((id) => !all.some((p) => p.id === id));
  if (unknown.length) throw new ToolError(`Unknown playbook(s): ${unknown.join(', ')}. Saved: ${all.map((p) => p.id).join(', ')}`);
  const chosen = all.filter((p) => (!ids || ids.includes(p.id)) && (!tags || p.playbook?.tags?.some((t) => tags.includes(t))));
  if (!chosen.length) throw new ToolError('No playbook matches those tags');

  const results: PlaybookRunResult[] = [];
  const images: ToolImage[] = [];
  for (const p of chosen) {
    if (!p.playbook) {
      results.push({ id: p.id, passed: false, summary: 'INVALID playbook file', failures: p.errors });
      continue;
    }
    const pb = screenshots ? p.playbook : { ...p.playbook, screenshot: false, steps: p.playbook.steps.filter((st) => st.type !== 'screenshot') };
    try {
      const { result, images: shots } = await verifyScenario(ctx, pb);
      images.push(...shots);
      results.push({
        id: p.id,
        scenario: result.scenario,
        passed: result.passed,
        summary: result.summary,
        ...(!result.passed && {
          failures: result.report.filter((l) => !l.startsWith('PASS') && !l.startsWith('LIKELY')),
          likelySystems: result.diagnosis?.likelySystems.slice(0, 3).map((g) => g.system),
        }),
        ...(screenshots && { screenshots: result.screenshots.map((sh) => sh.path).filter((path): path is string => !!path) }),
      });
    } catch (err) {
      results.push({ id: p.id, scenario: p.playbook.scenario, passed: false, summary: 'ERROR', failures: [err instanceof Error ? err.message : String(err)] });
    }
  }
  const passed = results.filter((r) => r.passed).length;
  return { passed: passed === results.length, summary: `${passed}/${results.length} playbooks passed`, results, images };
}

export const verifyTools = [
  defineTool({
    name: 'verify_game',
    mutates: true,
    description:
      'Verifies a feature in one call: plays a scenario on a fresh game (does not touch the current run), checks it and reports PASS/FAIL per check with the observed values, runtime errors, final state and screenshots. Steps: input steps (tap, hold, wait, click {entity}...), {"type":"waitUntil","expr"|"check"}, {"type":"assert","expr"|"check","name"?}, {"type":"advanceClock"}, {"type":"screenshot","label"?}. Checks are expressions or structured assertions ({"assert": "entityExists"|"entityAt"|"entityNear"|"entity"|"component"|"state"|"variable"|"count"|"eventOccurred"|"scene"|"gameWon"|"gameLost"|"status", ...}) that report expected/actual and evidence. saveAs keeps the scenario as a playbook (regression test) when it passes. Use it after implementing or changing a feature.',
    input: PlaybookSchema.extend({
      saveAs: PlaybookId.optional().describe('Save this scenario as playbooks/<id>.json if it passes (re-run later with run_playbooks).'),
    }),
    run: async (ctx, { saveAs, ...input }, meta) => {
      const playbook = PlaybookSchema.parse(input); // drops the history "reason"
      const { result, images } = await verifyScenario(ctx, playbook);
      let saved: Record<string, unknown> | undefined;
      if (saveAs) {
        if (result.passed) {
          const { diff: _diff, ...info } = savePlaybook(ctx, saveAs, playbook, meta) as Record<string, unknown>;
          saved = info;
        } else saved = { playbook: saveAs, saved: false, why: 'the verification failed; fix it and verify again' };
      }
      const out = { ...result, ...(saved && { saved }) };
      return images.length ? new WithImages(out, images) : out;
    },
  }),

  defineTool({
    name: 'save_playbook',
    mutates: true,
    description:
      'Saves a reusable verification scenario as playbooks/<id>.json (same fields as verify_game: scenario, steps, assertions, tags...). Replaces a playbook with the same id. Run them with run_playbooks after later changes (regression tests).',
    input: PlaybookSchema.extend({ id: PlaybookId }),
    run: (ctx, { id, ...input }, meta) => savePlaybook(ctx, id, PlaybookSchema.parse(input), meta),
  }),

  defineTool({
    name: 'list_playbooks',
    description: 'Saved playbooks: id, scenario, tags, how many steps and checks; invalid files with their errors.',
    input: z.object({}),
    run: (ctx) => {
      const all = ctx.store.playbooks();
      const valid = all.flatMap(({ id, playbook: p }) => (p ? [{ id, p }] : []));
      const invalid = all.filter((p) => p.errors).map(({ id, errors }) => ({ id, errors }));
      return {
        playbooks: valid.map(({ id, p }) => ({
          id,
          scenario: p.scenario,
          ...(p.tags && { tags: p.tags }),
          steps: p.steps.length,
          checks: p.assertions.length + p.steps.filter((st) => st.type === 'assert' || st.type === 'waitUntil').length,
        })),
        ...(invalid.length && { invalid }),
      };
    },
  }),

  defineTool({
    name: 'run_playbooks',
    description:
      'Runs saved playbooks (all, or by ids / tags), each on a fresh game, and returns a scoreboard: PASS/FAIL per playbook with its failing report lines. Use after changing the project to catch regressions. Screenshots are off unless screenshots=true.',
    input: z.object({
      ids: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional().describe('Only playbooks with any of these tags.'),
      screenshots: z.boolean().default(false).describe("Take each playbook's screenshots (slower; the last 6 images are attached)."),
    }),
    run: async (ctx, { ids, tags, screenshots }) => {
      const { images, ...out } = await runPlaybooks(ctx, { ids, tags, screenshots });
      return images.length ? new WithImages(out, images.slice(-MAX_PLAYBOOK_IMAGES)) : out;
    },
  }),

  defineTool({
    name: 'delete_playbook',
    mutates: true,
    destructive: true,
    description: 'Deletes a saved playbook (undoable).',
    input: z.object({ id: PlaybookId }),
    run: ({ store }, { id }, meta) => {
      if (store.readText(playbookFile(id)) === null) throw new ToolError(`Playbook "${id}" does not exist`);
      return changeInfo(store.edit(meta(`Delete playbook ${id}`), (tx) => tx.delete(playbookFile(id))));
    },
  }),
];
