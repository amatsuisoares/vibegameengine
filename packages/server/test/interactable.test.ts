import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

type Ev = { type: string; entity?: string; via?: string; by?: string; action?: string };
type Obs = { events: Ev[] };

/** A sign next to the demo player's spawn (player box ends at x 92; the sign's starts at 114). */
async function withSign() {
  const t = setup();
  await t.ok('create_game_object', {
    scene: 'level1',
    entity: { id: 'sign', transform: { x: 130, y: 402 }, components: { Sprite: { width: 32, height: 32 }, Interactable: { action: 'read', label: 'Ler' } } },
  });
  await t.ok('set_rule', { scene: 'level1', rule: { id: 'reading', when: { event: 'interact', match: { action: 'read' } }, do: [{ action: 'addVar', var: 'reads', amount: 1 }] } });
  return t;
}

describe('interactables through the agent tools', () => {
  it('the agent interacts by key and by clicking the entity, and sees the interactable state', async () => {
    const { ok, fail } = await withSign();
    await ok('run_game');
    const byKey = await ok<Obs>('perform_inputs', { steps: [{ type: 'tap', key: 'E' }] });
    expect(byKey.events.filter((e) => e.type === 'interact')).toEqual([expect.objectContaining({ entity: 'sign', via: 'key', by: 'player', action: 'read' })]);

    const byClick = await ok<Obs>('click_mouse', { entity: 'sign' });
    expect(byClick.events.map((e) => [e.type, e.entity])).toEqual([['click', 'sign'], ['interact', 'sign'], ['rule', undefined]]);

    const state = await ok<{ vars: Record<string, number>; entities: { interactable?: unknown }[] }>('inspect_game_state', { ids: ['sign'] });
    expect(state.vars.reads).toBe(2);
    expect(state.entities[0].interactable).toEqual({ action: 'read', label: 'Ler', via: ['click', 'key'], enabled: true, uses: 2, inRange: ['player'] });

    expect((await fail('click_mouse', { entity: 'ghost' })).error).toMatch(/entity "ghost" does not exist/);
  });

  it('run_test clicks entities and asserts on interactions', async () => {
    const { ok } = await withSign();
    const r = await ok<{ passed: boolean; checks: unknown[] }>('run_test', {
      steps: [{ type: 'tap', key: 'E' }, { type: 'click', entity: 'sign' }],
      assertions: ["entity('sign').interactable.uses == 2", "events('interact') == 2", 'vars.reads == 2'],
    });
    expect(r.passed, JSON.stringify(r.checks)).toBe(true);
  });

  it('rejects an Interactable whose condition does not parse', async () => {
    const { fail } = setup();
    const r = await fail('create_game_object', {
      scene: 'level1',
      entity: { id: 'door', components: { Sprite: {}, Interactable: { condition: 'vars.keys >=' } } },
    });
    expect(r.details?.[0]).toMatch(/^scenes\.level1\.entities\(door\)\.components\.Interactable\.condition: /);
  });
});
