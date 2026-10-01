import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('pathfinding through the agent tools', () => {
  it('an NPC walks to a target; the agent checks reachability and progress', async () => {
    const { ok } = setup();
    // The demo level is a side view with gravity; a flying (no Body) NPC still plans around solid platforms.
    await ok('create_game_object', {
      scene: 'level1',
      entity: { id: 'bird', transform: { x: 300, y: 200 }, components: { Sprite: { width: 12, height: 12 }, NavAgent: { target: 'player', speed: 250 } } },
    });
    const test = await ok<{ passed: boolean; checks: unknown[] }>('run_test', {
      steps: [{ type: 'waitUntil', expr: "entity('bird').nav.status == 'arrived'", maxMs: 5000 }],
      assertions: ["pathDistance('bird', 'player') != null", "events('nav_arrived') >= 1"],
    });
    expect(test.passed, JSON.stringify(test.checks)).toBe(true);
    await ok('run_game');
    await ok('wait', { ms: 100 });
    const s = await ok<{ entities: { nav?: { status: string; waypoints?: number } }[] }>('inspect_game_state', { ids: ['bird'] });
    expect(s.entities[0].nav).toMatchObject({ status: 'moving', target: 'player' });
  });
});
