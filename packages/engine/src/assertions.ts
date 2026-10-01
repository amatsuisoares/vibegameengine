import { COMPARE_OPS, type Assertion } from '@vibe/shared';
import type { Game } from './game';

/**
 * Structured gameplay assertions (schema in @vibe/shared). Each one reads the engine's structured
 * state directly — no expressions, no code — and returns what was expected, what was found and
 * extra evidence for a failure (e.g. the events that did happen, the entity's real position).
 */

export interface AssertionResult {
  pass: boolean;
  /** Short description, e.g. 'vars.coins == 1'. */
  label: string;
  /** What should hold, e.g. '== 1', 'state "sleep"'. */
  expected: string;
  /** The value found (null when missing). */
  actual: unknown;
  /** More context for a failure. */
  evidence?: Record<string, unknown>;
}

type Compare = Partial<Record<(typeof COMPARE_OPS)[number], unknown>>;

const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/** "== 1", ">= 2 and < 5", or "present" without comparisons. */
export function describeCompare(c: Compare, none = 'present') {
  const sym = { equals: '==', notEquals: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;
  const parts = COMPARE_OPS.filter((op) => c[op] !== undefined).map((op) => `${sym[op]} ${show(c[op])}`);
  return parts.length ? parts.join(' and ') : none;
}

function compare(actual: unknown, c: Compare, none: (v: unknown) => boolean = (v) => v !== null && v !== undefined) {
  const ops = COMPARE_OPS.filter((op) => c[op] !== undefined);
  if (!ops.length) return none(actual);
  return ops.every((op) => {
    const want = c[op];
    if (op === 'equals') return actual === want || (actual === undefined && want === null);
    if (op === 'notEquals') return actual !== want && !(actual === undefined && want === null);
    if (typeof actual !== 'number') return false;
    const n = want as number;
    return op === 'gt' ? actual > n : op === 'gte' ? actual >= n : op === 'lt' ? actual < n : actual <= n;
  });
}

function at(obj: unknown, path: string): unknown {
  let v = obj;
  for (const key of path.split('.')) {
    if (v === null || v === undefined || typeof v !== 'object') return null;
    v = (v as Record<string, unknown>)[key];
  }
  return v === undefined ? null : v;
}

/** Plain-words description of an assertion, used as its label in reports. */
export function describeAssertion(a: Assertion): string {
  switch (a.assert) {
    case 'entityExists':
      return a.exists ? `entity "${a.id}" exists` : `entity "${a.id}" does not exist`;
    case 'entityAt':
      return `entity "${a.id}" at ${[a.x !== undefined && `x ${a.x}`, a.y !== undefined && `y ${a.y}`].filter(Boolean).join(', ')} (±${a.tolerance})`;
    case 'entityNear':
      return `entity "${a.id}" within ${a.within} px of "${a.target}"`;
    case 'entity':
      return `entity("${a.id}").${a.field} ${describeCompare(a)}`;
    case 'component':
      return a.field ? `${a.component}.${a.field} of "${a.id}" ${describeCompare(a)}` : `"${a.id}" has ${a.component}`;
    case 'state':
      return `"${a.id}" in state "${a.is}"`;
    case 'variable':
      return `vars.${a.var} ${describeCompare(a)}`;
    case 'count':
      return `count of "${a.tag}" ${describeCompare(a, '>= 1')}`;
    case 'eventOccurred': {
      const match = a.match ? ` ${JSON.stringify(a.match)}` : '';
      return `event "${a.event}"${match} ${describeCompare(a, 'occurred')}`;
    }
    case 'scene':
      return `scene is "${a.is}"`;
    case 'gameWon':
      return 'game won';
    case 'gameLost':
      return 'game lost';
    case 'status':
      return `status is "${a.is}"`;
  }
}

export function checkAssertion(game: Game, a: Assertion): AssertionResult {
  const label = describeAssertion(a);
  const result = (pass: boolean, expected: string, actual: unknown, evidence?: Record<string, unknown>): AssertionResult => ({
    pass,
    label,
    expected,
    actual: actual === undefined ? null : actual,
    ...(!pass && evidence && { evidence }),
  });
  const w = game.world;
  const missing = (id: string) => ({ exists: false, similarIds: w.entities.map((e) => e.id).filter((x) => x.includes(id) || id.includes(x)).slice(0, 5) });
  const snapshot = (id: string) => {
    const e = game.entity(id);
    return e ? { ...game.getState({ ids: [id] }).entities[0], enabled: e.enabled } : undefined;
  };

  switch (a.assert) {
    case 'entityExists': {
      const exists = game.entity(a.id) !== undefined;
      const e = game.entity(a.id);
      return result(exists === a.exists, a.exists ? 'exists' : 'does not exist', exists, exists ? { x: e!.x, y: e!.y, enabled: e!.enabled } : missing(a.id));
    }
    case 'entityAt': {
      const e = game.entity(a.id);
      if (!e) return result(false, label, null, missing(a.id));
      const dx = a.x === undefined ? 0 : e.x - a.x;
      const dy = a.y === undefined ? 0 : e.y - a.y;
      const pos = { x: round(e.x), y: round(e.y) };
      return result(Math.abs(dx) <= a.tolerance && Math.abs(dy) <= a.tolerance, `x ${a.x ?? 'any'}, y ${a.y ?? 'any'} (±${a.tolerance})`, pos, {
        off: { dx: round(dx), dy: round(dy) },
      });
    }
    case 'entityNear': {
      const e = game.entity(a.id);
      const t = game.entity(a.target);
      if (!e || !t) return result(false, `<= ${a.within} px`, null, { [a.id]: !!e, [a.target]: !!t });
      const d = round(Math.hypot(e.x - t.x, e.y - t.y));
      return result(d <= a.within, `<= ${a.within} px`, d, { [a.id]: { x: round(e.x), y: round(e.y) }, [a.target]: { x: round(t.x), y: round(t.y) } });
    }
    case 'entity': {
      const s = snapshot(a.id);
      if (!s) return result(false, describeCompare(a), null, missing(a.id));
      const v = at(s, a.field);
      const top = a.field.split('.')[0];
      return result(compare(v, a), describeCompare(a), v, v === null && !(top in s) ? { fields: Object.keys(s) } : undefined);
    }
    case 'component': {
      const e = game.entity(a.id);
      if (!e) return result(false, describeCompare(a), null, missing(a.id));
      const data = (e.components as Record<string, unknown>)[a.component];
      if (data === undefined) return result(false, `has ${a.component}`, null, { components: Object.keys(e.components) });
      if (!a.field) return result(compare(data, a), describeCompare(a), data);
      const v = at(data, a.field);
      return result(compare(v, a), describeCompare(a), v, v === null ? { fields: Object.keys(data as object) } : undefined);
    }
    case 'state': {
      const s = snapshot(a.id);
      if (!s) return result(false, `state "${a.is}"`, null, missing(a.id));
      if (s.state === undefined) return result(false, `state "${a.is}"`, null, { stateMachine: false });
      const recent = game
        .events(0, 'state_change')
        .filter((ev) => ev.entity === a.id)
        .slice(-5)
        .map((ev) => `${ev.from ?? 'start'}->${ev.to} @${ev.frame}`);
      return result(s.state === a.is, `state "${a.is}"`, s.state, { stateMs: s.stateMs, prevState: s.prevState, recentChanges: recent });
    }
    case 'variable': {
      const v = w.vars[a.var];
      return result(compare(v, a), describeCompare(a), v, v === undefined ? { vars: Object.keys(w.vars) } : undefined);
    }
    case 'count': {
      const n = w.withTag(a.tag).length;
      return result(compare(n, a, (v) => (v as number) >= 1), describeCompare(a, '>= 1'), n);
    }
    case 'eventOccurred': {
      const all = game.events(0, a.event);
      const matching = a.match ? all.filter((ev) => Object.entries(a.match!).every(([k, v]) => ev[k] === v)) : all;
      const pass = compare(matching.length, a, (v) => (v as number) >= 1);
      const evidence: Record<string, unknown> = {};
      if (a.match && all.length > matching.length) evidence.otherEventsOfType = all.filter((ev) => !matching.includes(ev)).slice(-3);
      if (matching.length) evidence.last = matching.slice(-3);
      if (!all.length) evidence.eventTypesSeen = [...new Set(game.events().map((ev) => ev.type))];
      return result(pass, describeCompare(a, '>= 1'), matching.length, evidence);
    }
    case 'scene':
      return result(w.scene.id === a.is, `"${a.is}"`, w.scene.id);
    case 'gameWon':
    case 'gameLost':
    case 'status': {
      const want = a.assert === 'gameWon' ? 'won' : a.assert === 'gameLost' ? 'lost' : a.is;
      const ends = game.events(0).filter((ev) => ['win', 'lose', 'death', 'crash'].includes(ev.type)).slice(-3);
      return result(w.status === want, `"${want}"`, w.status, ends.length ? { endEvents: ends } : undefined);
    }
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
