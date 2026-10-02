import { describe, expect, it } from 'vitest';
import type { EntityInput } from '@vibe/shared';
import { contactBox, Game } from '../src';
import { makeGame } from './helpers';

/** A thin solid (2–4 px), far thinner than what a fast body travels in one frame. */
const slab = (id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): EntityInput => ({
  id,
  transform: { x, y },
  components: { Collider: { width: w, height: h, ...extra } },
});

const ball = (vx: number, vy: number, x = 100, y = 100, gravityScale = 0): EntityInput => ({
  id: 'ball',
  tags: ['player'],
  transform: { x, y },
  components: { Body: { vx, vy, gravityScale, maxFallSpeed: 5000 }, Collider: { width: 10, height: 10 } },
});

const at = (g: Game, id = 'ball') => {
  const e = g.entity(id)!;
  return { x: e.x, y: e.y, vx: e.components.Body?.vx, vy: e.components.Body?.vy, grounded: e.grounded };
};

describe('continuous collision', () => {
  it('lands on a thin floor at any falling speed', () => {
    // 3000 px/s = 50 px per frame over a 2 px floor.
    const g = makeGame([ball(0, 3000, 100, 130, 1), slab('floor', 100, 300, 200, 2)]);
    g.step(20);
    expect(at(g)).toMatchObject({ y: 299 - 5, vy: 0, grounded: true });
    expect(g.entity('ball')!.groundId).toBe('floor');
  });

  it('stops at thin walls and ceilings', () => {
    // 4000 px/s = 67 px per frame: the wall is crossed during the first frame.
    let g = makeGame([ball(4000, 0, 250), slab('wall', 300, 100, 2, 100)]);
    g.step(1);
    expect(at(g)).toMatchObject({ x: 299 - 5, vx: 0 });
    expect(g.entity('ball')!.onWallRight).toBe(true);
    g.step(10);
    expect(at(g).x).toBe(294);

    g = makeGame([ball(-4000, 0, 500), slab('wall', 300, 100, 2, 100)]);
    g.step(10);
    expect(at(g)).toMatchObject({ x: 301 + 5, vx: 0 });

    g = makeGame([ball(0, -4000, 100, 400), slab('ceiling', 100, 200, 200, 2)]);
    g.step(10);
    expect(at(g)).toMatchObject({ y: 201 + 5, vy: 0 });
  });

  it('stops at the first of several thin solids', () => {
    const g = makeGame([ball(0, 4000, 100, 100, 1), slab('far', 100, 400, 200, 2), slab('near', 100, 250, 200, 2)]);
    g.step(10);
    expect(g.entity('ball')!.groundId).toBe('near');
  });

  it('only catches bodies falling onto a thin one-way platform', () => {
    let g = makeGame([ball(0, 3000, 100, 130, 1), slab('ledge', 100, 300, 200, 2, { oneWay: true })]);
    g.step(20);
    expect(at(g)).toMatchObject({ y: 294, grounded: true });

    // Rising through it and moving sideways through it are free.
    g = makeGame([ball(0, -3000, 100, 400), slab('ledge', 100, 300, 200, 2, { oneWay: true })]);
    g.step(10);
    expect(at(g).y).toBeLessThan(250);
    g = makeGame([ball(3000, 0, 100, 300), slab('ledge', 150, 300, 2, 40, { oneWay: true })]);
    g.step(5);
    expect(at(g).x).toBeGreaterThan(200);
  });

  it('collects what a fast body passes over between two frames', () => {
    const coin: EntityInput = { id: 'coin', transform: { x: 130, y: 100 }, components: { Collider: { width: 8, height: 8, isTrigger: true }, Collectible: {} } };
    // 60 px per frame: frame 1 ends at x=160, past the coin (126..134).
    const g = makeGame([ball(3600, 0), coin]);
    g.step(1);
    expect(g.entity('coin')).toBeUndefined();
    expect(g.world.vars.coins).toBe(1);
  });

  it('sweeps kinematic movers too (projectiles), but never teleports', () => {
    const target = (x: number): EntityInput => ({ id: 'target', transform: { x, y: 100 }, components: { Collider: { width: 6, height: 6, isTrigger: true }, Health: { max: 3 } } });
    const bullet: EntityInput = { id: 'bullet', transform: { x: 100, y: 100 }, components: { Body: { type: 'kinematic', vx: 4800 }, Collider: { width: 4, height: 4, isTrigger: true }, Damage: { amount: 1, targetTags: ['shootable'] } } };
    const g = makeGame([bullet, { ...target(140), tags: ['shootable'] }]);
    g.step(1);
    expect(g.entity('target')!.components.Health!.current).toBe(2);

    // A teleport (a script or rule setting the position) is not a path.
    const t = makeGame([ball(0, 0), { id: 'coin', transform: { x: 200, y: 100 }, components: { Collider: { width: 8, height: 8, isTrigger: true }, Collectible: {} } }]);
    t.entity('ball')!.x = 400;
    t.step(1);
    expect(t.entity('coin')).toBeDefined();
    expect(contactBox(t.entity('ball')!)).toEqual(t.entity('ball')!.aabb());
  });

  it('leaves slow bodies exactly as before (resting, walking on joined floors)', () => {
    const g = makeGame([ball(120, 0, 100, 290, 1), slab('a', 100, 300, 200, 10), slab('b', 300, 300, 200, 10)]);
    g.step(120);
    // Walked across the seam between the two floors without being stopped.
    expect(at(g)).toMatchObject({ y: 290, grounded: true });
    expect(at(g).x).toBeGreaterThan(300);
  });
});
