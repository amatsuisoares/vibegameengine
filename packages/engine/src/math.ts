/** Axis-aligned box; (x, y) is the top-left corner. */
export interface AABB {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Strict overlap with a small tolerance so boxes that merely touch do not count. */
export function overlaps(a: AABB, b: AABB, eps = 1e-6): boolean {
  return a.x < b.x + b.w - eps && a.x + a.w > b.x + eps && a.y < b.y + b.h - eps && a.y + a.h > b.y + eps;
}

export function inflate(a: AABB, by: number): AABB {
  return { x: a.x - by, y: a.y - by, w: a.w + by * 2, h: a.h + by * 2 };
}

export function pointInBox(px: number, py: number, b: AABB): boolean {
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

export function approach(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(value + maxDelta, target);
  if (value > target) return Math.max(value - maxDelta, target);
  return value;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
