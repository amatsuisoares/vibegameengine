import type { EntityInput } from '@vibe/shared';
import { parseProject } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { evaluateExpr } from '../src/expr';

const MIN = 60_000;

function game(entities: EntityInput[], storage?: Record<string, unknown>, vars: Record<string, unknown> = {}) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, vars, entities } }, scripts: { 'scripts/o.js': '' } },
    { seed: 1, storage, clock: { start: '2026-03-10T09:00:00Z' } },
  );
}

/** A town square that sometimes has a market, a parade or rain (nothing pet-specific). */
const square = (happenings: Record<string, unknown> = {}, components: NonNullable<EntityInput['components']> = {}): EntityInput => ({
  id: 'square',
  transform: { x: 0, y: 0 },
  components: {
    Happenings: {
      everyMinutes: 60,
      deck: [
        { id: 'market', weight: 3, minutes: 30, cooldownMinutes: 120 },
        { id: 'parade', weight: 1, minutes: 20, maxPerDay: 1, endOn: [{ event: 'cheer', match: { at: '$self' }, outcome: 'cheered' }] },
        { id: 'rain', weight: 'vars.cloudy * 5', minutes: 15, when: 'clock.hour >= 6' },
      ],
      ...happenings,
    },
    Script: { src: 'scripts/o.js' },
    ...components,
  },
});

type Hap = { start: Function; end: Function; update: Function; current: Function; candidates: Function; nextIn: Function };
type Api = { scriptRunner: { api: { entity(e: unknown): { happenings: Hap }; game: { emit(t: string, d?: unknown): void } } } };
const api = (g: Game) => (g as unknown as Api).scriptRunner.api;
const hap = (g: Game) => api(g).entity(g.entity('square')).happenings;
const kinds = (g: Game, type: string) => g.events(0, type).map((e) => e.kind);

describe('Happenings', () => {
  it('draws one card at a time on the game clock, by weight; ends by time; cooldowns and daily limits apply', () => {
    const g = game([square()], undefined, { cloudy: 0 });
    g.step(1);
    const h = hap(g);
    // The first wait is scheduled on the first frame: 30..90 min of clock.
    const first = h.nextIn();
    expect(first).toBeGreaterThanOrEqual(30);
    expect(first).toBeLessThanOrEqual(90);
    expect(g.getState({ ids: ['square'] }).entities[0]).toMatchObject({ happening: null, nextHappeningIn: first });
    // No rain without clouds (weight 0): only market and parade can come.
    expect(h.candidates().map((c: { id: string }) => c.id)).toEqual(['market', 'parade']);
    for (let i = 0; i < 8; i++) {
      g.apply({ op: 'advanceClock', ms: 100 * MIN });
      g.step(61); // the draw is checked once a real second
    }
    const started = kinds(g, 'happening_start');
    expect(started.length).toBeGreaterThan(3);
    expect(started).not.toContain('rain');
    // Never two at once: every start but the last was ended before the next one.
    expect(g.events(0, 'happening_end').length).toBeGreaterThanOrEqual(started.length - 1);
    expect(g.events(0, 'happening_end').every((e) => e.outcome === 'expired' && e.by === 'time')).toBe(true);
    // The parade comes at most once a day (all of this is the same day: 09:00 to 22:20).
    expect(started.filter((k) => k === 'parade').length).toBeLessThanOrEqual(1);
  });

  it('a matching event ends it with its outcome; scripts start, update and end it; happening() in expressions', () => {
    const g = game([square()], undefined, { cloudy: 1 });
    g.step(1);
    const h = hap(g);
    expect(h.start('parade', { band: 'brass' })).toMatchObject({ id: 'h1', kind: 'parade', data: { band: 'brass' }, minutesLeft: 20 });
    expect(h.start('market')).toBeNull(); // one at a time
    expect(evaluateExpr("happening('square')", { game: g }).value).toBe('parade');
    expect(h.update({ floats: 3 })).toMatchObject({ data: { band: 'brass', floats: 3 } });
    api(g).game.emit('cheer', { at: 'elsewhere' });
    g.step(1);
    expect(h.current()).toMatchObject({ kind: 'parade' });
    api(g).game.emit('cheer', { at: 'square' });
    g.step(1);
    expect(h.current()).toBeNull();
    expect(g.events(0, 'happening_end')).toMatchObject([{ entity: 'square', id: 'h1', kind: 'parade', outcome: 'cheered', by: 'cheer', data: { floats: 3 } }]);
    expect(evaluateExpr("happening('square')", { game: g }).value).toBe(false);
    // The next draw waits again (0.5–1.5 × everyMinutes).
    expect(h.nextIn()).toBeGreaterThanOrEqual(30);
    h.start('rain');
    expect(h.end('soaked')).toMatchObject({ kind: 'rain' });
    expect(g.events(0, 'happening_end').at(-1)).toMatchObject({ outcome: 'soaked', by: 'script' });
    expect(() => h.start('meteor')).toThrow(/no card "meteor"/);
  });

  it('a fast clock does not rain events: real-time gap and minRealSeconds; when stops the draws', () => {
    const g = game([square({ minGapRealSeconds: 120, when: '!vars.closed', deck: [{ id: 'market', minutes: 5, minRealSeconds: 30 }] })], undefined, { closed: true });
    g.step(1);
    g.apply({ op: 'advanceClock', ms: 200 * MIN });
    g.step(130 * 60);
    expect(kinds(g, 'happening_start')).toEqual([]); // closed
    g.world.vars.closed = false;
    g.step(61);
    expect(kinds(g, 'happening_start')).toEqual(['market']);
    // Its 5 clock minutes pass at once, but it lasts 30 real seconds.
    g.apply({ op: 'advanceClock', ms: 10 * MIN });
    g.step(20 * 60);
    expect(hap(g).current()).toMatchObject({ kind: 'market' });
    g.step(11 * 60);
    expect(hap(g).current()).toBeNull();
    // The clock jumps past the next one, but 2 real minutes must pass first.
    g.apply({ op: 'advanceClock', ms: 200 * MIN });
    g.step(60 * 60);
    expect(kinds(g, 'happening_start')).toEqual(['market']);
    g.step(61 * 60);
    expect(kinds(g, 'happening_start')).toEqual(['market', 'market']);
  });

  it('Persist keeps the one going on and the history; a bad expression stops only that deck', () => {
    const g = game([square({}, { Persist: { key: 'sq' } })], undefined, { cloudy: 0 });
    g.step(1);
    hap(g).start('parade');
    g.step(1);
    const again = game([square({}, { Persist: { key: 'sq' } })], g.storage.snapshot(), { cloudy: 0 });
    again.step(1);
    expect(hap(again).current()).toMatchObject({ id: 'h1', kind: 'parade' });
    hap(again).end('done');
    hap(again).start('market');
    expect(hap(again).current()).toMatchObject({ id: 'h2' }); // ids keep counting

    const bad = game([square({ deck: [{ id: 'x', weight: 'nope(' }] })]);
    bad.step(1);
    bad.apply({ op: 'advanceClock', ms: 200 * MIN });
    bad.step(3 * 60);
    expect(bad.events(0, 'happening_error')).toHaveLength(1);
    expect(bad.world.status).toBe('running');
  });

  it('validation: Persist with only Happenings has something to keep; card weights are numbers or expressions', () => {
    const scene = (h: unknown) => ({
      config: { name: 't', startScene: 'main' },
      scenes: { main: { id: 'main', entities: [{ id: 'k', components: { Happenings: h, Persist: { key: 'k' } } }] } },
    });
    const errorsOf = (raw: unknown) => { const r = parseProject(raw); return r.ok ? [] : r.errors; };
    expect(errorsOf(scene({ deck: [{ id: 'a', weight: "trait('x')" }] }))).toEqual([]);
    expect(errorsOf(scene({ deck: [{ id: 'a', weight: -1 }] })).join('\n')).toMatch(/weight/);
    expect(errorsOf(scene({ deck: [{ id: 'a', minutes: 0 }] })).join('\n')).toMatch(/minutes/);
  });
});
