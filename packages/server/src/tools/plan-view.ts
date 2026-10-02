import type { Plan, ProjectMemory } from '@vibe/shared';
import type { ProjectStore } from '../project-store';

/** How plans are shown to the agent (update_plan, read_memory, get_project_summary). */

const MARK: Record<Plan['tasks'][number]['status'], string> = { todo: '[ ]', doing: '[>]', done: '[x]', blocked: '[!]' };

/** A plan as a checklist (what the agent reads). */
export function planView(plan: Plan) {
  const done = plan.tasks.filter((t) => t.status === 'done').length;
  const next = plan.tasks.find((t) => t.status === 'doing') ?? plan.tasks.find((t) => t.status === 'todo');
  return {
    id: plan.id,
    goal: plan.goal,
    status: plan.status,
    progress: `${done}/${plan.tasks.length} tasks done`,
    checklist: plan.tasks.map((t) => `${MARK[t.status]} ${t.id} ${t.text}${t.note ? ` — ${t.note}` : ''}${t.evidence ? ` (evidence: ${t.evidence})` : ''}`),
    ...(next && { next: `${next.id} ${next.text}` }),
    verifyWith: plan.verifyWith,
    ...(plan.result && { lastVerification: plan.result }),
  };
}

/** Plans for read_memory: open ones as checklists, finished ones in one line. */
export function plansView(memory: ProjectMemory) {
  const open = memory.plans.filter((p) => p.status === 'active' || p.status === 'done');
  const closed = memory.plans.filter((p) => p.status === 'verified' || p.status === 'abandoned');
  return { open: open.map(planView), finished: closed.map((p) => `${p.id} [${p.status}] ${p.goal}`) };
}

/** One line per open plan, for the project summary. */
export function openPlanLines(store: ProjectStore): string[] {
  try {
    return store
      .readMemory()
      .plans.filter((p) => p.status === 'active' || p.status === 'done')
      .map((p) => {
        const v = planView(p);
        return `${p.id} [${p.status}] ${p.goal} — ${v.progress}${v.next ? `; next: ${v.next}` : ''}`;
      });
  } catch {
    return [];
  }
}
