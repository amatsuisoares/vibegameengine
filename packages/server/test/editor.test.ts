import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

/** What the runtime page writes when the user picks a row in the hierarchy panel. */
function select(dir: string, value: unknown) {
  mkdirSync(join(dir, '.vibe'), { recursive: true });
  writeFileSync(join(dir, '.vibe', 'selection.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('get_selection', () => {
  it('says when nothing is selected', async () => {
    const { ok } = setup();
    expect(await ok('get_selection')).toMatchObject({ selection: null, note: expect.stringMatching(/Nothing selected/) });
  });

  it('returns the selected entity with its data', async () => {
    const { dir, ok } = setup();
    select(dir, { version: 1, scene: 'level1', entity: 'coin1', at: Date.UTC(2026, 0, 1) });
    const r = await ok<{ selection: unknown; raw: { id: string }; effective: { components: Record<string, unknown> }; inYourRun?: unknown }>('get_selection');
    expect(r.selection).toEqual({ scene: 'level1', entity: 'coin1', selectedAt: '2026-01-01T00:00:00.000Z' });
    expect(r.raw.id).toBe('coin1');
    expect(r.effective.components.Collectible).toBeDefined();
    expect(r.inYourRun).toBeUndefined();
  });

  it('adds the live snapshot when the agent run is in that scene', async () => {
    const { dir, ok } = setup();
    select(dir, { version: 1, scene: 'level1', entity: 'player' });
    await ok('run_game');
    await ok('wait', { ms: 200 });
    const r = await ok<{ inYourRun: { id: string; x: number } }>('get_selection');
    expect(r.inYourRun).toMatchObject({ id: 'player' });
  });

  it('selecting the scene itself, outdated and unreadable selections', async () => {
    const { dir, ok } = setup();
    select(dir, { version: 1, scene: 'level1', entity: null });
    expect(await ok('get_selection')).toEqual({ selection: { scene: 'level1', entity: null } });

    select(dir, { version: 1, scene: 'level1', entity: 'coin99' });
    expect(await ok('get_selection')).toMatchObject({ note: expect.stringMatching(/not in the scene file/) });

    select(dir, { version: 1, scene: 'gone', entity: 'x' });
    expect(await ok('get_selection')).toMatchObject({ note: expect.stringMatching(/no longer exists/) });

    select(dir, '{oops');
    expect(await ok('get_selection')).toMatchObject({ selection: null, note: expect.stringMatching(/unreadable/) });
  });

  it('is read-only (not recorded in the history)', async () => {
    const { dir, ok } = setup();
    select(dir, { version: 1, scene: 'level1', entity: 'coin1' });
    const before = await ok('get_history');
    await ok('get_selection');
    expect(await ok('get_history')).toEqual(before);
  });
});
