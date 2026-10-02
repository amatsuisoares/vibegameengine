import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';

const MIN = 60_000;

function game(opts: { storage?: Record<string, unknown>; minGapMs?: number; rules?: unknown[]; start?: string } = {}) {
  const entities: EntityInput[] = [{ id: 'cat', transform: { x: 0, y: 0 }, components: { Sprite: {} } }];
  return Game.fromRaw(
    {
      config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300, notifications: { minGapMs: opts.minGapMs ?? 0 } },
      scenes: { main: { id: 'main', width: 400, height: 300, entities, rules: opts.rules ?? [] } },
    },
    { seed: 1, storage: opts.storage, clock: { start: opts.start ?? '2026-03-10T09:00:00Z' } },
  );
}

const shown = (g: Game) => g.events(0, 'notification').map((e) => e.kind);

describe('Notifier', () => {
  it('shows a notification as an event and logs it; the same kind waits its game-clock cooldown, kept across sessions', () => {
    const g = game();
    expect(g.notify('hungry', 'The cat seems hungry.', { cooldownMs: 30 * MIN, entity: 'cat', data: { need: 'food' } })).toBe(true);
    expect(g.events(0, 'notification')[0]).toMatchObject({ kind: 'hungry', text: 'The cat seems hungry.', priority: 1, entity: 'cat', need: 'food' });
    expect(g.notify('hungry', 'again', { cooldownMs: 30 * MIN })).toBe(false);
    g.apply({ op: 'advanceClock', ms: 31 * MIN });
    expect(g.notify('hungry', 'The cat seems hungry.', { cooldownMs: 30 * MIN })).toBe(true);
    expect(g.notifications.log().map((x) => x.kind)).toEqual(['hungry', 'hungry']);
    expect(g.notifications.log(undefined, 'cat')).toHaveLength(1); // only the first one was about the cat

    const next = game({ storage: g.storage.snapshot(), start: '2026-03-10T09:40:00Z' }); // reopened 9 minutes later
    expect(next.notify('hungry', 'x', { cooldownMs: 30 * MIN })).toBe(false); // the clock cooldown survived
    next.notifications.clear();
    expect(next.notify('hungry', 'x', { cooldownMs: 30 * MIN })).toBe(true);
  });

  it('realCooldownMs holds even when the clock flies (600×)', () => {
    const g = game();
    g.notify('bored', 'b', { cooldownMs: MIN, realCooldownMs: 20_000 });
    g.apply({ op: 'advanceClock', ms: 10 * MIN });
    g.step(60); // 1 s of real time
    expect(g.notify('bored', 'b', { cooldownMs: MIN, realCooldownMs: 20_000 })).toBe(false);
    g.step(60 * 20);
    expect(g.notify('bored', 'b', { cooldownMs: MIN, realCooldownMs: 20_000 })).toBe(true);
  });

  it('minGapMs: right after one, background (priority 0) and lower-priority ones are dropped; equal or higher pass', () => {
    const g = game({ minGapMs: 4000 });
    g.notify('petted', 'liked it', { priority: 2 });
    expect(g.notify('bored', 'bored', { priority: 0 })).toBe(false);
    expect(g.notify('ate', 'ate', { priority: 1 })).toBe(false);
    expect(g.notify('again', 'again', { priority: 2 })).toBe(true);
    g.step(60 * 5);
    expect(g.notify('bored', 'bored', { priority: 0 })).toBe(true);
    expect(shown(g)).toEqual(['petted', 'again', 'bored']);
  });

  it('the rule action "notify" goes through the same notifier', () => {
    const g = game({ rules: [{ id: 'hello', when: { start: true }, do: [{ action: 'notify', kind: 'hello', text: 'Hello!' }] }] });
    g.step(2);
    expect(g.events(0, 'notification')).toEqual([expect.objectContaining({ kind: 'hello', text: 'Hello!' })]);
    expect(() => g.notify('', 'x')).toThrow(/kind must be a non-empty string/);
  });
});
