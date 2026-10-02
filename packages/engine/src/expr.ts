import type { Game } from './game';
import { findPath, pathOptionsFor } from './nav';
import { stackAt } from './mouse';
import { affinityOf, traitOf } from './individual';
import { screenToWorld } from './systems/camera';

/**
 * Tiny, side-effect-free expression language for test assertions and wait conditions,
 * e.g. `entity('player').x > 300 && vars.coins >= 1`. It is parsed and interpreted here
 * (never `eval`), so agent-written expressions cannot run arbitrary code.
 *
 *   literals     12  1.5  'text'  "text"  true  false  null
 *   names        status  frame  time  scene  vars  camera  clock  mouse  self (StateMachine/Interactable conditions)
 *   functions    entity(id) exists(id) hasSlot(name) count(tag) events(type) distance(a,b) pathDistance(a,b) abs(x) min(a,b) max(a,b) clamp(x,lo,hi)
 *                trait([entity,] axis) likes([entity,] subject)   (one argument = self)
 *   operators    .field  !  unary -  * /  + -  < <= > >=  == !=  &&  ||
 * Field access on null yields null (the assertion then fails and shows the null).
 */

type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'name'; name: string }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'get'; obj: Node; field: string }
  | { k: 'unary'; op: '!' | '-'; arg: Node }
  | { k: 'bin'; op: string; left: Node; right: Node };

export class ExprError extends Error {
  constructor(message: string, readonly expr: string) {
    super(`${message} in expression: ${expr}`);
    this.name = 'ExprError';
  }
}

type Tok = { t: 'num' | 'str' | 'id' | 'op'; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0], pos: i });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) j++;
        s += src[j++];
      }
      if (j >= src.length) throw new ExprError(`Unterminated string at ${i}`, src);
      out.push({ t: 'str', v: s, pos: i });
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], pos: i });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      const op = ['<=', '>=', '==', '!=', '&&', '||'].includes(two) ? two : '()[].,!<>+-*/'.includes(c) ? c : null;
      if (!op) throw new ExprError(c === '=' ? 'Use == for comparison, not =' : `Unexpected character "${c}" at ${i}`, src);
      out.push({ t: 'op', v: op, pos: i });
      i += op.length;
    }
  }
  return out;
}

const BINARY: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6 };

export function parseExpr(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (v: string) => {
    const t = next();
    if (!t || t.v !== v) throw new ExprError(`Expected "${v}"${t ? ` at ${t.pos}` : ' at end'}`, src);
  };

  const primary = (): Node => {
    const t = next();
    if (!t) throw new ExprError('Unexpected end', src);
    if (t.t === 'num') return { k: 'lit', v: Number(t.v) };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'op' && t.v === '(') {
      const e = expr(0);
      expect(')');
      return e;
    }
    if (t.t === 'op' && (t.v === '!' || t.v === '-')) return { k: 'unary', op: t.v, arg: postfix(primary()) };
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      if (t.v === 'null') return { k: 'lit', v: null };
      if (peek()?.v === '(') {
        next();
        const args: Node[] = [];
        if (peek()?.v !== ')') {
          do args.push(expr(0));
          while (peek()?.v === ',' && next());
        }
        expect(')');
        return { k: 'call', fn: t.v, args };
      }
      return { k: 'name', name: t.v };
    }
    throw new ExprError(`Unexpected "${t.v}" at ${t.pos}`, src);
  };

  const postfix = (n: Node): Node => {
    while (peek()?.v === '.' || peek()?.v === '[') {
      if (next().v === '.') {
        const f = next();
        if (!f || f.t !== 'id') throw new ExprError('Expected a field name after "."', src);
        n = { k: 'get', obj: n, field: f.v };
      } else {
        const f = next();
        if (!f || f.t !== 'str') throw new ExprError('Expected a quoted field name inside [ ]', src);
        expect(']');
        n = { k: 'get', obj: n, field: f.v };
      }
    }
    return n;
  };

  const expr = (minPrec: number): Node => {
    let left = postfix(primary());
    for (;;) {
      const t = peek();
      const prec = t && t.t === 'op' ? BINARY[t.v] : undefined;
      if (prec === undefined || prec < minPrec) break;
      next();
      left = { k: 'bin', op: t!.v, left, right: expr(prec + 1) };
    }
    return left;
  };

  const tree = expr(0);
  if (p < toks.length) throw new ExprError(`Unexpected "${toks[p].v}" at ${toks[p].pos}`, src);
  return tree;
}

export interface ExprScope {
  game: Game;
  /** Events at or after this frame are counted by events(type). */
  sinceFrame?: number;
  /** Entity id that `self` refers to (conditions of a StateMachine or an Interactable). */
  self?: string;
}

/** An entity id, or an entity value from entity(id) / self. */
function idOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return (v as { id: string }).id;
  return null;
}

function entityValue(game: Game, id: unknown) {
  if (typeof id !== 'string') return null;
  const e = game.entity(id);
  if (!e) return null;
  const s = game.getState({ ids: [id] }).entities[0];
  return { ...s, enabled: e.enabled, tags: [...e.tags] };
}

function evaluate(n: Node, scope: ExprScope, src: string): unknown {
  const { game } = scope;
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'name': {
      const w = game.world;
      switch (n.name) {
        case 'status':
          return w.status;
        case 'frame':
          return w.frame;
        case 'time':
          return w.time;
        case 'scene':
          return w.scene.id;
        case 'vars':
          return { ...w.vars };
        case 'camera':
          return { ...w.camera };
        case 'clock':
          return game.clock.snapshot();
        case 'mouse': {
          const m = game.input.snapshot().mouse;
          const p = screenToWorld(w, m.x, m.y);
          const target = game.interactions.clickTargetAt(p.x, p.y);
          const hovered = stackAt(game, p.x, p.y)[0];
          return { x: m.x, y: m.y, worldX: p.x, worldY: p.y, target: target?.id ?? null, hovered: hovered?.id ?? null, buttons: m.buttons };
        }
        case 'self':
          if (scope.self === undefined) throw new ExprError('"self" only exists in StateMachine and Interactable conditions', src);
          return entityValue(game, scope.self);
        default:
          throw new ExprError(`Unknown name "${n.name}" (use status, frame, time, scene, vars, camera, clock, mouse, self or a function)`, src);
      }
    }
    case 'get': {
      const obj = evaluate(n.obj, scope, src);
      if (obj === null || obj === undefined || typeof obj !== 'object') return null;
      return (obj as Record<string, unknown>)[n.field] ?? null;
    }
    case 'call': {
      const args = n.args.map((a) => evaluate(a, scope, src));
      const arity = (k: number) => {
        if (args.length !== k) throw new ExprError(`${n.fn}() takes ${k} argument${k === 1 ? '' : 's'}`, src);
      };
      switch (n.fn) {
        case 'entity':
          arity(1);
          return entityValue(game, args[0]);
        case 'exists':
          arity(1);
          return typeof args[0] === 'string' && game.entity(args[0]) !== undefined;
        case 'hasSlot':
          arity(1);
          return typeof args[0] === 'string' && game.listSlots().some((s) => s.name === args[0]);
        case 'count':
          arity(1);
          return game.world.withTag(String(args[0])).length;
        case 'events':
          arity(1);
          return game.events(scope.sinceFrame ?? 0, String(args[0])).length;
        case 'distance': {
          arity(2);
          const [a, b] = args.map((v) => {
            const id = idOf(v);
            return id === null ? undefined : game.entity(id);
          });
          return a && b ? Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 100) / 100 : null;
        }
        case 'pathDistance': {
          arity(2);
          const [a, b] = args.map((v) => {
            const id = idOf(v);
            return id === null ? undefined : game.entity(id);
          });
          if (!a || !b) return null;
          const opts = pathOptionsFor(a, a.components.NavAgent);
          return findPath(game.world, { x: a.x, y: a.y }, { x: b.x, y: b.y }, { ...opts, ignore: [a, b] })?.length ?? null;
        }
        case 'trait':
        case 'likes': {
          if (args.length !== 1 && args.length !== 2) throw new ExprError(`${n.fn}() takes 1 or 2 arguments ([entity,] name)`, src);
          const id = args.length === 2 ? idOf(args[0]) : (scope.self ?? null);
          if (id === null) throw new ExprError(`${n.fn}() with one argument needs "self"; pass the entity: ${n.fn}('id', ...)`, src);
          const e = game.entity(id);
          if (!e) return null;
          game.individuals.ensure(e);
          const name = String(args[args.length - 1]);
          if (n.fn === 'likes') return affinityOf(e, name);
          try {
            return traitOf(e, name);
          } catch (err) {
            throw new ExprError((err as Error).message, src);
          }
        }
        case 'clamp': {
          arity(3);
          const [x, lo, hi] = args.map(Number);
          return Math.min(hi, Math.max(lo, x));
        }
        case 'abs':
          arity(1);
          return Math.abs(Number(args[0]));
        case 'min':
          return Math.min(...args.map(Number));
        case 'max':
          return Math.max(...args.map(Number));
        default:
          throw new ExprError(`Unknown function "${n.fn}" (entity, exists, hasSlot, count, events, distance, pathDistance, abs, min, max, clamp, trait, likes)`, src);
      }
    }
    case 'unary': {
      const v = evaluate(n.arg, scope, src);
      return n.op === '!' ? !v : -Number(v);
    }
    case 'bin': {
      if (n.op === '&&') return evaluate(n.left, scope, src) && evaluate(n.right, scope, src);
      if (n.op === '||') return evaluate(n.left, scope, src) || evaluate(n.right, scope, src);
      const a = evaluate(n.left, scope, src);
      const b = evaluate(n.right, scope, src);
      switch (n.op) {
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '+':
          return typeof a === 'string' || typeof b === 'string' ? `${a}${b}` : Number(a) + Number(b);
        case '-':
          return Number(a) - Number(b);
        case '*':
          return Number(a) * Number(b);
        case '/':
          return Number(a) / Number(b);
      }
      if (a === null || b === null) return false;
      switch (n.op) {
        case '<':
          return (a as number) < (b as number);
        case '<=':
          return (a as number) <= (b as number);
        case '>':
          return (a as number) > (b as number);
        case '>=':
          return (a as number) >= (b as number);
      }
      throw new ExprError(`Unknown operator ${n.op}`, src);
    }
  }
}

function show(n: Node): string {
  switch (n.k) {
    case 'lit':
      return JSON.stringify(n.v);
    case 'name':
      return n.name;
    case 'call':
      return `${n.fn}(${n.args.map(show).join(', ')})`;
    case 'get':
      return `${show(n.obj)}.${n.field}`;
    case 'unary':
      return `${n.op}${show(n.arg)}`;
    case 'bin':
      return `${show(n.left)} ${n.op} ${show(n.right)}`;
  }
}

export interface ExprResult {
  value: unknown;
  /** Values of the operands of each comparison, e.g. { "entity('player').x": 288.5 }, to explain failures. */
  observed: Record<string, unknown>;
}

/** Evaluates an expression against the current game state. Throws ExprError on syntax or name errors. */
export function evaluateExpr(src: string, scope: ExprScope): ExprResult {
  const tree = parseExpr(src);
  const observed: Record<string, unknown> = {};
  const collect = (n: Node) => {
    if (n.k === 'bin') {
      if (['==', '!=', '<', '<=', '>', '>='].includes(n.op)) {
        for (const side of [n.left, n.right]) if (side.k !== 'lit') observed[show(side)] = evaluate(side, scope, src);
      } else {
        collect(n.left);
        collect(n.right);
      }
    } else if (n.k === 'unary') {
      collect(n.arg);
      if (n.arg.k !== 'bin') observed[show(n.arg)] = evaluate(n.arg, scope, src);
    } else if (n.k !== 'lit') {
      observed[show(n)] = evaluate(n, scope, src);
    }
  };
  const value = evaluate(tree, scope, src);
  collect(tree);
  return { value, observed };
}

/** Parses once and returns an evaluator (for expressions checked every frame, e.g. scene rules). */
export function compileExpr(src: string): (scope: ExprScope) => unknown {
  const tree = parseExpr(src);
  return (scope) => evaluate(tree, scope, src);
}
