import type { Components } from '@vibe/shared';
import type { Entity } from './entity';
import { hitBox } from './interact';
import type { AABB } from './math';
import type { World } from './world';

/**
 * Pathfinding on a grid over the scene (top-down movement). Cells whose center would put the agent's
 * box into an obstacle are blocked: obstacles are solid colliders (non-trigger, not dynamic bodies)
 * plus entities with `avoidTags`. A* with 8 directions (diagonals never cut corners), octile
 * heuristic and fixed tie-breaking, so the same scene always gives the same path. The result is
 * world points (cell centers where the path turns, then the goal), not including the start.
 *
 * NavAgent walks an entity along such a path to its `target` (entity, followed as it moves, or point),
 * re-planning every `repathMs`; with a non-static Body it steers by velocity (physics still resolves
 * collisions), otherwise it moves the position. Emits "nav_arrived" / "nav_failed" {entity, target}.
 */

export interface Point {
  x: number;
  y: number;
}

export interface PathOptions {
  /** Cell size in px (default 16). */
  cell?: number;
  diagonal?: boolean;
  /** Agent box size (clearance), default 0 x 0 (a point). */
  width?: number;
  height?: number;
  avoidTags?: string[];
  /** Entities that are never obstacles (e.g. the agent itself). */
  ignore?: Entity[];
  /** Search limit (nodes expanded). */
  maxNodes?: number;
}

export interface PathResult {
  points: Point[];
  /** Length in px along the points. */
  length: number;
}

export type NavStatus = 'idle' | 'moving' | 'arrived' | 'failed';

/** Live NavAgent state (kept on the Entity). */
export interface NavState {
  /** Target the path was planned for (JSON), to notice changes. */
  key: string;
  status: NavStatus;
  path: Point[];
  /** Frame of the next re-plan. */
  repathAt: number;
  /** Goal position the path was planned for (re-planned when the goal moves away from it). */
  goalAt: Point | null;
}

type NavData = NonNullable<Components['NavAgent']>;

const SQRT2 = Math.SQRT2;
const MAX_NODES = 40_000;
const round2 = (v: number) => Math.round(v * 100) / 100;

interface Grid {
  cols: number;
  rows: number;
  cell: number;
  blocked: Uint8Array;
}

function buildGrid(world: World, o: Required<Pick<PathOptions, 'cell' | 'width' | 'height' | 'avoidTags' | 'ignore'>>): Grid {
  const { cell } = o;
  const cols = Math.max(1, Math.ceil(world.scene.width / cell));
  const rows = Math.max(1, Math.ceil(world.scene.height / cell));
  const blocked = new Uint8Array(cols * rows);
  const hx = o.width / 2;
  const hy = o.height / 2;
  for (const e of world.entities) {
    if (!e.active || o.ignore.includes(e)) continue;
    const box: AABB | null = e.isSolid ? e.aabb() : o.avoidTags.length && e.hasAnyTag(o.avoidTags) ? hitBox(e) : null;
    if (!box) continue;
    // Cells whose center lies strictly inside the box grown by the agent's half size.
    const x0 = box.x - hx;
    const x1 = box.x + box.w + hx;
    const y0 = box.y - hy;
    const y1 = box.y + box.h + hy;
    const c0 = Math.max(0, Math.floor(x0 / cell - 0.5));
    const c1 = Math.min(cols - 1, Math.ceil(x1 / cell - 0.5));
    const r0 = Math.max(0, Math.floor(y0 / cell - 0.5));
    const r1 = Math.min(rows - 1, Math.ceil(y1 / cell - 0.5));
    for (let r = r0; r <= r1; r++) {
      const cy = (r + 0.5) * cell;
      if (cy <= y0 || cy >= y1) continue;
      for (let c = c0; c <= c1; c++) {
        const cx = (c + 0.5) * cell;
        if (cx > x0 && cx < x1) blocked[r * cols + c] = 1;
      }
    }
  }
  return { cols, rows, cell, blocked };
}

const cellOf = (g: Grid, p: Point) => {
  const c = Math.min(g.cols - 1, Math.max(0, Math.floor(p.x / g.cell)));
  const r = Math.min(g.rows - 1, Math.max(0, Math.floor(p.y / g.cell)));
  return r * g.cols + c;
};
const centerOf = (g: Grid, i: number): Point => ({ x: ((i % g.cols) + 0.5) * g.cell, y: (Math.floor(i / g.cols) + 0.5) * g.cell });

/** The free cell nearest to `i` (breadth-first by rings), or -1. */
function nearestFree(g: Grid, i: number): number {
  if (!g.blocked[i]) return i;
  const c0 = i % g.cols;
  const r0 = Math.floor(i / g.cols);
  const maxRing = Math.max(g.cols, g.rows);
  for (let ring = 1; ring <= maxRing; ring++) {
    let best = -1;
    let bestD = Infinity;
    for (let r = r0 - ring; r <= r0 + ring; r++) {
      for (let c = c0 - ring; c <= c0 + ring; c++) {
        if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) !== ring || r < 0 || c < 0 || r >= g.rows || c >= g.cols) continue;
        const j = r * g.cols + c;
        const d = (r - r0) ** 2 + (c - c0) ** 2;
        if (!g.blocked[j] && d < bestD) {
          best = j;
          bestD = d;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Minimal binary heap on (f, h, seq). */
class Heap {
  private items: { i: number; f: number; h: number; seq: number }[] = [];
  get size() {
    return this.items.length;
  }
  private less(a: number, b: number) {
    const x = this.items[a];
    const y = this.items[b];
    return x.f !== y.f ? x.f < y.f : x.h !== y.h ? x.h < y.h : x.seq < y.seq;
  }
  push(item: { i: number; f: number; h: number; seq: number }) {
    const a = this.items;
    a.push(item);
    for (let k = a.length - 1; k > 0; ) {
      const p = (k - 1) >> 1;
      if (!this.less(k, p)) break;
      [a[k], a[p]] = [a[p], a[k]];
      k = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let k = 0; ; ) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < a.length && this.less(l, m)) m = l;
        if (r < a.length && this.less(r, m)) m = r;
        if (m === k) break;
        [a[k], a[m]] = [a[m], a[k]];
        k = m;
      }
    }
    return top;
  }
}

function astar(g: Grid, start: number, goal: number, diagonal: boolean, maxNodes: number): number[] | null {
  const n = g.cols * g.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gc = goal % g.cols;
  const gr = Math.floor(goal / g.cols);
  const h = (i: number) => {
    const dx = Math.abs((i % g.cols) - gc);
    const dy = Math.abs(Math.floor(i / g.cols) - gr);
    return diagonal ? Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy) : dx + dy;
  };
  const open = new Heap();
  let seq = 0;
  gScore[start] = 0;
  open.push({ i: start, f: h(start), h: h(start), seq: seq++ });
  let expanded = 0;
  const dirs = diagonal
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (open.size) {
    const { i } = open.pop();
    if (closed[i]) continue;
    if (i === goal) {
      const out = [i];
      for (let k = from[i]; k >= 0; k = from[k]) out.push(k);
      return out.reverse();
    }
    closed[i] = 1;
    if (++expanded > maxNodes) return null;
    const c = i % g.cols;
    const r = Math.floor(i / g.cols);
    for (const [dc, dr] of dirs) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue;
      const j = nr * g.cols + nc;
      if (g.blocked[j] || closed[j]) continue;
      if (dc && dr && (g.blocked[r * g.cols + nc] || g.blocked[nr * g.cols + c])) continue; // no corner cutting
      const cost = gScore[i] + (dc && dr ? SQRT2 : 1);
      if (cost < gScore[j]) {
        gScore[j] = cost;
        from[j] = i;
        const hj = h(j);
        open.push({ i: j, f: cost + hj, h: hj, seq: seq++ });
      }
    }
  }
  return null;
}

/** Path from `from` to `to` (world points), or null when there is none. */
export function findPath(world: World, from: Point, to: Point, opts: PathOptions = {}): PathResult | null {
  for (const p of [from, to]) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) throw new Error('findPath: points need finite x and y');
  }
  const cell = opts.cell ?? 16;
  if (!(cell >= 1)) throw new Error('findPath: cell must be >= 1');
  const g = buildGrid(world, { cell, width: opts.width ?? 0, height: opts.height ?? 0, avoidTags: opts.avoidTags ?? [], ignore: opts.ignore ?? [] });
  const start = nearestFree(g, cellOf(g, from));
  const goalCell = cellOf(g, to);
  const goal = nearestFree(g, goalCell);
  if (start < 0 || goal < 0) return null;
  const cells = astar(g, start, goal, opts.diagonal ?? true, opts.maxNodes ?? MAX_NODES);
  if (!cells) return null;
  // Keep only the cells where the direction changes, then end exactly at the goal when it is free.
  const pts: Point[] = [];
  for (let k = 1; k < cells.length; k++) {
    const next = cells[k + 1];
    const d1 = cells[k] - cells[k - 1];
    if (next === undefined || next - cells[k] !== d1) pts.push(centerOf(g, cells[k]));
  }
  const end = goal === goalCell ? { x: to.x, y: to.y } : centerOf(g, goal);
  if (pts.length) pts[pts.length - 1] = end;
  else if (Math.hypot(end.x - from.x, end.y - from.y) > 0) pts.push(end);
  const points = pts.map((p) => ({ x: round2(p.x), y: round2(p.y) }));
  let length = 0;
  let prev = from;
  for (const p of points) {
    length += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return { points, length: round2(length) };
}

/** Options to plan for an entity: its box as clearance, itself never an obstacle. */
export function pathOptionsFor(e: Entity, nav?: Partial<NavData>): PathOptions {
  const box = hitBox(e);
  return { cell: nav?.cell, diagonal: nav?.diagonal, width: box?.w ?? 0, height: box?.h ?? 0, avoidTags: nav?.avoidTags, ignore: [e] };
}

const DT = 1 / 60;

/** Moves NavAgents along their paths. One per world; runs before physics. */
export class NavRunner {
  constructor(private readonly world: World) {}

  run(dt: number) {
    const w = this.world;
    for (const e of [...w.entities]) {
      const nav = e.components.NavAgent;
      if (!nav || !e.active) continue;
      this.step(e, nav, dt);
    }
  }

  private step(e: Entity, nav: NavData, dt: number) {
    const w = this.world;
    const goal = this.goalOf(nav);
    const key = JSON.stringify(nav.target);
    const st = (e.nav ??= { key: 'null', status: 'idle', path: [], repathAt: 0, goalAt: null });
    const body = e.components.Body && e.components.Body.type !== 'static' ? e.components.Body : null;
    if (!goal) {
      if (st.status !== 'idle' || key !== st.key) this.halt(st, key, 'idle', body);
      return;
    }
    const goalMoved = !st.goalAt || Math.hypot(goal.x - st.goalAt.x, goal.y - st.goalAt.y) > nav.arriveDistance;
    const replan =
      key !== st.key ||
      ((st.status === 'moving' || st.status === 'failed') && nav.repathMs > 0 && w.frame >= st.repathAt) ||
      ((st.status === 'arrived' || st.status === 'failed') && goalMoved);
    if (replan) {
      const changed = key !== st.key;
      st.key = key;
      st.goalAt = { ...goal };
      st.repathAt = w.frame + Math.max(1, Math.round(nav.repathMs / 1000 / DT));
      const near = Math.hypot(goal.x - e.x, goal.y - e.y) <= nav.arriveDistance;
      const path = near ? { points: [] } : findPath(w, { x: e.x, y: e.y }, goal, pathOptionsFor(e, nav));
      if (!path) {
        if (changed || st.status !== 'failed') {
          this.halt(st, key, 'failed', body);
          w.emit('nav_failed', { entity: e.id, target: nav.target });
        }
        return;
      }
      st.path = path.points;
      st.status = 'moving';
    }
    if (st.status !== 'moving') return;
    // The path is used up: arrived (at the goal, or as close as the obstacles allow).
    if (!st.path.length) {
      this.halt(st, key, 'arrived', body);
      w.emit('nav_arrived', { entity: e.id, target: nav.target });
      return;
    }
    if (body) {
      // One velocity per frame toward the next point, never overshooting it; physics does the move.
      const p = st.path[0];
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const d = Math.hypot(dx, dy);
      const s = Math.min(nav.speed, d / dt);
      body.vx = d ? (dx / d) * s : 0;
      body.vy = d ? (dy / d) * s : 0;
      if (d <= nav.speed * dt) st.path.shift();
      return;
    }
    let budget = nav.speed * dt;
    while (st.path.length && budget > 0) {
      const p = st.path[0];
      const dx = p.x - e.x;
      const dy = p.y - e.y;
      const d = Math.hypot(dx, dy);
      if (d <= budget) {
        e.x = p.x;
        e.y = p.y;
        budget -= d;
        st.path.shift();
      } else {
        e.x += (dx / d) * budget;
        e.y += (dy / d) * budget;
        budget = 0;
      }
    }
  }

  private halt(st: NavState, key: string, status: NavStatus, body: { vx: number; vy: number } | null) {
    st.key = key;
    st.status = status;
    st.path = [];
    if (body) {
      body.vx = 0;
      body.vy = 0;
    }
  }

  private goalOf(nav: NavData): Point | null {
    const t = nav.target;
    if (t === null) return null;
    if (typeof t !== 'string') return t;
    const e = this.world.get(t);
    if (!e) return null;
    const box = hitBox(e);
    return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : { x: e.x, y: e.y };
  }
}

export function snapshotNav(e: Entity) {
  const nav = e.components.NavAgent;
  if (!nav) return undefined;
  const st = e.nav;
  return {
    target: nav.target,
    status: st?.status ?? 'idle',
    ...(st?.path.length && { next: { ...st.path[0] }, waypoints: st.path.length }),
  };
}
