import type { HotState } from './hot-state';

/**
 * Save slots (V0.6): named snapshots of a game — its running state (the hot reload capture: scene,
 * positions, variables, entities...) plus a copy of game.storage — that the game can save, load,
 * delete and list (saveSlot / loadSlot / deleteSlot / listSlots from scripts, rule actions).
 *
 * Optional: a game that never saves a slot behaves as before. Like game.storage, the host decides
 * where slots live (the browser page keeps them on disk; headless runs start from the slots the
 * agent passes, so they stay replayable) and `restart` goes back to the slots the game started with.
 */

export const MAX_SLOTS = 20;
/** Total size limit of all slots (JSON). */
export const MAX_SLOTS_BYTES = 2 * 1024 * 1024;
export const SLOT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export interface SaveSlot {
  version: 1;
  label?: string;
  /** Game clock (epoch ms) when it was saved. */
  savedAt: number;
  scene: string;
  storage: Record<string, unknown>;
  state: HotState;
}

export interface SlotInfo {
  name: string;
  label?: string;
  savedAt: number;
  scene: string;
}

/** What rules and scripts reach to use slots (implemented by the Game). */
export interface SlotHost {
  saveSlot(name: string, label?: string): void;
  /** Loads at the end of the frame; false when there is no such slot. */
  loadSlot(name: string): boolean;
  deleteSlot(name: string): boolean;
  listSlots(): SlotInfo[];
}

export function checkSlotName(name: unknown): string {
  if (typeof name !== 'string' || !SLOT_NAME.test(name)) {
    throw new Error(`invalid slot name ${JSON.stringify(name)}: 1-40 letters, digits, "_" or "-"`);
  }
  return name;
}

export class GameSaves {
  private slots: Record<string, SaveSlot>;

  constructor(
    private readonly initial: Record<string, SaveSlot> = {},
    private readonly onChange?: (slots: Record<string, SaveSlot>) => void,
  ) {
    this.slots = structuredClone(initial);
  }

  get(name: string): SaveSlot | undefined {
    const s = this.slots[checkSlotName(name)];
    return s && structuredClone(s);
  }

  put(name: string, slot: SaveSlot) {
    const n = checkSlotName(name);
    if (!(n in this.slots) && Object.keys(this.slots).length >= MAX_SLOTS) throw new Error(`too many save slots (max ${MAX_SLOTS}); delete one first`);
    const next = { ...this.slots, [n]: structuredClone(slot) };
    const size = JSON.stringify(next).length;
    if (size > MAX_SLOTS_BYTES) throw new Error(`save slots are full (${size} bytes; max ${MAX_SLOTS_BYTES})`);
    this.slots = next;
    this.onChange?.(this.snapshot());
  }

  delete(name: string): boolean {
    const n = checkSlotName(name);
    if (!(n in this.slots)) return false;
    const { [n]: _gone, ...rest } = this.slots;
    this.slots = rest;
    this.onChange?.(this.snapshot());
    return true;
  }

  /** Slots by name, without their data. */
  list(): SlotInfo[] {
    return Object.entries(this.slots)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, s]) => ({ name, ...(s.label && { label: s.label }), savedAt: s.savedAt, scene: s.scene }));
  }

  snapshot(): Record<string, SaveSlot> {
    return structuredClone(this.slots);
  }

  reset() {
    this.slots = structuredClone(this.initial);
  }
}
