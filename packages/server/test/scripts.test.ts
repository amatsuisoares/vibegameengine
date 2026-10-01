import { describe, expect, it } from 'vitest';
import { checkScriptSyntax } from '../src';
import { setup } from './helpers';

type Obs = { frame: number; status: string; console: { level: string; message: string }[]; events: { type: string }[] };

const SPINNER = ['function onUpdate(self, game, dt) {', '  self.get("Sprite").rotation = (game.frame * self.props.speed) % 360;', '}', ''].join('\n');

describe('scripts through the tools', () => {
  it('checks syntax with the line of the error', () => {
    expect(checkScriptSyntax('scripts/a.js', 'function onUpdate() {}')).toBeNull();
    expect(checkScriptSyntax('scripts/a.js', 'let a = 1;\nlet b = ;\n')).toBe("scripts/a.js:2: SyntaxError: Unexpected token ';'");
  });

  it('writes a script, rejects broken versions, attaches it and runs it', async () => {
    const { ok, fail, call } = setup();
    const bad = await fail('write_file', { path: 'scripts/bouncer.js', content: 'function onUpdate(self) {\n  self.vy = -;\n}\n' });
    expect(bad.error).toMatch(/Change rejected/);
    expect(bad.details).toEqual(["scripts/bouncer.js:2: SyntaxError: Unexpected token ';'"]);

    // Attaching a script that does not exist yet is rejected too.
    const missing = await fail('create_component', { scene: 'level1', id: 'coin1', type: 'Script', data: { src: 'scripts/bouncer.js' } });
    expect(missing.details?.[0]).toMatch(/Script\.src: script file "scripts\/bouncer\.js" does not exist/);

    const src = ['function onUpdate(self, game) {', '  if (game.frame === 5) self.state.missing.call();', '  self.y = 390 + Math.sin(game.time * 4) * 6;', '}', ''].join('\n');
    expect((await ok<{ changed: boolean }>('write_file', { path: 'scripts/bouncer.js', content: src })).changed).toBe(true);
    await ok('create_component', { scene: 'level1', id: 'coin1', type: 'Script', data: { src: 'scripts/bouncer.js' } });

    await ok('run_game');
    const obs = await ok<Obs>('wait', { ms: 200 });
    expect(obs.status).toBe('running');
    expect(obs.console).toHaveLength(1);
    expect(obs.console[0].message).toMatch(/scripts\/bouncer\.js:2:\d+ in onUpdate of "coin1": TypeError/);
    expect(obs.events.map((e) => e.type)).toContain('script_error');

    // Fix it with edit_file and play again: the coin bobs.
    await ok('edit_file', { path: 'scripts/bouncer.js', oldText: '  if (game.frame === 5) self.state.missing.call();\n', newText: '' });
    await ok('restart_game');
    const fixed = await ok<Obs>('wait', { ms: 200 });
    expect(fixed.console).toEqual([]);
    const y = (await ok<{ entities: { y: number }[] }>('inspect_game_state', { ids: ['coin1'] })).entities[0].y;
    expect(y).not.toBe(390);
    expect(Math.abs(y - 390)).toBeLessThanOrEqual(6);

    // Undo the edit restores the broken script (history covers scripts like any project file).
    const undo = await call('undo');
    expect(undo.ok).toBe(true);
  });

  it('includes scripts in the raw project used for replays (screenshots, follow mode)', async () => {
    const { ok, host } = setup();
    await ok('write_file', { path: 'scripts/spin.js', content: SPINNER });
    await ok('create_component', { scene: 'level1', id: 'coin2', type: 'Script', data: { src: 'scripts/spin.js', props: { speed: 6 } } });
    await ok('create_component', { scene: 'level1', id: 'coin3', type: 'Script', data: { src: 'scripts/spin.js', props: { speed: 2 } } });
    await ok('run_game');
    expect(host.session!.raw.scripts).toEqual({ 'scripts/spin.js': SPINNER });
    await ok('wait', { ms: 500 });
    const state = await ok<{ entities: { id: string; components: { Sprite: { rotation: number } } }[] }>('inspect_game_state', {
      ids: ['coin2', 'coin3'],
      components: true,
    });
    expect(state.entities.map((e) => e.components.Sprite.rotation)).toEqual([(29 * 6) % 360, 29 * 2]);
  });
});
