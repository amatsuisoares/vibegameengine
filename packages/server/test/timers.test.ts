import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

describe('timers through the agent tools', () => {
  it('a rule with a delayed action: the agent sees it pending and then happening', async () => {
    const { ok, tools } = setup();
    expect(JSON.stringify(tools.definitions().find((t) => t.name === 'set_rule'))).toContain('cancelTimer');
    await ok('set_rule', {
      scene: 'level1',
      rule: { id: 'late', when: { start: true }, do: [{ action: 'after', ms: 1500, id: 'hello', do: [{ action: 'setVar', var: 'greeted', value: true }] }] },
    });
    await ok('run_game');
    const early = await ok<{ ok: boolean }>('wait_until', { expr: 'vars.greeted == true', maxMs: 1000 });
    expect(early.ok).toBe(false);
    const later = await ok<{ ok: boolean; waitedMs: number }>('wait_until', { expr: 'vars.greeted == true', maxMs: 1000 });
    expect(later.ok).toBe(true);
  });

  it('script timers show in the entity state', async () => {
    const { ok } = setup();
    await ok('write_file', { path: 'scripts/blink.js', content: "function onStart(self) { self.every(400, () => { self.enabled = true; }, 'blink'); self.cooldown('x', 1000); }" });
    await ok('create_game_object', { scene: 'level1', entity: { id: 'lamp', components: { Sprite: {}, Script: { src: 'scripts/blink.js' } } } });
    await ok('run_game');
    await ok('wait', { ms: 100 });
    const s = await ok<{ entities: { timers?: unknown; cooldowns?: unknown }[] }>('inspect_game_state', { ids: ['lamp'] });
    expect(s.entities[0]).toMatchObject({ timers: [{ id: 'blink', ms: 300, every: 400 }], cooldowns: { x: 900 } });
  });
});
