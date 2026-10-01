import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('particles through the agent tools', () => {
  it('collecting a coin puffs sparkles; the agent sees the burst event and the emitter state', async () => {
    const { ok } = setup();
    await ok('create_game_object', {
      scene: 'level1',
      entity: { id: 'sparkles', transform: { x: 0, y: 0 }, components: { ParticleEmitter: { rate: 0, colors: ['#ffd700'], text: '★', size: 12 } } },
    });
    await ok('set_rule', { scene: 'level1', rule: { id: 'shine', when: { event: 'collect' }, do: [{ action: 'move', target: 'sparkles', x: 0, y: 0 }, { action: 'burst', target: 'sparkles', count: 12 }] } });
    const test = await ok<{ passed: boolean; checks: unknown[] }>('run_test', {
      steps: [{ type: 'keyDown', key: 'D' }, { type: 'waitUntil', expr: "events('particles') >= 1", maxMs: 5000 }],
      assertions: ["entity('sparkles').particles.alive == 12"],
    });
    expect(test.passed, JSON.stringify(test.checks)).toBe(true);
  });
});
