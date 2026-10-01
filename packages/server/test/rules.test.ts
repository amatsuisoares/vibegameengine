import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('rule tools', () => {
  it('adds, replaces and deletes rules with minimal JSON, and they run', async () => {
    const { ok, fail, dir } = setup();
    const add = await ok<{ changed: boolean; replaced: boolean }>('set_rule', {
      scene: 'level1',
      rule: { id: 'rich', when: { expr: 'vars.coins >= 1' }, do: [{ action: 'setText', target: 'hud', text: 'Rico!' }, { action: 'heal', target: 'player' }] },
      reason: 'feedback for the first coin',
    });
    expect(add).toMatchObject({ changed: true, replaced: false });
    const scene = JSON.parse(readFileSync(join(dir, 'scenes', 'level1.json'), 'utf8'));
    // Defaults (once, enabled, heal amount) are not written.
    expect(scene.rules).toEqual([{ id: 'rich', when: { expr: 'vars.coins >= 1' }, do: [{ action: 'setText', target: 'hud', text: 'Rico!' }, { action: 'heal', target: 'player' }] }]);

    await ok('run_game');
    await ok('perform_inputs', { steps: [{ type: 'keyDown', key: 'D' }, { type: 'wait', ms: 550 }, { type: 'tap', key: 'Space', ms: 150 }, { type: 'wait', ms: 600 }] });
    const { events } = await ok<{ events: { type: string; rule?: string }[] }>('read_events', { type: 'rule' });
    expect(events.map((e) => e.rule)).toEqual(['rich']);
    const hud = await ok<{ entities: { components: { Text: { text: string } } }[] }>('inspect_game_state', { ids: ['hud'], components: true });
    expect(hud.entities[0].components.Text.text).toBe('Rico!');

    const replaced = await ok<{ replaced: boolean }>('set_rule', {
      scene: 'level1',
      rule: { id: 'rich', when: { expr: 'vars.coins >= 2' }, once: true, do: [{ action: 'win' }] },
    });
    expect(replaced.replaced).toBe(true);

    // Rejected edits: bad expression, unknown target.
    const badExpr = await fail('set_rule', { scene: 'level1', rule: { id: 'x', when: { expr: 'vars.coins >= ' }, do: [{ action: 'win' }] } });
    expect(badExpr.details?.[0]).toMatch(/^scenes\.level1\.rules\(x\)\.when\.expr: /);
    const badTarget = await fail('set_rule', { scene: 'level1', rule: { id: 'y', when: { start: true }, do: [{ action: 'destroy', target: 'ghost' }] } });
    expect(badTarget.details).toEqual(['scenes.level1.rules(y).do[0].target: entity "ghost" does not exist']);
    const badShape = await fail('set_rule', { scene: 'level1', rule: { id: 'z', when: { start: true }, do: [{ action: 'explode' }] } });
    expect(badShape.error).toBe('Invalid input for set_rule');

    await ok('delete_rule', { scene: 'level1', id: 'rich' });
    expect(JSON.parse(readFileSync(join(dir, 'scenes', 'level1.json'), 'utf8')).rules).toBeUndefined();
    expect((await fail('delete_rule', { scene: 'level1', id: 'rich' })).error).toMatch(/Rule "rich" does not exist/);
  });
});
