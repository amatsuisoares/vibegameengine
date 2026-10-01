import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { evaluateExpr, findPath, Game } from '../src';

type Nav = NonNullable<NonNullable<EntityInput['components']>['NavAgent']>;

/** A 400x300 top-down room: a wall at x 190..210 from the top down to y 220 (gap below it). */
const wall = (id = 'wall', x = 200, y = 110, w = 20, h = 220): EntityInput => ({ id, transform: { x, y }, components: { Collider: { width: w, height: h } } });

function game(entities: EntityInput[], scripts: Record<string, string> = {}) {
  return Game.fromRaw({
    config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 },
    scenes: { main: { id: 'main', width: 400, height: 300, entities } },
    scripts,
  });
}

const walker = (nav: Nav, extra: EntityInput['components'] = {}, x = 50, y = 50): EntityInput => ({
  id: 'npc',
  transform: { x, y },
  components: { Sprite: { width: 10, height: 10 }, NavAgent: nav, ...extra },
});
const snap = (g: Game, id = 'npc') => g.getState({ ids: [id] }).entities[0];

describe('findPath', () => {
  it('goes around obstacles and ends at the goal', () => {
    const g = game([wall()]);
    const r = findPath(g.world, { x: 50, y: 50 }, { x: 350, y: 50 })!;
    expect(r.points.at(-1)).toEqual({ x: 350, y: 50 });
    expect(r.points.some((p) => p.y > 220)).toBe(true); // through the gap
    expect(r.length).toBeGreaterThan(2 * Math.hypot(150, 170)); // two diagonals down to the gap and back up
    expect(findPath(g.world, { x: 50, y: 50 }, { x: 350, y: 50 })).toEqual(r); // deterministic
  });

  it('returns null when walled off, and stops next to a goal inside an obstacle', () => {
    const closed = game([wall('w', 200, 150, 20, 300)]);
    expect(findPath(closed.world, { x: 50, y: 50 }, { x: 350, y: 50 })).toBeNull();
    const g = game([wall('box', 300, 150, 60, 60)]);
    const end = findPath(g.world, { x: 50, y: 150 }, { x: 300, y: 150 })!.points.at(-1)!;
    const inside = end.x > 270 && end.x < 330 && end.y > 120 && end.y < 180;
    expect(inside).toBe(false); // nearest free cell, outside the box
    expect(Math.hypot(end.x - 300, end.y - 150)).toBeLessThan(60);
  });

  it('respects the agent size (clearance) and the diagonal option', () => {
    // A 20 px gap between two blocks.
    const g = game([wall('top', 200, 70, 20, 140), wall('bottom', 200, 235, 20, 130)]);
    expect(findPath(g.world, { x: 50, y: 150 }, { x: 350, y: 150 }, { width: 8, height: 8, cell: 8 })).not.toBeNull();
    expect(findPath(g.world, { x: 50, y: 150 }, { x: 350, y: 150 }, { width: 30, height: 30, cell: 8 })).toBeNull();
    const straight = findPath(game([]).world, { x: 8, y: 8 }, { x: 200, y: 120 }, { diagonal: false })!;
    let prev = { x: 8, y: 8 };
    for (const p of straight.points.slice(0, -1)) {
      expect(p.x === prev.x || p.y === prev.y).toBe(true);
      prev = p;
    }
  });
});

describe('NavAgent', () => {
  it('walks to a point around walls, then arrives once', () => {
    const g = game([wall(), walker({ target: { x: 350, y: 50 }, speed: 200 })]);
    g.step(2);
    expect(snap(g).nav).toMatchObject({ status: 'moving', target: { x: 350, y: 50 } });
    g.advance(6000);
    expect(snap(g)).toMatchObject({ x: 350, y: 50, nav: { status: 'arrived' } });
    expect(g.events(0, 'nav_arrived')).toEqual([expect.objectContaining({ entity: 'npc', target: { x: 350, y: 50 } })]);
  });

  it('follows a moving entity and re-plans; null target stops it', () => {
    const g = game([walker({ target: 'ball', speed: 150, repathMs: 200 }), { id: 'ball', transform: { x: 300, y: 50 }, components: { Sprite: { width: 10, height: 10 } } }]);
    g.advance(3000);
    expect(snap(g).nav!.status).toBe('arrived');
    g.entity('ball')!.y = 250;
    g.advance(3000);
    expect(snap(g)).toMatchObject({ x: 300, y: 250 });
    expect(g.events(0, 'nav_arrived')).toHaveLength(2);
    g.entity('npc')!.components.NavAgent!.target = null;
    g.step(1);
    expect(snap(g).nav!.status).toBe('idle');
  });

  it('fails when there is no way, and goes once a way opens', () => {
    const g = game([wall('gate', 200, 150, 20, 300), walker({ target: { x: 350, y: 150 }, repathMs: 100 })]);
    g.advance(500);
    expect(snap(g).nav!.status).toBe('failed');
    expect(g.events(0, 'nav_failed')).toHaveLength(1);
    g.entity('gate')!.enabled = false;
    g.advance(5000);
    expect(snap(g).nav!.status).toBe('arrived');
  });

  it('steers a Body by velocity, so physics still blocks it', () => {
    const g = game([wall(), walker({ target: { x: 350, y: 50 }, speed: 200 }, { Body: {}, Collider: { width: 10, height: 10 } })]);
    g.advance(6000);
    const s = snap(g);
    expect(s.nav!.status).toBe('arrived');
    expect(Math.hypot(s.x - 350, s.y - 50)).toBeLessThan(5);
    expect(s.vx).toBe(0);
  });

  it('a StateMachine sends it somewhere with "modify" and reacts to nav_arrived', () => {
    const g = game([
      { id: 'bed', transform: { x: 350, y: 250 }, components: { Sprite: { width: 40, height: 20 } } },
      walker(
        { speed: 300 },
        {
          StateMachine: {
            initial: 'awake',
            states: {
              awake: { transitions: [{ to: 'toBed', after: 200 }] },
              toBed: { enter: [{ action: 'modify', target: '$self', component: 'NavAgent', set: { target: 'bed' } }], transitions: [{ to: 'asleep', event: 'nav_arrived', match: { entity: '$self' } }] },
              asleep: {},
            },
          },
        },
      ),
    ]);
    g.advance(3000);
    expect(snap(g).state).toBe('asleep');
  });
});

describe('pathfinding from scripts and expressions', () => {
  it('game.findPath and self.nav', () => {
    const src = `
      function onStart(self, game) {
        const p = game.findPath(self, { x: 350, y: 50 });
        game.vars.turns = p.points.length;
        game.vars.blocked = game.findPath({ x: 50, y: 50 }, { x: 200, y: 100 }) !== null; // the goal is inside the wall: nearest free cell
        self.nav.goTo('flag');
      }
      function onUpdate(self, game) { if (game.frame === 5) game.vars.status = self.nav.status + ':' + self.nav.path.length; }`;
    const g = game(
      [wall(), walker({}, { Script: { src: 'scripts/s.js' } }), { id: 'flag', transform: { x: 350, y: 50 }, components: { Sprite: {} } }],
      { 'scripts/s.js': src },
    );
    g.step(10);
    expect(g.world.vars.turns).toBeGreaterThan(1);
    expect(g.world.vars.blocked).toBe(true);
    expect(String(g.world.vars.status)).toMatch(/^moving:\d+$/);
  });

  it('pathDistance(a, b) in expressions: length around obstacles, null when unreachable', () => {
    const g = game([wall(), walker({}), { id: 'flag', transform: { x: 350, y: 50 }, components: { Sprite: {} } }]);
    const d = evaluateExpr("pathDistance('npc', 'flag')", { game: g }).value as number;
    expect(d).toBeGreaterThan(450); // straight would be 300
    const shut = game([wall('w', 200, 150, 20, 300), walker({}), { id: 'flag', transform: { x: 350, y: 50 }, components: { Sprite: {} } }]);
    expect(evaluateExpr("pathDistance('npc', 'flag') == null", { game: shut }).value).toBe(true);
  });
});
