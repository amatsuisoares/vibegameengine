import { describe, expect, it } from 'vitest';
import { evaluateExpr, ExprError, parseExpr } from '../src';
import { ground, makeGame, player } from './helpers';

const game = () => {
  const g = makeGame([player(), ground('g', 0, 1000), { id: 'c1', tags: ['coin'] }, { id: 'c2', tags: ['coin'] }], { vars: { coins: 2, name: 'x' } });
  g.advance(200);
  return g;
};
const ev = (src: string, g = game()) => evaluateExpr(src, { game: g }).value;

describe('expressions', () => {
  it('evaluates literals, arithmetic and precedence', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 - 4 - 3')).toBe(3);
    expect(ev('-2 + 5')).toBe(3);
    expect(ev("'a' + 1")).toBe('a1');
    expect(ev('1 < 2 && 2 <= 2 && !(3 > 4) || false')).toBe(true);
  });

  it('reads game state', () => {
    const g = game();
    expect(ev("status == 'running'", g)).toBe(true);
    expect(ev('frame', g)).toBe(12);
    expect(ev("scene == 'main'", g)).toBe(true);
    expect(ev('vars.coins >= 2', g)).toBe(true);
    expect(ev("entity('player').grounded", g)).toBe(true);
    expect(ev("entity('player').health == 3", g)).toBe(true);
    expect(ev("count('coin')", g)).toBe(2);
    expect(ev("exists('ghost')", g)).toBe(false);
    expect(ev("events('scene_loaded')", g)).toBe(1);
    expect(ev("abs(entity('player').x - 110) < 11", g)).toBe(true);
    expect(ev("entity('player')['tags']", g)).toEqual(['player']);
  });

  it('treats fields of missing entities as null and comparisons with null as false', () => {
    expect(ev("entity('ghost').x")).toBeNull();
    expect(ev("entity('ghost').x > 0")).toBe(false);
    expect(ev("entity('ghost').x < 0")).toBe(false);
    expect(ev("entity('ghost') == null")).toBe(true);
  });

  it('reports the operands it compared', () => {
    const r = evaluateExpr("entity('player').x > 300 && vars.coins >= 1", { game: game() });
    expect(r.value).toBe(false);
    expect(r.observed).toEqual({ "entity(\"player\").x": 100, 'vars.coins': 2 });
  });

  it('rejects bad syntax, unknown names and assignment with clear errors', () => {
    expect(() => parseExpr('1 +')).toThrow(ExprError);
    expect(() => parseExpr("entity('p'")).toThrow(/Expected "\)"/);
    expect(() => parseExpr('vars.coins = 3')).toThrow(/Use == for comparison/);
    expect(() => ev('player.x')).toThrow(/Unknown name "player"/);
    expect(() => ev('eval(1)')).toThrow(/Unknown function "eval"/);
    expect(() => ev("'abc")).toThrow(/Unterminated string/);
    expect(ev("'a=b' == 'a=b'")).toBe(true);
  });
});
