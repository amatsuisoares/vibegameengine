import type { ItemCatalog, ItemFilter, ItemInfo } from './items';
import type { GameStorage } from './storage';
import type { World } from './world';

/**
 * Economy: inventories (how many of each catalog item the player has), wallets (amounts per
 * currency) and buying (item price → wallet → inventory). Everything lives in game.storage, so it
 * persists like the rest of the save, goes into save slots and resets on restart. Keys are reserved:
 *
 *   storage["vibe.inventory"] = { <inventory>: { <itemId>: count } }     ("default" when unnamed)
 *   storage["vibe.wallet"]    = { <currency>: amount }                   ("coins" when unnamed)
 *
 * Events: inventory_change {inventory, item, delta, count, reason?}, currency_change {currency,
 * delta, amount, reason?}, purchase {item, qty, price, currency, inventory}, purchase_failed
 * {item, reason}. What items do and how money is earned is the game's business.
 */

export const INVENTORY_KEY = 'vibe.inventory';
export const WALLET_KEY = 'vibe.wallet';
export const DEFAULT_INVENTORY = 'default';
export const DEFAULT_CURRENCY = 'coins';

type Counts = Record<string, Record<string, number>>;

export interface InventoryEntry {
  item: ItemInfo;
  count: number;
}

export interface Inventory {
  readonly name: string;
  count(item: string): number;
  has(item: string, n?: number): boolean;
  /** Adds n (default 1) of a catalog item; returns the new count. */
  add(item: string, n?: number, reason?: string): number;
  /** Removes n if there are enough (true) or nothing (false). */
  remove(item: string, n?: number, reason?: string): boolean;
  /** What it holds, in catalog order, optionally of one category / with one tag. */
  list(filter?: ItemFilter): InventoryEntry[];
  /** Total number of items. */
  readonly size: number;
}

export interface Wallet {
  get(currency?: string): number;
  /** Adds (or with a negative amount takes, never below 0); returns the new amount. */
  add(amount: number, currency?: string, reason?: string): number;
  /** Takes the amount if there is enough (true) or nothing (false). */
  spend(amount: number, currency?: string, reason?: string): boolean;
  /** Amount per currency. */
  all(): Record<string, number>;
}

export type BuyResult =
  | { ok: true; item: string; qty: number; price: number; currency: string; count: number }
  | { ok: false; item: string; reason: 'unknown' | 'notForSale' | 'funds'; price?: number; currency?: string };

export interface BuyOptions {
  qty?: number;
  currency?: string;
  inventory?: string;
}

const count = (n: unknown, what: string) => {
  const v = n === undefined ? 1 : Number(n);
  if (!Number.isInteger(v) || v < 1) throw new Error(`${what}: count must be a whole number >= 1 (got ${String(n)})`);
  return v;
};
const name = (v: unknown, fallback: string, what: string) => {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !v) throw new Error(`${what} must be a non-empty string`);
  return v;
};

export class Economy {
  constructor(
    private readonly storage: GameStorage,
    private readonly items: ItemCatalog,
    private readonly world: () => World,
  ) {}

  private counts(): Counts {
    const v = this.storage.get(INVENTORY_KEY);
    return v && typeof v === 'object' ? (v as Counts) : {};
  }

  private amounts(): Record<string, number> {
    const v = this.storage.get(WALLET_KEY);
    return v && typeof v === 'object' ? (v as Record<string, number>) : {};
  }

  inventory(inventoryName?: string): Inventory {
    const inv = name(inventoryName, DEFAULT_INVENTORY, 'inventory name');
    const get = (item: string) => this.counts()[inv]?.[item] ?? 0;
    const change = (item: string, delta: number, reason?: string) => {
      const all = this.counts();
      const bag = (all[inv] ??= {});
      const next = (bag[item] ?? 0) + delta;
      if (next > 0) bag[item] = next;
      else delete bag[item];
      this.storage.set(INVENTORY_KEY, all);
      this.world().emit('inventory_change', { inventory: inv, item, delta, count: Math.max(0, next), ...(reason && { reason }) });
      return Math.max(0, next);
    };
    const economy = this;
    return {
      name: inv,
      count: (item) => get(String(item)),
      has: (item, n = 1) => get(String(item)) >= count(n, 'has'),
      add: (item, n, reason) => change(this.items.require(item).id, count(n, 'add'), reason),
      remove: (item, n, reason) => {
        const k = count(n, 'remove');
        const id = this.items.require(item).id;
        if (get(id) < k) return false;
        change(id, -k, reason);
        return true;
      },
      list(filter = {}) {
        const bag = economy.counts()[inv] ?? {};
        return economy.items.list(filter).filter((i) => (bag[i.id] ?? 0) > 0).map((i) => ({ item: i, count: bag[i.id] }));
      },
      get size() {
        return Object.values(economy.counts()[inv] ?? {}).reduce((s, n) => s + n, 0);
      },
    };
  }

  readonly wallet: Wallet = {
    get: (currency) => this.amounts()[name(currency, DEFAULT_CURRENCY, 'currency')] ?? 0,
    add: (amount, currency, reason) => {
      const cur = name(currency, DEFAULT_CURRENCY, 'currency');
      if (typeof amount !== 'number' || !Number.isFinite(amount)) throw new Error('wallet.add: amount must be a number');
      const all = this.amounts();
      const before = all[cur] ?? 0;
      const after = Math.max(0, before + amount);
      if (after === before) return after;
      all[cur] = after;
      this.storage.set(WALLET_KEY, all);
      this.world().emit('currency_change', { currency: cur, delta: after - before, amount: after, ...(reason && { reason }) });
      return after;
    },
    spend: (amount, currency, reason) => {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error('wallet.spend: amount must be a number >= 0');
      if (this.wallet.get(currency) < amount) return false;
      this.wallet.add(-amount, currency, reason);
      return true;
    },
    all: () => this.amounts(),
  };

  /** Items with a price (for sale), optionally of one category / with one tag. */
  forSale(filter: ItemFilter = {}): ItemInfo[] {
    return this.items.list(filter).filter((i) => i.price !== undefined);
  }

  /** Buys qty of an item at its catalog price: wallet → inventory. Never throws for a refused buy. */
  buy(itemId: string, options: BuyOptions = {}): BuyResult {
    const qty = count(options.qty, 'buy');
    const currency = name(options.currency, DEFAULT_CURRENCY, 'currency');
    const item = this.items.get(String(itemId));
    const fail = (reason: 'unknown' | 'notForSale' | 'funds', price?: number): BuyResult => {
      this.world().emit('purchase_failed', { item: String(itemId), reason });
      return { ok: false, item: String(itemId), reason, ...(price !== undefined && { price, currency }) };
    };
    if (!item) return fail('unknown');
    if (item.price === undefined) return fail('notForSale');
    const price = item.price * qty;
    if (!this.wallet.spend(price, currency, `buy ${item.id}`)) return fail('funds', price);
    const inv = this.inventory(options.inventory);
    const after = inv.add(item.id, qty, 'purchase');
    this.world().emit('purchase', { item: item.id, qty, price, currency, inventory: inv.name });
    return { ok: true, item: item.id, qty, price, currency, count: after };
  }

  /** For the game state: non-empty inventories and wallets. */
  snapshot(): { inventories?: Counts; wallet?: Record<string, number> } {
    const inventories = Object.fromEntries(Object.entries(this.counts()).filter(([, bag]) => Object.keys(bag).length));
    const wallet = this.amounts();
    return { ...(Object.keys(inventories).length && { inventories }), ...(Object.keys(wallet).length && { wallet }) };
  }
}
