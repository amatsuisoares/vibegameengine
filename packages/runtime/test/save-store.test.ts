import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitViewport, SaveStore, webStorageBackend, type KeyValueBackend } from '../src';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: string[] = [];
  const backend: KeyValueBackend = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      writes.push(k);
      data.set(k, v);
    },
    remove: async (k) => void data.delete(k),
  };
  return { data, writes, backend };
}

afterEach(() => vi.useRealTimers());

describe('SaveStore (save of an exported game on the device)', () => {
  it('loads what was saved, one key per game, and starts empty when there is nothing (or it is broken)', async () => {
    const m = memory({ 'vibe:pet:save': '{"pet":{"name":"Mimi"}}', 'vibe:pet:slots': '[1,2]' });
    const errors: string[] = [];
    const s = await new SaveStore(m.backend, 'vibe:pet', { onError: (e) => errors.push(e) }).load();
    expect(s.storage).toEqual({ pet: { name: 'Mimi' } });
    expect(s.slots).toEqual({});
    expect(errors).toEqual(['Saved slots is not an object; starting without it']);
    expect(await new SaveStore(m.backend, 'vibe:outro').load()).toEqual({ storage: {}, slots: {} });
  });

  it('defers writes (a burst of changes is one write) and flush() writes what is pending at once', async () => {
    vi.useFakeTimers();
    const m = memory();
    const store = new SaveStore(m.backend, 'vibe:pet', { delayMs: 500 });
    store.writeStorage({ a: 1 });
    store.writeStorage({ a: 2 });
    store.writeSlots({});
    expect(store.dirty).toBe(true);
    expect(m.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(m.writes).toEqual(['vibe:pet:save', 'vibe:pet:slots']);
    expect(JSON.parse(m.data.get('vibe:pet:save')!)).toEqual({ a: 2 });
    expect(store.dirty).toBe(false);

    store.writeStorage({ a: 3 });
    await store.flush(); // going to the background
    expect(JSON.parse(m.data.get('vibe:pet:save')!)).toEqual({ a: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.writes.length).toBe(3); // nothing written twice

    await store.clear();
    expect(m.data.size).toBe(0);
  });

  it('a backend that fails (full storage) is reported, not thrown', async () => {
    const errors: string[] = [];
    const store = new SaveStore({ get: async () => null, set: async () => Promise.reject(new Error('quota')), remove: async () => {} }, 'vibe:pet', { onError: (e) => errors.push(e) });
    store.writeStorage({ a: 1 });
    await store.flush();
    expect(errors).toEqual(['Could not save storage: quota']);
  });

  it('localStorage as the backend', async () => {
    const ls = new Map<string, string>();
    const backend = webStorageBackend({ getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => void ls.set(k, v), removeItem: (k) => void ls.delete(k) });
    const store = new SaveStore(backend, 'vibe:pet');
    store.writeStorage({ x: 1 });
    await store.flush();
    expect(ls.get('vibe:pet:save')).toBe('{"x":1}');
  });
});

describe('fitViewport (letterbox)', () => {
  it('fits the game in the window keeping its proportions, centered', () => {
    expect(fitViewport(1200, 900, 960, 540)).toEqual({ scale: 1.25, width: 1200, height: 675, left: 0, top: 112 });
    expect(fitViewport(800, 360, 960, 540)).toMatchObject({ width: 640, height: 360, left: 80, top: 0 });
    expect(fitViewport(960, 540, 960, 540)).toMatchObject({ scale: 1, left: 0, top: 0 });
  });
});
