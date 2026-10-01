import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type Board = { passed: boolean; summary: string; results: { id: string; passed: boolean; summary: string; failures?: string[] }[] };

const coin = {
  scenario: 'player collects the first coin',
  tags: ['smoke', 'coins'],
  screenshot: false,
  steps: [
    { type: 'keyDown', key: 'D' },
    { type: 'waitUntil', name: 'coin collected', check: { assert: 'eventOccurred', event: 'collect', match: { entity: 'coin1' } }, maxMs: 3000 },
    { type: 'keyUp', key: 'D' },
  ],
  assertions: [{ assert: 'variable', var: 'coins', equals: 1 }],
};

describe('playbooks', () => {
  it('saves a verified scenario (verify_game saveAs), lists it and re-runs it as a regression test', async () => {
    const { ok, store } = setup();
    const v = await ok<{ passed: boolean; saved: { playbook: string; file: string; historySeq: number } }>('verify_game', { ...coin, saveAs: 'collect_coin' });
    expect(v.passed).toBe(true);
    expect(v.saved).toMatchObject({ playbook: 'collect_coin', file: 'playbooks/collect_coin.json', changed: true });
    expect(JSON.parse(readFileSync(store.path('playbooks/collect_coin.json'), 'utf8'))).toMatchObject({ scenario: coin.scenario, tags: ['smoke', 'coins'] });

    await ok('save_playbook', {
      id: 'stay_alive',
      scenario: 'the player survives standing still',
      tags: ['smoke'],
      screenshot: false,
      steps: [{ type: 'wait', ms: 1000 }],
      assertions: [{ assert: 'status', is: 'running' }, { assert: 'entity', id: 'player', field: 'health', equals: 3 }],
    });
    expect(await ok('list_playbooks')).toEqual({
      playbooks: [
        { id: 'collect_coin', scenario: coin.scenario, tags: ['smoke', 'coins'], steps: 3, checks: 2 },
        { id: 'stay_alive', scenario: 'the player survives standing still', tags: ['smoke'], steps: 1, checks: 2 },
      ],
    });

    expect(await ok<Board>('run_playbooks')).toMatchObject({
      passed: true,
      summary: '2/2 playbooks passed',
      results: [
        { id: 'collect_coin', passed: true, summary: 'PASS: 2/2 checks passed' },
        { id: 'stay_alive', passed: true },
      ],
    });
    expect((await ok<Board>('run_playbooks', { tags: ['coins'] })).results.map((r) => r.id)).toEqual(['collect_coin']);

    // A later change breaks the coin: the regression run says which playbook and which check.
    await ok('delete_game_object', { scene: 'level1', id: 'coin1' });
    const board = await ok<Board>('run_playbooks', { ids: ['collect_coin', 'stay_alive'] });
    expect(board.summary).toBe('1/2 playbooks passed');
    expect(board.results[0]).toMatchObject({ id: 'collect_coin', passed: false });
    expect(board.results[0].failures![0]).toMatch(/^FAIL coin collected — waitUntil event "collect" \{"entity":"coin1"\} occurred; not true after waiting 3000 ms; expected >= 1, got 0/);
  });

  it('does not save failed verifications; validates playbook files; delete and undo', async () => {
    const { ok, fail, call } = setup();
    const v = await ok<{ passed: boolean; saved: object }>('verify_game', { ...coin, assertions: [{ assert: 'gameWon' }], saveAs: 'win_now' });
    expect(v.saved).toEqual({ playbook: 'win_now', saved: false, why: 'the verification failed; fix it and verify again' });
    expect((await fail('run_playbooks')).error).toMatch(/No playbooks yet/);

    // Invalid playbooks are rejected on every write path (also raw file writes).
    expect((await fail('save_playbook', { id: 'bad', scenario: 'x', assertions: [{ assert: 'teleported' }] })).error).toBe('Invalid input for save_playbook');
    const raw = await fail('write_file', { path: 'playbooks/raw.json', content: JSON.stringify({ scenario: 'x', steps: [{ type: 'fly' }] }) });
    expect(raw.error).toBe('Change rejected: invalid playbook (nothing was written)');
    expect(raw.details![0]).toMatch(/^playbooks\/raw\.json: steps\[0\]/);

    await ok('save_playbook', { id: 'p1', ...coin });
    expect((await fail('run_playbooks', { ids: ['p2'] })).error).toBe('Unknown playbook(s): p2. Saved: p1');
    await ok('delete_playbook', { id: 'p1' });
    expect(await ok('list_playbooks')).toEqual({ playbooks: [] });
    await ok('undo');
    expect((await ok<{ playbooks: unknown[] }>('list_playbooks')).playbooks).toHaveLength(1);
    expect((await call('delete_playbook', { id: 'nope' })).ok).toBe(false);
  });
});
