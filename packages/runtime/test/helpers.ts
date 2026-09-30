import { fileURLToPath } from 'node:url';
import { assertProject, type EntityInput, type Project } from '@vibe/shared';
import { readProjectDir } from '../vite/project-files';
import type { CanvasLike, Scheduler } from '../src';

export const PROJECTS_ROOT = fileURLToPath(new URL('../../../projects', import.meta.url));

export function demoProject(): Project {
  return assertProject(readProjectDir(`${PROJECTS_ROOT}/demo-platformer`));
}

export function project(entities: EntityInput[], scene: Record<string, unknown> = {}, config: Record<string, unknown> = {}): Project {
  return assertProject({
    config: { name: 't', startScene: 'main', width: 400, height: 300, ...config },
    scenes: { main: { id: 'main', width: 2000, height: 300, ...scene, entities } },
  });
}

export type Op = { op: string; args: unknown[] } | { op: 'set'; prop: string; value: unknown };

/** Canvas 2D context stand-in that records every method call and property assignment. */
export function recordingContext() {
  const ops: Op[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (text: string) => ({ width: text.length * 6 });
      if (prop in target) return target[prop];
      return (...args: unknown[]) => {
        ops.push({ op: prop, args });
      };
    },
    set(target, prop: string, value) {
      target[prop] = value;
      ops.push({ op: 'set', prop, value });
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  const calls = (name: string) => ops.filter((o) => o.op === name).map((o) => (o as { args: unknown[] }).args);
  return { ctx, ops, calls };
}

export function fakeCanvas() {
  const rec = recordingContext();
  const canvas: CanvasLike = { width: 0, height: 0, getContext: () => rec.ctx };
  return { canvas, ...rec };
}

/** Scheduler driven by hand: `run(now)` fires the pending animation frame callback. */
export function manualScheduler() {
  let pending: ((now: number) => void) | null = null;
  let nextId = 1;
  const scheduler: Scheduler = {
    request(cb) {
      pending = cb;
      return nextId++;
    },
    cancel() {
      pending = null;
    },
  };
  return {
    scheduler,
    run(now: number) {
      const cb = pending;
      pending = null;
      cb?.(now);
    },
    get hasPending() {
      return pending !== null;
    },
  };
}
