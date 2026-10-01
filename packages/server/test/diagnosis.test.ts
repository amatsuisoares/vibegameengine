import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type Guess = { system: string; score: number; why: string[] };
type Diag = {
  failures: { check: string; frame: number; entities?: Record<string, Record<string, unknown>>; variables?: Record<string, { value: unknown; writtenBy: unknown }>; events?: Record<string, { count: number; last?: string[] }> }[];
  likelySystems: Guess[];
  errors?: { source?: string; message: string }[];
  timeline: string[];
};
type Verified = { passed: boolean; report: string[]; diagnosis?: Diag };

const systems = (d: Diag) => d.likelySystems.map((g) => g.system);

describe('diagnostic report', () => {
  it('a missing coin: evidence about the entity, the event and the variable, and the likely systems', async () => {
    const { ok } = setup();
    await ok('delete_game_object', { scene: 'level1', id: 'coin1' });
    const v = await ok<Verified>('verify_game', {
      scenario: 'player collects the first coin',
      screenshot: false,
      steps: [{ type: 'hold', key: 'D', ms: 2500 }],
      assertions: [
        { name: 'coin collected', assert: 'eventOccurred', event: 'collect', match: { entity: 'coin1' } },
        { assert: 'variable', var: 'coins', equals: 1 },
        { name: 'player moved right', expr: "entity('player').x > 300" },
      ],
    });
    expect(v.passed).toBe(false);
    const d = v.diagnosis!;
    expect(d.failures.map((f) => f.check)).toEqual(['coin collected', 'vars.coins == 1']); // the passing check gets no evidence
    expect(d.failures[0].entities).toEqual({ coin1: { exists: false, neverSeen: true } });
    expect(d.failures[0].events).toEqual({ collect: { count: 0 } });
    expect(d.failures[1].variables!.coins).toEqual({ value: 0, writtenBy: ['Collectible of level1/coin4, level1/coin2, level1/coin3'] });
    expect(systems(d).slice(0, 3)).toEqual(['scene setup', 'collectible', 'collision']);
    expect(d.likelySystems[0].why[0]).toBe('entity "coin1" never existed (wrong id, or it is created later / in another scene)');
    expect(v.report.at(-1)).toMatch(/^LIKELY scene setup \(entity "coin1" never existed .*\); collectible \(no "collect" event happened\); collision/);
  });

  it('position checks point at movement; expression checks are parsed for entities and variables', async () => {
    const { ok } = setup();
    const v = await ok<Verified>('verify_game', {
      scenario: 'player reaches the end',
      screenshot: false,
      steps: [{ type: 'hold', key: 'D', ms: 1000 }],
      assertions: ["entity('player').x > 2000 && vars.lives == 3"],
    });
    const d = v.diagnosis!;
    expect(d.failures[0].entities!.player).toMatchObject({ grounded: true, components: expect.arrayContaining(['PlatformerController']) });
    expect(d.failures[0].variables).toEqual({ lives: { value: null, writtenBy: 'nobody (no rule or script mentions it)' } });
    expect(systems(d)).toEqual(expect.arrayContaining(['controller (movement/jump)', 'physics']));
    expect(d.timeline).toEqual(expect.arrayContaining(['@0 scene_loaded scene=level1']));
  });

  it('blocked interactions and runtime errors are strong signals', async () => {
    const { ok } = setup();
    await ok('write_file', { path: 'scripts/boom.js', content: 'function onUpdate(self, game) { if (game.time > 0.2) undefinedThing(); }' });
    await ok('create_component', { scene: 'level1', id: 'coin2', type: 'Script', data: { src: 'scripts/boom.js' } });
    await ok('create_component', { scene: 'level1', id: 'coin1', type: 'Interactable', data: { via: ['click'], condition: 'vars.coins >= 5' } });
    const v = await ok<Verified>('verify_game', {
      scenario: 'clicking the coin',
      screenshot: false,
      steps: [{ type: 'wait', ms: 400 }, { type: 'click', entity: 'coin1' }, { type: 'wait', ms: 100 }],
      assertions: [{ assert: 'eventOccurred', event: 'interact', match: { entity: 'coin1' } }],
    });
    const d = v.diagnosis!;
    // The blocked interaction explains the failing check; the (unrelated) script crash comes next.
    expect(d.likelySystems[0]).toMatchObject({ system: 'interaction', why: expect.arrayContaining(['interaction with "coin1" was blocked (condition)']) });
    expect(d.likelySystems[1]).toMatchObject({ system: 'script scripts/boom.js', why: [expect.stringMatching(/^runtime error: Script error: .*undefinedThing/)] });
    expect(d.errors![0]).toMatchObject({ source: 'script' });
    expect(d.failures[0].entities!.coin1).toMatchObject({ lastEvents: expect.arrayContaining([expect.stringMatching(/interact_blocked .*reason=condition/)]) });
  });

  it('passing verifications have no diagnosis; failing playbooks list their likely systems', async () => {
    const { ok } = setup();
    const pass = await ok<Verified>('verify_game', { scenario: 'idle', screenshot: false, assertions: [{ assert: 'status', is: 'running' }] });
    expect(pass.diagnosis).toBeUndefined();
    await ok('save_playbook', { id: 'coin', scenario: 'coin', screenshot: false, steps: [{ type: 'hold', key: 'D', ms: 2500 }], assertions: [{ assert: 'eventOccurred', event: 'collect', match: { entity: 'coin1' } }] });
    await ok('delete_game_object', { scene: 'level1', id: 'coin1' });
    const board = await ok<{ results: { likelySystems?: string[]; failures?: string[] }[] }>('run_playbooks');
    expect(board.results[0].likelySystems).toEqual(['scene setup', 'collision', 'collectible']);
    expect(board.results[0].failures!.some((l) => l.startsWith('LIKELY'))).toBe(false);
  });
});
