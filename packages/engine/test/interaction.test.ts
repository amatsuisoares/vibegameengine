import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game, GameClock } from '../src';

function game(entities: EntityInput[], scripts: Record<string, string>, options: ConstructorParameters<typeof Game>[1] = {}) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0 }, scenes: { main: { id: 'main', width: 800, height: 450, entities } }, scripts },
    options,
  );
}

const box = (id: string, x: number, y: number, src?: string, extra: Partial<EntityInput> = {}): EntityInput => ({
  id,
  transform: { x, y },
  ...extra,
  components: { Sprite: { width: 100, height: 60, layer: (extra as { layer?: number }).layer ?? 0 }, ...(src && { Script: { src } }), ...extra.components },
});

describe('clicks', () => {
  it('goes to the topmost entity with onClick (or tagged clickable) under the mouse', () => {
    const btn = 'function onClick(self, game, pos) { game.vars.clicks = (game.vars.clicks || 0) + 1; game.vars.last = self.id; game.vars.px = pos.x; }';
    const g = game(
      [
        box('bg', 400, 225, undefined, { components: { Sprite: { width: 800, height: 450, layer: -10 } } }),
        box('low', 200, 200, 'scripts/btn.js'),
        box('high', 220, 210, 'scripts/btn.js', { components: { Sprite: { width: 100, height: 60, layer: 5 } } }),
        box('tagged', 600, 100, undefined, { tags: ['clickable'] }),
      ],
      { 'scripts/btn.js': btn },
    );
    g.perform([{ type: 'click', x: 210, y: 205 }]);
    expect(g.world.vars).toMatchObject({ clicks: 1, last: 'high', px: 210 }); // both overlap: higher layer wins
    g.perform([{ type: 'click', x: 160, y: 190 }]);
    expect(g.world.vars.last).toBe('low');
    g.perform([{ type: 'click', x: 600, y: 100 }, { type: 'click', x: 700, y: 400 }]); // tagged; then background only
    expect(g.world.vars.clicks).toBe(2);
    expect(g.events(0, 'click').map((e) => e.entity)).toEqual(['high', 'low', 'tagged']);
  });
});

describe('typed text and onEvent', () => {
  it('reads typed characters and Backspace, and reacts to events', () => {
    const field = `
      function onUpdate(self, game) {
        let name = self.state.name || '';
        if (game.input.pressed('Backspace')) name = name.slice(0, -1);
        name += game.input.text;
        self.state.name = name;
        self.get('Text').text = name;
        if (game.input.pressed('Enter') && name) game.emit('named', { name });
      }`;
    const listener = 'function onEvent(self, ev, game) { if (ev.type === "named") game.vars.petName = ev.name; }';
    const g = game(
      [
        { id: 'field', components: { Text: { text: '' }, Script: { src: 'scripts/field.js' } } },
        { id: 'brain', components: { Script: { src: 'scripts/brain.js' } } },
      ],
      { 'scripts/field.js': field, 'scripts/brain.js': listener },
    );
    g.perform([{ type: 'type', text: 'Mimix' }, { type: 'tap', key: 'Backspace' }, { type: 'type', text: 'ã' }, { type: 'tap', key: 'Enter' }, { type: 'wait', ms: 50 }]);
    // Agents can also type "\b" and "\n" inline, in order, within one frame.
    const g2 = game([{ id: 'b', components: { Script: { src: 'scripts/b.js' } } }], {
      'scripts/b.js': 'function onUpdate(self, game) { for (const ch of game.input.text) game.vars.log = (game.vars.log || "") + (ch === "\\b" ? "<" : ch === "\\n" ? "!" : ch); }',
    });
    g2.perform([{ type: 'type', text: 'ab\bc\n' }]);
    expect(g2.world.vars.log).toBe('ab<c!');
    expect(g.entity('field')!.components.Text!.text).toBe('Mimiã');
    expect(g.world.vars.petName).toBe('Mimiã');
  });
});

describe('clock', () => {
  it('advances with the simulation at its speed, jumps, and knows the local hour', () => {
    const c = new GameClock({ start: '2026-03-10T21:30:00Z', utcOffsetMinutes: -180 });
    expect(c.hour).toBeCloseTo(18.5, 6);
    expect(c.iso).toBe('2026-03-10T18:30:00');
    c.speed = 60;
    for (let i = 0; i < 60; i++) c.tick(); // 1 simulated second = 1 game minute
    expect(c.iso).toBe('2026-03-10T18:31:00');
    c.advance(6 * 3_600_000);
    expect(c.iso).toBe('2026-03-11T00:31:00');
    expect(c.hour).toBeCloseTo(0.5167, 3);
    expect(() => c.advance(-1)).toThrow();
    c.reset();
    expect([c.iso, c.speed]).toEqual(['2026-03-10T18:30:00', 1]);
  });

  it('is visible to scripts and expressions; scripts can change its speed', () => {
    const src = `
      function onStart(self, game) { game.clock.speed = 3600; game.vars.startHour = game.clock.hour; }
      function onUpdate(self, game) { game.vars.hour = Math.floor(game.clock.hour); }`;
    const g = game([{ id: 'c', components: { Script: { src: 'scripts/c.js' } } }], { 'scripts/c.js': src });
    g.advance(2000); // 2 s at 1 game hour per second
    expect(g.getState().clock.hour).toBeCloseTo(11, 5);
    expect(g.world.vars).toMatchObject({ startHour: 9, hour: 10 }); // the last onUpdate ran at 10:59
    g.apply({ op: 'advanceClock', ms: 10 * 3_600_000 });
    g.step(1);
    expect(g.world.vars.hour).toBe(21);
    expect(g.getState().clock).toMatchObject({ speed: 3600 });
    g.restart();
    expect(g.getState().clock).toMatchObject({ iso: '2026-01-01T09:00:00', speed: 1 });
  });
});

describe('storage', () => {
  it('keeps JSON data, reports changes, and restarts from the initial data', () => {
    const changes: unknown[] = [];
    const src = `
      function onStart(self, game) {
        const visits = (game.storage.get('visits') || 0) + 1;
        game.storage.set('visits', visits);
        game.storage.set('pet', { name: 'Kuro', born: game.clock.now });
        game.vars.visits = visits;
      }`;
    const g = game([{ id: 's', components: { Script: { src: 'scripts/s.js' } } }], { 'scripts/s.js': src }, {
      storage: { visits: 4 },
      onStorageChange: (d) => changes.push(d),
    });
    g.step(1);
    expect(g.world.vars.visits).toBe(5);
    expect(g.getState({ storage: true }).storage).toEqual({ visits: 5, pet: { name: 'Kuro', born: Date.UTC(2026, 0, 1, 9) } });
    expect(changes).toHaveLength(2);
    g.restart();
    expect(g.storage.snapshot()).toEqual({ visits: 4 });
    expect(() => g.storage.set('f', () => 1)).toThrow(/not JSON/);
    expect(() => g.storage.set('big', 'x'.repeat(600_000))).toThrow(/storage is full/);
  });
});

describe('visual transform from scripts', () => {
  it('sets scale and rotation', () => {
    const g = game([{ id: 'p', components: { Sprite: {}, Script: { src: 'scripts/p.js' } } }], {
      'scripts/p.js': 'function onUpdate(self, game) { self.scaleY = 1 + Math.sin(game.time * 10) * 0.1; self.rotation = 5; }',
    });
    g.step(10);
    const p = g.entity('p')!;
    expect(p.rotation).toBe(5);
    expect(p.scaleY).not.toBe(1);
  });
});
