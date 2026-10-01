import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('Utility AI through the agent tools', () => {
  it('an NPC scores its options from the game state; the agent sees the scores and the choice', async () => {
    const { ok } = setup();
    await ok('create_game_object', {
      scene: 'level1',
      entity: {
        id: 'guard',
        transform: { x: 400, y: 380 },
        components: {
          Sprite: {},
          StateMachine: { initial: 'rest', states: { rest: {}, watch: {} } },
          UtilityAI: {
            intervalMs: 200,
            options: { rest: { score: 0.3 }, watch: { score: "clamp(300 - distance(self, 'player'), 0, 300) / 300" } },
          },
        },
      },
    });
    await ok('run_game');
    await ok('wait', { ms: 100 });
    const far = await ok<{ entities: { ai?: { choice: string; scores: Record<string, number> }; state?: string }[] }>('inspect_game_state', { ids: ['guard'] });
    expect(far.entities[0]).toMatchObject({ state: 'rest', ai: { choice: 'rest', scores: { rest: 0.3, watch: 0 } } });
    await ok('press_key', { key: 'D' });
    const r = await ok<{ ok: boolean; events: { type: string; choice?: string }[] }>('wait_until', { expr: "entity('guard').ai.choice == 'watch'", maxMs: 5000 });
    expect(r.ok).toBe(true);
    expect(r.events.filter((e) => e.type === 'ai_choice').map((e) => e.choice)).toEqual(['watch']);
    const near = await ok<{ entities: { state?: string }[] }>('inspect_game_state', { ids: ['guard'] });
    expect(near.entities[0].state).toBe('watch');
  });

  it('rejects a score expression that does not parse', async () => {
    const { fail } = setup();
    const r = await fail('create_game_object', { scene: 'level1', entity: { id: 'bad', components: { UtilityAI: { options: { a: { score: '1 -' } } } } } });
    expect(r.details?.[0]).toMatch(/^scenes\.level1\.entities\(bad\)\.components\.UtilityAI\.options\.a\.score: /);
  });
});
