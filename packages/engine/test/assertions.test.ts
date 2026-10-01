import { AssertionSchema, type AssertionInput, type EntityInput, type RuleInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { checkAssertion, describeAssertion, Game } from '../src';

function game(entities: EntityInput[], rules: RuleInput[] = []) {
  return Game.fromRaw({
    config: { name: 't', startScene: 'main', gravity: 0 },
    scenes: { main: { id: 'main', width: 800, height: 400, vars: { coins: 0, name: 'x' }, rules, entities } },
  });
}
const check = (g: Game, a: AssertionInput) => checkAssertion(g, AssertionSchema.parse(a));

const world = () =>
  game(
    [
      { id: 'player', tags: ['player'], transform: { x: 100, y: 200 }, components: { Health: { max: 3 } } },
      { id: 'coin1', tags: ['coin'], transform: { x: 130, y: 200 }, components: { Sprite: { width: 10, height: 10 } } },
      { id: 'coin2', tags: ['coin'], transform: { x: 600, y: 200 } },
      {
        id: 'guard',
        transform: { x: 400, y: 200 },
        components: { StateMachine: { initial: 'idle', states: { idle: { transitions: [{ to: 'alert', when: 'vars.coins >= 1' }] }, alert: {} } } },
      },
    ],
    [
      { id: 'grab', when: { start: true }, do: [{ action: 'addVar', var: 'coins', amount: 1 }, { action: 'emit', event: 'collect', data: { entity: 'coin1' } }, { action: 'destroy', target: 'coin1' }] },
    ],
  );

describe('structured assertions', () => {
  it('entities: exists, position, distance, snapshot fields and components', () => {
    const g = world();
    g.step(2);
    expect(check(g, { assert: 'entityExists', id: 'player' })).toMatchObject({ pass: true, label: 'entity "player" exists' });
    expect(check(g, { assert: 'entityExists', id: 'coin1', exists: false })).toMatchObject({ pass: true });
    expect(check(g, { assert: 'entityExists', id: 'coin' })).toMatchObject({ pass: false, actual: false, evidence: { exists: false, similarIds: ['coin2'] } });
    expect(check(g, { assert: 'entityAt', id: 'player', x: 102 })).toMatchObject({ pass: true });
    expect(check(g, { assert: 'entityAt', id: 'player', x: 300, y: 200 })).toMatchObject({ pass: false, actual: { x: 100, y: 200 }, evidence: { off: { dx: -200, dy: 0 } } });
    expect(check(g, { assert: 'entityNear', id: 'player', target: 'guard', within: 50 })).toMatchObject({ pass: false, actual: 300 });
    expect(check(g, { assert: 'entity', id: 'player', field: 'health', equals: 3 })).toMatchObject({ pass: true, label: 'entity("player").health == 3' });
    expect(check(g, { assert: 'entity', id: 'player', field: 'mana', gt: 0 })).toMatchObject({ pass: false, actual: null, evidence: { fields: expect.arrayContaining(['x', 'health']) } });
    expect(check(g, { assert: 'component', id: 'player', component: 'Health', field: 'max', gte: 3 })).toMatchObject({ pass: true });
    expect(check(g, { assert: 'component', id: 'player', component: 'Health' })).toMatchObject({ pass: true, label: '"player" has Health' });
    expect(check(g, { assert: 'component', id: 'player', component: 'Body' })).toMatchObject({ pass: false, evidence: { components: ['Health'] } });
  });

  it('state machines, variables, counts, events, scene and status', () => {
    const g = world();
    g.step(2);
    expect(check(g, { assert: 'state', id: 'guard', is: 'alert' })).toMatchObject({ pass: true });
    expect(check(g, { assert: 'state', id: 'guard', is: 'idle' })).toMatchObject({
      pass: false,
      actual: 'alert',
      evidence: { prevState: 'idle', recentChanges: ['start->idle @0', 'idle->alert @0'] },
    });
    expect(check(g, { assert: 'variable', var: 'coins', equals: 1 })).toMatchObject({ pass: true, label: 'vars.coins == 1' });
    expect(check(g, { assert: 'variable', var: 'coins', gte: 2, lt: 5 })).toMatchObject({ pass: false, expected: '>= 2 and < 5', actual: 1 });
    expect(check(g, { assert: 'variable', var: 'lives' })).toMatchObject({ pass: false, actual: null, evidence: { vars: ['score', 'coins', 'name'] } });
    expect(check(g, { assert: 'variable', var: 'name', equals: 'x' })).toMatchObject({ pass: true });
    expect(check(g, { assert: 'count', tag: 'coin' })).toMatchObject({ pass: true, actual: 1 });
    expect(check(g, { assert: 'count', tag: 'coin', equals: 0 })).toMatchObject({ pass: false });

    expect(check(g, { assert: 'eventOccurred', event: 'collect', match: { entity: 'coin1' } })).toMatchObject({ pass: true, actual: 1 });
    const other = check(g, { assert: 'eventOccurred', event: 'collect', match: { entity: 'coin2' } });
    expect(other).toMatchObject({ pass: false, actual: 0, evidence: { otherEventsOfType: [expect.objectContaining({ entity: 'coin1' })] } });
    expect(check(g, { assert: 'eventOccurred', event: 'damage', equals: 0 })).toMatchObject({ pass: true, label: 'event "damage" == 0' });
    expect(check(g, { assert: 'eventOccurred', event: 'jump' }).evidence).toMatchObject({ eventTypesSeen: expect.arrayContaining(['scene_loaded', 'collect']) });

    expect(check(g, { assert: 'scene', is: 'main' })).toMatchObject({ pass: true });
    expect(check(g, { assert: 'gameWon' })).toMatchObject({ pass: false, expected: '"won"', actual: 'running' });
    expect(check(g, { assert: 'status', is: 'running' })).toMatchObject({ pass: true });
    const won = game([], [{ id: 'w', when: { start: true }, do: [{ action: 'win' }] }]);
    won.step(1);
    expect(check(won, { assert: 'gameWon' })).toMatchObject({ pass: true });
    expect(check(won, { assert: 'gameLost' })).toMatchObject({ pass: false, evidence: { endEvents: [expect.objectContaining({ type: 'win' })] } });
  });

  it('validates assertions and describes them in plain words', () => {
    expect(AssertionSchema.safeParse({ assert: 'entityAt', id: 'p' }).success).toBe(false);
    expect(AssertionSchema.safeParse({ assert: 'teleport', id: 'p' }).success).toBe(false);
    expect(AssertionSchema.safeParse({ assert: 'status', is: 'paused' }).success).toBe(false);
    expect(describeAssertion(AssertionSchema.parse({ assert: 'eventOccurred', event: 'collect', match: { entity: 'coin1' }, gte: 2 }))).toBe(
      'event "collect" {"entity":"coin1"} >= 2',
    );
    expect(describeAssertion(AssertionSchema.parse({ assert: 'entityAt', id: 'p', y: 10 }))).toBe('entity "p" at y 10 (±4)');
  });
});
