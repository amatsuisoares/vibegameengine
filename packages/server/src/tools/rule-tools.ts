import { RuleSchema, type Rule } from '@vibe/shared';
import { z } from 'zod';
import { ToolError } from '../project-store';
import { defineTool } from './registry';
import { editScene } from './scene-tools';

type Raw = Record<string, unknown>;

/** Drops fields equal to their defaults, so scene files stay minimal. */
function minimalRule(rule: Rule): Raw {
  const r = structuredClone(rule) as Raw;
  if (r.once === false) delete r.once;
  if (r.enabled === true) delete r.enabled;
  const when = r.when as Raw;
  if ('enter' in when && when.tag === 'player') delete when.tag;
  for (const a of r.do as Raw[]) {
    if ((a.action === 'damage' || a.action === 'heal') && a.amount === 1) delete a.amount;
    if (a.action === 'playSound' && a.volume === 1) delete a.volume;
  }
  return r;
}

function rulesOf(scene: Raw): Raw[] {
  if (scene.rules === undefined) scene.rules = [];
  if (!Array.isArray(scene.rules)) throw new ToolError('Scene "rules" is not an array');
  return scene.rules as Raw[];
}

export const ruleTools = [
  defineTool({
    name: 'set_rule',
    description:
      'Adds or replaces (by id) a scene rule: when (start | event+match | enter zone | expr becomes true | every ms) -> if (expression) -> do (actions: setVar, addVar, emit, win, lose, loadScene, destroy, setEnabled, setText, damage, heal, move, modify, log). Targets are entity ids or "$by" (who entered / caused the event). Fires a "rule" event.',
    mutates: true,
    input: z.object({ scene: z.string().describe('Scene id.'), rule: RuleSchema }),
    run: (ctx, { scene, rule }, meta) => {
      let replaced = false;
      const r = editScene(ctx, meta(`Set rule ${rule.id} in ${scene}`), scene, (s) => {
        const list = rulesOf(s);
        const i = list.findIndex((x) => x.id === rule.id);
        replaced = i >= 0;
        if (replaced) list[i] = minimalRule(rule);
        else list.push(minimalRule(rule));
      });
      return { ...r.change, ...(r.change.changed && { replaced }) };
    },
  }),

  defineTool({
    name: 'delete_rule',
    description: 'Removes a scene rule by id.',
    mutates: true,
    input: z.object({ scene: z.string().describe('Scene id.'), id: z.string() }),
    run: (ctx, { scene, id }, meta) =>
      editScene(ctx, meta(`Delete rule ${id} from ${scene}`), scene, (s) => {
        const list = rulesOf(s);
        const i = list.findIndex((x) => x.id === id);
        if (i < 0) throw new ToolError(`Rule "${id}" does not exist in scene "${scene}". Rules: ${list.map((x) => x.id).join(', ') || '(none)'}`);
        list.splice(i, 1);
        if (!list.length) delete s.rules;
      }).change,
  }),
];
