import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LiveRun } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

const BRAIN = `
function onStart(self, game) {
  const last = game.storage.get('lastSeen');
  if (last !== undefined) game.vars.awayHours = Math.round((game.clock.now - last) / 3600000);
}
function onUpdate(self, game) {
  if (game.frame % 60 === 0) game.storage.set('lastSeen', game.clock.now);
  if (game.input.text) game.vars.typed = (game.vars.typed || '') + game.input.text;
}`;

describe('clock and saved data through the tools', () => {
  it('starts runs with a clock and saved data, types text, jumps the clock and shows the data', async () => {
    const { ok, host, dir } = setup();
    await ok('write_file', { path: 'scripts/brain.js', content: BRAIN });
    await ok('create_game_object', { scene: 'level1', entity: { id: 'brain', components: { Script: { src: 'scripts/brain.js' } } } });

    const start = await ok<{ clock: string }>('run_game', {
      clock: { start: '2026-05-01T23:00:00Z', utcOffsetMinutes: -180 },
      storage: { lastSeen: Date.parse('2026-05-01T15:00:00Z') },
    });
    expect(start.clock).toBe('2026-05-01T20:00:00');
    const typed = await ok<{ clock: string }>('perform_inputs', { steps: [{ type: 'type', text: 'Kuro' }, { type: 'wait', ms: 1000 }] });
    expect(typed.clock).toBe('2026-05-01T20:00:01');

    const jumped = await ok<{ clock: string; advancedMs: number }>('advance_clock', { hours: 3, minutes: 30 });
    expect(jumped).toMatchObject({ advancedMs: 12_600_000, clock: '2026-05-01T23:30:01' });

    const state = await ok<{ vars: Record<string, unknown>; storage: Record<string, unknown>; clock: { hour: number } }>('inspect_game_state', {
      ids: [],
      storage: true,
    });
    expect(state.vars).toMatchObject({ awayHours: 8, typed: 'Kuro' });
    expect(state.storage.lastSeen).toBe(Date.parse('2026-05-01T23:00:01Z'));
    expect(state.clock.hour).toBeCloseTo(23.5, 1);

    // The published run carries clock and data, so the follow-mode page replays it exactly.
    const live = JSON.parse(readFileSync(join(dir, '.vibe', 'live.json'), 'utf8')) as LiveRun;
    expect(live.clock).toEqual({ start: '2026-05-01T23:00:00Z', utcOffsetMinutes: -180 });
    expect(live.storage).toEqual({ lastSeen: Date.parse('2026-05-01T15:00:00Z') });

    // restart_game keeps the same starting clock and data.
    const again = await ok<{ clock: string }>('restart_game');
    expect(again.clock).toBe('2026-05-01T20:00:00');
    expect(host.session!.game.storage.snapshot()).toEqual({ lastSeen: Date.parse('2026-05-01T15:00:00Z') });

    // run_test supports the same options plus clock jumps.
    const t = await ok<{ passed: boolean }>('run_test', {
      clock: { start: '2026-05-01T12:00:00Z' },
      storage: { lastSeen: Date.parse('2026-05-01T10:00:00Z') },
      steps: [{ type: 'wait', ms: 100 }, { type: 'advanceClock', hours: 12 }, { type: 'wait', ms: 50 }],
      assertions: ['vars.awayHours == 2', 'clock.hour >= 24 || clock.hour < 1'],
    });
    expect(t.passed).toBe(true);
  });
});
