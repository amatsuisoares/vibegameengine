import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { ProjectStore, RuntimeHost } from '../src';
import { createAgentTools, type ToolResult } from '../src/tools';

const DEMO = fileURLToPath(new URL('../../../test-fixtures/demo-platformer', import.meta.url));
const temps: string[] = [];

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

/** A throwaway copy of the demo project (without its .vibe folder). */
export function demoCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'vibe-store-')), 'demo');
  temps.push(dirname(dir));
  cpSync(DEMO, dir, { recursive: true, filter: (src) => !src.includes('.vibe') });
  return dir;
}

function dirname(p: string) {
  return p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')));
}

let tick = 0;
export const fixedClock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));

export function setup() {
  const dir = demoCopy();
  const store = new ProjectStore(dir, { clock: fixedClock });
  const tools = createAgentTools();
  const host = new RuntimeHost(store);
  const call = (name: string, input: unknown = {}, author: 'agent' | 'user' = 'agent') => tools.call(name, input, { store, author, host });
  /** Calls a tool and returns its result, failing the test with the error if it did not succeed. */
  const ok = async <T = Record<string, unknown>>(name: string, input: unknown = {}) => {
    const r = await call(name, input);
    if (!r.ok) throw new Error(`${name} failed: ${r.error}\n${(r.details ?? []).join('\n')}`);
    return r.result as T;
  };
  const fail = async (name: string, input: unknown = {}) => {
    const r = await call(name, input);
    if (r.ok) throw new Error(`${name} unexpectedly succeeded`);
    return r as Extract<ToolResult, { ok: false }>;
  };
  return { dir, store, tools, host, call, ok, fail };
}
