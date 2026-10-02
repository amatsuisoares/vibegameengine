import type { Item } from '@vibe/shared';

/**
 * The item catalog of a game (items/<id>.json), read-only at runtime. Scripts see it as
 * game.items and use an item on an entity with game.useItem(item, target): that emits
 * "item_used" and calls the target's onItem(self, item, game, by) hook, whose return value
 * goes back to the caller. Nothing here decides what an item does — the target's script does
 * (usually by asking its Preferences how it feels about the item: self.prefs.item(item)).
 */

/** An item as scripts see it: the catalog entry plus its id. */
export interface ItemInfo extends Item {
  id: string;
}

export interface ItemFilter {
  category?: string;
  tag?: string;
}

export class ItemCatalog {
  constructor(private readonly items: Record<string, Item> = {}) {}

  has(id: string): boolean {
    return Object.hasOwn(this.items, id);
  }

  /** A copy of the item, or null. */
  get(id: string): ItemInfo | null {
    return this.has(id) ? { id, ...structuredClone(this.items[id]) } : null;
  }

  /** The item, or an error that lists the known ids. */
  require(id: unknown): ItemInfo {
    const item = typeof id === 'string' ? this.get(id) : null;
    if (!item) throw new Error(`item "${String(id)}" does not exist (items: ${Object.keys(this.items).join(', ') || 'none'})`);
    return item;
  }

  /** Items in catalog order, optionally of one category and/or with one tag. */
  list(filter: ItemFilter = {}): ItemInfo[] {
    return Object.keys(this.items)
      .map((id) => this.get(id)!)
      .filter((i) => (filter.category === undefined || i.category === filter.category) && (filter.tag === undefined || i.tags.includes(filter.tag)));
  }
}

/** The tags an item is evaluated by: its category first, then its own tags. */
export function itemTags(item: { category: string; tags: readonly string[] }): string[] {
  return [item.category, ...item.tags.filter((t) => t !== item.category)];
}
