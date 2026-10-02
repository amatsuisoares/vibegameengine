import { PLAN_TASK_STATUSES, type Plan, type ProjectMemory } from '@vibe/shared';
import { z } from 'zod';
import { ToolError } from '../project-store';
import { planView } from './plan-view';
import { defineTool } from './registry';
import { runPlaybooks } from './verify-tools';

/**
 * Agent planning (V0.6): plans in the project memory — goal → tasks → verification by saved
 * playbooks. It is operational memory, not a planner: the agent decides the tasks and does them;
 * the plan keeps the checklist across conversations and closes with a real check.
 */

const nextPlanId = (memory: ProjectMemory) => {
  let n = memory.plans.length + 1;
  while (memory.plans.some((p) => p.id === `p${n}`)) n++;
  return `p${n}`;
};

const nextTaskId = (plan: Plan) => `t${plan.tasks.reduce((max, t) => Math.max(max, Number(t.id.slice(1)) || 0), 0) + 1}`;

const allDone = (plan: Plan) => plan.tasks.length > 0 && plan.tasks.every((t) => t.status === 'done');

export const planTools = [
  defineTool({
    name: 'update_plan',
    writesMeta: true,
    description:
      'Plans for complex work, kept in the project memory: a goal, its tasks in order and the saved playbooks that verify it. Create one with {goal, add: [tasks], verifyWith?: [playbook ids]} before multi-step work; then mark progress {set: [{task: "t2", status: "done", evidence?}]}, add/remove tasks as the work changes, and finish with {verify: true}: it runs the playbooks and the plan becomes "verified" only when every task is done and they pass. Without id it works on the latest open plan. read_memory and get_project_summary show open plans.',
    input: z.object({
      id: z.string().optional().describe('Plan to change (default: the latest open plan). Omit with `goal` to create a new plan.'),
      goal: z.string().min(1).optional().describe('Creates a plan with this goal (or renames the plan given by id).'),
      add: z.array(z.string().min(1)).default([]).describe('Tasks to append, in order.'),
      set: z
        .array(
          z.object({
            task: z.string().describe('Task id (t1, t2...).'),
            status: z.enum(PLAN_TASK_STATUSES).optional(),
            note: z.string().optional(),
            evidence: z.string().optional(),
          }),
        )
        .default([]),
      remove: z.array(z.string()).default([]).describe('Task ids to delete.'),
      verifyWith: z.array(z.string()).optional().describe('Playbook ids that verify the goal (replaces the list). Save scenarios with verify_game saveAs or save_playbook.'),
      status: z.enum(['active', 'abandoned']).optional().describe('Reopen or abandon the plan.'),
      verify: z.boolean().default(false).describe('Run the verifyWith playbooks now and record the result.'),
    }),
    run: async (ctx, input) => {
      const { store } = ctx;
      const memory = store.readMemory();
      const now = store.now();
      let plan: Plan | undefined;
      let created = false;
      if (input.id) {
        plan = memory.plans.find((p) => p.id === input.id);
        if (!plan) throw new ToolError(`No plan "${input.id}". Plans: ${memory.plans.map((p) => p.id).join(', ') || 'none'}`);
        if (input.goal) plan.goal = input.goal;
      } else if (input.goal) {
        plan = { id: nextPlanId(memory), goal: input.goal, status: 'active', tasks: [], verifyWith: [], createdAt: now, updatedAt: now };
        memory.plans.push(plan);
        created = true;
      } else {
        plan = memory.plans.findLast((p) => p.status === 'active' || p.status === 'done');
        if (!plan) throw new ToolError('No open plan: create one with {goal, add: [tasks]}');
      }

      const missing = [...input.remove, ...input.set.map((s) => s.task)].filter((id) => !plan.tasks.some((t) => t.id === id));
      if (missing.length) throw new ToolError(`No task ${[...new Set(missing)].join(', ')} in ${plan.id}. Tasks: ${plan.tasks.map((t) => t.id).join(', ') || 'none'}`);
      const changedTasks = input.add.length + input.set.length + input.remove.length > 0;
      plan.tasks = plan.tasks.filter((t) => !input.remove.includes(t.id));
      for (const text of input.add) plan.tasks.push({ id: nextTaskId(plan), text, status: 'todo', updatedAt: now });
      for (const s of input.set) {
        const task = plan.tasks.find((t) => t.id === s.task)!;
        if (s.status) task.status = s.status;
        if (s.note !== undefined) task.note = s.note || undefined;
        if (s.evidence !== undefined) task.evidence = s.evidence || undefined;
        task.updatedAt = now;
      }
      if (input.verifyWith) plan.verifyWith = [...new Set(input.verifyWith)];

      // Reopening goes back to where the work is (done when every task is).
      if (input.status) plan.status = input.status === 'active' && allDone(plan) ? 'done' : input.status;
      else if (plan.status !== 'abandoned' && (changedTasks || input.verifyWith)) {
        // Changing the work invalidates a previous verification.
        plan.status = allDone(plan) ? 'done' : 'active';
      }

      let verification: Awaited<ReturnType<typeof runPlaybooks>>['results'] | undefined;
      if (input.verify) {
        if (!plan.verifyWith.length) {
          throw new ToolError('This plan has no playbooks to verify with: save the scenarios that prove the goal (verify_game saveAs / save_playbook) and pass verifyWith: [ids]');
        }
        // The task changes of this call are kept even when the playbooks cannot run (e.g. one is not saved yet).
        let r: Awaited<ReturnType<typeof runPlaybooks>>;
        try {
          r = await runPlaybooks(ctx, { ids: plan.verifyWith });
        } catch (err) {
          if (!(err instanceof ToolError)) throw err;
          plan.result = { passed: false, summary: 'could not run the playbooks', at: now, failures: [err.message] };
          if (plan.status === 'verified') plan.status = allDone(plan) ? 'done' : 'active';
          plan.updatedAt = now;
          store.writeMemory(memory);
          throw new ToolError(`${err.message} (the plan changes were saved; verification not run)`, err.details);
        }
        verification = r.results;
        const pending = plan.tasks.filter((t) => t.status !== 'done');
        const failures = r.results.filter((x) => !x.passed).flatMap((x) => [`${x.id}: ${x.summary}`, ...(x.failures ?? []).map((f) => `  ${f}`)]);
        plan.result = { passed: r.passed, summary: r.summary, at: now, ...(failures.length && { failures }) };
        if (plan.status !== 'abandoned') plan.status = r.passed && !pending.length ? 'verified' : allDone(plan) ? 'done' : 'active';
        if (r.passed && pending.length) plan.result.summary += ` (but ${pending.length} task${pending.length === 1 ? '' : 's'} not done: ${pending.map((t) => t.id).join(', ')})`;
      }
      plan.updatedAt = now;
      store.writeMemory(memory);

      const missingPlaybooks = plan.verifyWith.filter((id) => !store.playbooks().some((p) => p.id === id));
      return {
        ...(created && { created: plan.id }),
        ...planView(plan),
        ...(missingPlaybooks.length && { missingPlaybooks, note: 'These playbooks are not saved yet: verification will fail until they exist.' }),
        ...(verification && { verification }),
      };
    },
  }),
];
