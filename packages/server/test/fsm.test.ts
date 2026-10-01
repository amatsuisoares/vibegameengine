import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('state machines through the agent tools', () => {
  it('creates a machine with minimal JSON, plays, and sees the state in observations and assertions', async () => {
    const { ok } = setup();
    await ok('create_game_object', {
      scene: 'level1',
      entity: {
        id: 'turret',
        transform: { x: 300, y: 380 },
        components: {
          Sprite: {},
          StateMachine: {
            initial: 'idle',
            states: { idle: { transitions: [{ to: 'alert', when: "distance(self, 'player') < 150" }] }, alert: { enter: [{ action: 'setVar', var: 'alerts', value: 1 }] } },
          },
        },
      },
    });
    await ok('run_game');
    const start = await ok<{ entities: { state?: string }[] }>('inspect_game_state', { ids: ['turret'] });
    expect(start.entities[0].state).toBe('idle');
    const r = await ok<{ ok: boolean; events: { type: string; to?: string }[] }>('wait_until', { expr: "entity('turret').state == 'alert'", maxMs: 100 });
    expect(r.ok).toBe(false);
    await ok('press_key', { key: 'D' });
    const reached = await ok<{ ok: boolean; events: { type: string; to?: string }[] }>('wait_until', { expr: "entity('turret').state == 'alert'", maxMs: 5000 });
    expect(reached.ok).toBe(true);
    expect(reached.events.filter((e) => e.type === 'state_change').map((e) => e.to)).toEqual(['alert']);

    const test = await ok<{ passed: boolean; checks: unknown[] }>('run_test', {
      steps: [{ type: 'hold', key: 'D', ms: 2000 }],
      assertions: ["entity('turret').prevState == 'idle'", 'vars.alerts == 1', "events('state_change') == 2"],
    });
    expect(test.passed, JSON.stringify(test.checks)).toBe(true);
  });

  it('rejects a transition expression that does not parse', async () => {
    const { fail } = setup();
    const r = await fail('create_game_object', {
      scene: 'level1',
      entity: { id: 'bad', components: { StateMachine: { initial: 'a', states: { a: { transitions: [{ to: 'a', when: 'self.x >' }] } } } } },
    });
    expect(r.details?.[0]).toMatch(/^scenes\.level1\.entities\(bad\)\.components\.StateMachine\.states\.a\.transitions\[0\]\.when: /);
  });
});
