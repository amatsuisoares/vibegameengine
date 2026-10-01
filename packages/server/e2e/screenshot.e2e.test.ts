import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { RuntimeHost } from '../src';
import { setup } from '../test/helpers';

const RUNS_DIR = fileURLToPath(new URL('../../../projects/demo-platformer/.vibe/runs', import.meta.url));
const hosts: RuntimeHost[] = [];
afterAll(async () => {
  for (const h of hosts) await h.close();
});

function pngSize(file: string) {
  const buf = readFileSync(file);
  expect(buf.subarray(1, 4).toString()).toBe('PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

type Shot = { path: string; frame: number; warning?: string };

describe('take_screenshot (Chromium)', () => {
  it('mirrors the headless run in the browser and returns PNG images', async () => {
    const t = setup(); // a copy of the demo outside the repo: assets come through request interception
    hosts.push(t.host);
    const { call, ok } = t;
    await ok('run_game');
    await ok('perform_inputs', { steps: [{ type: 'hold', key: 'D', ms: 1800 }, { type: 'tap', key: 'Space' }, { type: 'wait', ms: 150 }] });

    const r = await call('take_screenshot', {});
    if (!r.ok) throw new Error(r.error);
    const shot = r.result as Shot;
    expect(shot.warning).toBeUndefined(); // browser replay reproduced the headless state exactly
    expect(shot.path).toMatch(/^\.vibe\/runs\/run-.*\/001-f\d+\.png$/);
    expect(r.images).toHaveLength(1);
    expect(pngSize(r.images![0].path)).toEqual({ width: 800, height: 450 });

    // Incremental replay: more time passes, then an annotated shot of the same run.
    await ok('wait', { ms: 2000 });
    const debug = await call('take_screenshot', { annotate: true });
    if (!debug.ok) throw new Error(debug.error);
    expect((debug.result as Shot).warning).toBeUndefined();
    expect((debug.result as Shot).path).toMatch(/002-f\d+-debug\.png$/);
    expect(readFileSync(debug.images![0].path).equals(readFileSync(r.images![0].path))).toBe(false);

    // A restarted run (new project version) gets a fresh page.
    await ok('modify_game_object', { scene: 'level1', id: 'player', patch: { transform: { x: 300 } } });
    await ok('restart_game');
    const after = await call('take_screenshot', { annotate: true });
    if (!after.ok) throw new Error(after.error);
    expect((after.result as Shot).warning).toBeUndefined();
    expect((after.result as Shot).frame).toBe(0);

    // Keep copies next to the other e2e screenshots for manual inspection.
    mkdirSync(RUNS_DIR, { recursive: true });
    copyFileSync(r.images![0].path, `${RUNS_DIR}/host-play.png`);
    copyFileSync(debug.images![0].path, `${RUNS_DIR}/host-play-debug.png`);
    copyFileSync(after.images![0].path, `${RUNS_DIR}/host-restarted-debug.png`);
  });

  it('runs scripts in the browser exactly as in the headless run', async () => {
    const t = setup();
    hosts.push(t.host);
    const { call, ok } = t;
    const src = [
      'function onUpdate(self, game, dt) {',
      '  self.x += Math.sin(game.time * 3) * self.props.amp * dt + (Math.random() - 0.5);',
      '  self.get("Sprite").rotation += 4;',
      '}',
    ].join('\n');
    await ok('write_file', { path: 'scripts/wobble.js', content: src });
    for (const id of ['coin1', 'coin2']) {
      await ok('create_component', { scene: 'level1', id, type: 'Script', data: { src: 'scripts/wobble.js', props: { amp: 120 } } });
    }
    await ok('run_game', { seed: 3 });
    await ok('perform_inputs', { steps: [{ type: 'hold', key: 'D', ms: 1500 }] });
    const r = await call('take_screenshot', { annotate: true });
    if (!r.ok) throw new Error(r.error);
    expect((r.result as Shot).warning).toBeUndefined(); // seeded Math.random: same positions in Chromium
    mkdirSync(RUNS_DIR, { recursive: true });
    copyFileSync(r.images![0].path, `${RUNS_DIR}/host-scripts-debug.png`);
  });

  it('reports missing assets when editing and when rendering', async () => {
    const t = setup();
    hosts.push(t.host);
    await t.ok('run_game');
    const edit = await t.ok<{ warnings?: string[] }>('modify_project_config', {
      patch: { sounds: null, assets: [{ id: 'hero', type: 'spritesheet', path: 'missing.svg', frameWidth: 24, frameHeight: 32 }, { id: 'coin', type: 'spritesheet', path: 'coin.svg', frameWidth: 16, frameHeight: 16 }] },
    });
    expect(edit.warnings).toEqual(['config.assets(hero): file assets/missing.svg not found']);
    await t.ok('restart_game');
    // The image cannot load: the page draws a magenta placeholder and the problem is reported with the shot.
    const shot = await t.ok<{ renderWarnings?: string[] }>('take_screenshot', {});
    expect(shot.renderWarnings!.join('\n')).toContain('missing.svg');
    expect(shot.renderWarnings!.join('\n')).toContain('Sprite of "player"');
  });
});
