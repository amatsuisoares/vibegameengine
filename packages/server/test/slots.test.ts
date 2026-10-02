import { Game } from '@vibe/engine';
import { describe, expect, it } from 'vitest';
import { setupWithShots } from './helpers';

describe('save slots in agent runs', () => {
  it('starts runs with save slots, which the game can load (and the screenshot replays)', async () => {
    const { store, ok, call, shots } = setupWithShots();
    // A slot saved in another session, after walking right.
    const game = new Game(store.project());
    game.apply({ op: 'keyDown', key: 'ArrowRight' });
    game.step(60);
    game.saveSlot('s1', 'Depois de andar');
    const x = game.entity('player')!.x;
    const slots = game.saves.snapshot();

    await ok('set_rule', { scene: 'level1', rule: { id: 'continue', when: { start: true }, if: "hasSlot('s1')", do: [{ action: 'loadSlot', slot: 's1' }] } });
    const run = await ok<{ frame: number }>('run_game', { slots: JSON.parse(JSON.stringify(slots)) });
    expect(run).toBeDefined();
    await ok('wait', { ms: 50 });
    const state = await ok<{ entities: { id: string; x: number }[]; slots: { name: string; label: string }[] }>('inspect_game_state', { ids: ['player'] });
    expect(state.slots).toEqual([expect.objectContaining({ name: 's1', label: 'Depois de andar', scene: 'level1' })]);
    expect(state.entities[0].x).toBeCloseTo(x, 0);

    const t = await ok<{ passed: boolean }>('run_test', { slots, steps: [{ type: 'wait', ms: 50 }], assertions: [`entity('player').x > 150`] });
    expect(t.passed).toBe(true);
    // The screenshot replays the run with the same slots, so it shows the loaded game.
    await ok('take_screenshot');
    expect(shots.requests.at(-1)!.slots).toEqual(JSON.parse(JSON.stringify(slots)));
    expect((await call('run_game', { slots: { 'bad name': {} } })).ok).toBe(false);
  });
});
