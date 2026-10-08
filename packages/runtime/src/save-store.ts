import type { SaveSlot } from '@vibe/engine';

/**
 * Where an exported game keeps its saved data (game.storage) and save slots on the device. The
 * player only talks to a SaveStore; the backend is a small async key/value store: localStorage in
 * a browser or Electron, Capacitor Preferences on Android (localStorage there can be cleared).
 *
 * Writes are deferred (a burst of changes becomes one write) and `flush()` forces them out — the
 * player calls it when the page is hidden, since a phone suspends the app without unloading it.
 */
export interface KeyValueBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface SaveData {
  storage: Record<string, unknown>;
  slots: Record<string, SaveSlot>;
}

export interface SaveStoreOptions {
  /** Delay before a change is written (ms). */
  delayMs?: number;
  onError?: (message: string) => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** localStorage (or anything shaped like it) as a backend; storage errors (private mode, full) are reported, not thrown. */
export function webStorageBackend(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): KeyValueBackend {
  return {
    get: async (key) => storage.getItem(key),
    set: async (key, value) => storage.setItem(key, value),
    remove: async (key) => storage.removeItem(key),
  };
}

export class SaveStore {
  private pending: Partial<SaveData> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly delayMs: number;
  private readonly onError: (message: string) => void;

  constructor(
    private readonly backend: KeyValueBackend,
    /** Key prefix, one per game (e.g. "vibe:meu-pet"). */
    private readonly prefix: string,
    options: SaveStoreOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 500;
    this.onError = options.onError ?? (() => {});
  }

  private key(part: keyof SaveData) {
    return `${this.prefix}:${part === 'storage' ? 'save' : 'slots'}`;
  }

  /** Reads what was saved; missing or broken data starts empty (and is reported). */
  async load(): Promise<SaveData> {
    const read = async (part: keyof SaveData) => {
      try {
        const text = await this.backend.get(this.key(part));
        if (text === null) return {};
        const data = JSON.parse(text);
        if (isObject(data)) return data;
        this.onError(`Saved ${part} is not an object; starting without it`);
      } catch (err) {
        this.onError(`Could not read saved ${part}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return {};
    };
    return { storage: await read('storage'), slots: (await read('slots')) as Record<string, SaveSlot> };
  }

  writeStorage(data: Record<string, unknown>) {
    this.pending.storage = data;
    this.schedule();
  }

  writeSlots(slots: Record<string, SaveSlot>) {
    this.pending.slots = slots;
    this.schedule();
  }

  get dirty() {
    return this.pending.storage !== undefined || this.pending.slots !== undefined;
  }

  /** Writes whatever is pending now. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = {};
    for (const part of ['storage', 'slots'] as const) {
      if (pending[part] === undefined) continue;
      try {
        await this.backend.set(this.key(part), JSON.stringify(pending[part]));
      } catch (err) {
        this.onError(`Could not save ${part}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Forgets everything saved (and anything pending). */
  async clear(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = {};
    for (const part of ['storage', 'slots'] as const) {
      try {
        await this.backend.remove(this.key(part));
      } catch (err) {
        this.onError(`Could not clear saved ${part}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private schedule() {
    this.timer ??= setTimeout(() => void this.flush(), this.delayMs);
  }
}
