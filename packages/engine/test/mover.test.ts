import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { ground, makeGame, player } from './helpers';

const platform = (id: string, x: number, y: number, mover: Record<string, unknown>, extra: Record<string, unknown> = {}): EntityInput => ({
  id,
  transform: { x, y },
  components: { Sprite: { width: 96, height: 16 }, Body: { type: 'kinematic' }, Collider: { width: 96, height: 16, ...extra }, Mover: mover as never },
});

describe('Mover and moving platforms', () => {
  it('goes back and forth along its path at constant speed, pausing at the ends', () => {
    const g = makeGame([platform('p', 100, 300, { path: [{ x: 120, y: 0 }], speed: 60, waitMs: 500 })]);
    const p = g.entity('p')!;
    g.advance(1000);
    expect(p.x).toBeCloseTo(160, 5);
    g.advance(1000);
    expect(p.x).toBeCloseTo(220, 5); // arrived
    g.advance(500);
    expect(p.x).toBeCloseTo(220, 5); // waiting
    g.advance(1000);
    expect(p.x).toBeCloseTo(160, 5); // coming back
    g.advance(1500);
    expect(p.x).toBeCloseTo(100, 5); // back home (+ pause), then out again
  });

  it('loops through several waypoints', () => {
    const g = makeGame([{ id: 'deco', transform: { x: 0, y: 0 }, components: { Mover: { path: [{ x: 60, y: 0 }, { x: 60, y: 60 }], speed: 60, loop: true } } }]);
    const d = g.entity('deco')!;
    g.advance(1000);
    expect([d.x, d.y]).toEqual([60, 0]);
    g.advance(1000);
    expect([d.x, d.y]).toEqual([60, 60]);
    g.advance(1000);
    expect(d.x).toBeCloseTo(60 - 60 / Math.SQRT2, 5); // diagonal back to the start
  });

  it('carries the player standing on it, horizontally and vertically', () => {
    const lift = platform('lift', 100, 400, { path: [{ x: 0, y: -200 }, { x: 300, y: -200 }], speed: 100 });
    const g = makeGame([lift, player(100, 300)]);
    g.advance(500); // land on the lift while it rises
    const p = g.entity('player')!;
    const l = g.entity('lift')!;
    expect(p.grounded).toBe(true);
    expect(p.groundId).toBe('lift');
    g.advance(2500); // t = 3 s: up 200 px (2 s), then 100 px right
    expect(l.y).toBeCloseTo(200, 5);
    expect(l.x).toBeCloseTo(200, 3);
    expect(p.groundId).toBe('lift');
    expect(p.y).toBeCloseTo(200 - 8 - 16, 5); // standing on top
    expect(p.x).toBeCloseTo(200, 3); // carried sideways with it
    g.advance(4000); // the lift goes back down and left: still riding
    expect(p.groundId).toBe('lift');
    expect(p.x - l.x).toBeCloseTo(0, 3);
  });

  it('carries the player on a one-way platform going up', () => {
    const g = makeGame([platform('elev', 100, 400, { path: [{ x: 0, y: -150 }], speed: 120 }, { oneWay: true }), player(100, 360)]);
    g.advance(1200); // still rising (150 px take 1.25 s)
    const p = g.entity('player')!;
    expect(p.groundId).toBe('elev');
    expect(p.y).toBeCloseTo(g.entity('elev')!.y - 8 - 16, 5);
    expect(p.y).toBeLessThan(260);
  });

  it('does not stop the player walking off a moving platform', () => {
    const g = makeGame([platform('p', 100, 380, { path: [{ x: 200, y: 0 }], speed: 50 }), player(100, 340), ground('g', 0, 1000)]);
    g.advance(500);
    expect(g.entity('player')!.groundId).toBe('p');
    g.perform([{ type: 'hold', key: 'D', ms: 1000 }, { type: 'wait', ms: 500 }]);
    const p = g.entity('player')!;
    expect(p.x).toBeGreaterThan(240); // walked faster than the platform and off its edge
    expect(p.groundId).toBe('g');
  });
});
