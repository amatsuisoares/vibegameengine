import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type PlanOut = {
  created?: string;
  id: string;
  status: string;
  progress: string;
  checklist: string[];
  next?: string;
  missingPlaybooks?: string[];
  lastVerification?: { passed: boolean; summary: string; failures?: string[] };
};

const alive = (id: string, health: number) => ({
  id,
  scenario: `the player has ${health} health after a second`,
  screenshot: false,
  steps: [{ type: 'wait', ms: 1000 }],
  assertions: [{ assert: 'entity', id: 'player', field: 'health', equals: health }],
});

describe('agent planning (update_plan)', () => {
  it('keeps a goal, its tasks and their progress', async () => {
    const { ok, fail } = setup();
    const p = await ok<PlanOut>('update_plan', { goal: 'Create a platformer level', add: ['create player', 'create platforms', 'test movement'], verifyWith: ['level_works'] });
    expect(p).toMatchObject({ created: 'p1', id: 'p1', status: 'active', progress: '0/3 tasks done', next: 't1 create player', missingPlaybooks: ['level_works'] });
    expect(p.checklist).toEqual(['[ ] t1 create player', '[ ] t2 create platforms', '[ ] t3 test movement']);

    // Without id: the latest open plan.
    const q = await ok<PlanOut>('update_plan', {
      set: [
        { task: 't1', status: 'done', evidence: 'run_test: player exists' },
        { task: 't2', status: 'doing' },
        { task: 't3', status: 'blocked', note: 'needs the platforms' },
      ],
      add: ['verify win condition'],
    });
    expect(q.checklist).toEqual([
      '[x] t1 create player (evidence: run_test: player exists)',
      '[>] t2 create platforms',
      '[!] t3 test movement — needs the platforms',
      '[ ] t4 verify win condition',
    ]);
    expect(q).toMatchObject({ progress: '1/4 tasks done', next: 't2 create platforms' });
    expect((await fail('update_plan', { set: [{ task: 't9', status: 'done' }] })).error).toMatch(/No task t9 in p1/);
    expect((await fail('update_plan', { id: 'p7' })).error).toMatch(/No plan "p7"/);

    // A second plan; then the first is abandoned.
    await ok('update_plan', { goal: 'Add sounds' });
    const gone = await ok<PlanOut>('update_plan', { id: 'p1', status: 'abandoned' });
    expect(gone.status).toBe('abandoned');
  });

  it('closes with a verification by the saved playbooks', async () => {
    const { ok, fail } = setup();
    await ok('update_plan', { goal: 'Player keeps full health', add: ['check health'] });
    expect((await fail('update_plan', { verify: true })).error).toMatch(/no playbooks to verify with/);

    await ok('save_playbook', alive('healthy', 3));
    await ok('save_playbook', alive('wrong', 1));
    // Playbooks pass but a task is still open: not verified yet.
    let p = await ok<PlanOut & { verification: { id: string; passed: boolean }[] }>('update_plan', { verifyWith: ['healthy'], verify: true });
    expect(p.status).toBe('active');
    expect(p.lastVerification).toMatchObject({ passed: true, summary: '1/1 playbooks passed (but 1 task not done: t1)' });

    // Every task done: "done"; a failing playbook keeps it there, with the failures.
    p = await ok('update_plan', { set: [{ task: 't1', status: 'done' }], verifyWith: ['healthy', 'wrong'], verify: true });
    expect(p.status).toBe('done');
    expect(p.lastVerification!.passed).toBe(false);
    expect(p.lastVerification!.failures!.join('\n')).toMatch(/^wrong: FAIL/);
    expect(p.verification.map((v) => [v.id, v.passed])).toEqual([
      ['healthy', true],
      ['wrong', false],
    ]);

    // Passing: verified. Changing the work afterwards reopens it.
    p = await ok('update_plan', { verifyWith: ['healthy'], verify: true });
    expect(p).toMatchObject({ status: 'verified', lastVerification: { passed: true, summary: '1/1 playbooks passed' } });
    p = await ok('update_plan', { id: 'p1', add: ['also check the enemies'] });
    expect(p.status).toBe('active');
  });

  it('keeps the task changes of a call whose verification cannot run, and reopens to the right status', async () => {
    const { ok, fail } = setup();
    await ok('update_plan', { goal: 'G', add: ['a', 'b'], verifyWith: ['not_saved_yet'] });
    const r = await fail('update_plan', { set: [{ task: 't1', status: 'done' }], verify: true });
    expect(r.error).toMatch(/the plan changes were saved; verification not run/);
    const p = await ok<PlanOut>('update_plan', {});
    expect(p.checklist[0]).toBe('[x] t1 a');
    expect(p.lastVerification).toMatchObject({ passed: false, summary: 'could not run the playbooks' });

    // Abandoned, then reopened with every task done: "done", not "active".
    await ok('update_plan', { id: 'p1', set: [{ task: 't2', status: 'done' }], status: 'abandoned' });
    expect((await ok<PlanOut>('update_plan', { id: 'p1', status: 'active' })).status).toBe('done');
  });

  it('shows open plans in read_memory and get_project_summary', async () => {
    const { ok, dir } = setup();
    // A memory file from before plans existed still loads.
    mkdirSync(join(dir, '.vibe'), { recursive: true });
    writeFileSync(join(dir, '.vibe', 'memory.json'), JSON.stringify({ version: 1, summary: 'old', items: [{ id: 't1', kind: 'todo', text: 'old todo', status: 'open', updatedAt: 'x' }] }));
    await ok('update_plan', { goal: 'Make the enemy smarter', add: ['add a state machine', 'tune the chase'] });
    await ok('update_plan', { set: [{ task: 't1', status: 'done' }] });
    await ok('update_plan', { goal: 'Done thing', add: ['x'] });
    await ok('update_plan', { set: [{ task: 't1', status: 'done' }] });
    await ok('save_playbook', alive('healthy', 3));
    await ok('update_plan', { verifyWith: ['healthy'], verify: true });

    const memory = await ok<{ plans: { open: { id: string; checklist: string[] }[]; finished: string[] }; todos: unknown[] }>('read_memory');
    expect(memory.todos).toHaveLength(1);
    expect(memory.plans.open.map((p) => p.id)).toEqual(['p1']);
    expect(memory.plans.open[0].checklist).toEqual(['[x] t1 add a state machine', '[ ] t2 tune the chase']);
    expect(memory.plans.finished).toEqual(['p2 [verified] Done thing']);
    const summary = await ok<{ plans: string[] }>('get_project_summary');
    expect(summary.plans).toEqual(['p1 [active] Make the enemy smarter — 1/2 tasks done; next: t2 tune the chase']);
  });
});
