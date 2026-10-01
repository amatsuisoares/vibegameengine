/** Total size limit of a game's saved data (JSON), so a runaway script cannot fill the disk/localStorage. */
export const MAX_STORAGE_BYTES = 512 * 1024;

/**
 * Persistent key/value data of a game (save files): JSON values only. The host decides where
 * it lives — the browser keeps it in localStorage across sessions; headless runs start from
 * the data the agent passes to run_game, so they stay replayable. `restart` goes back to the
 * data the game started with.
 */
export class GameStorage {
  private data: Record<string, unknown>;

  constructor(
    private readonly initial: Record<string, unknown> = {},
    private readonly onChange?: (data: Record<string, unknown>) => void,
  ) {
    this.data = structuredClone(initial);
  }

  get(key: string): unknown {
    const v = this.data[checkKey(key)];
    return v === undefined ? undefined : structuredClone(v);
  }

  set(key: string, value: unknown) {
    const k = checkKey(key);
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      throw new Error(`storage.set("${k}"): value is not JSON (${err instanceof Error ? err.message : String(err)})`);
    }
    if (json === undefined) throw new Error(`storage.set("${k}"): value is not JSON (use remove to delete a key)`);
    const next = { ...this.data, [k]: JSON.parse(json) };
    const size = JSON.stringify(next).length;
    if (size > MAX_STORAGE_BYTES) throw new Error(`storage is full (${size} bytes; max ${MAX_STORAGE_BYTES})`);
    this.data = next;
    this.onChange?.(this.snapshot());
  }

  remove(key: string) {
    const k = checkKey(key);
    if (!(k in this.data)) return;
    const { [k]: _gone, ...rest } = this.data;
    this.data = rest;
    this.onChange?.(this.snapshot());
  }

  keys(): string[] {
    return Object.keys(this.data);
  }

  snapshot(): Record<string, unknown> {
    return structuredClone(this.data);
  }

  reset() {
    this.data = structuredClone(this.initial);
  }
}

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !key) throw new Error('storage key must be a non-empty string');
  return key;
}
