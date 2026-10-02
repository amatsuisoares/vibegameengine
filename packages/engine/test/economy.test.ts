import type { EntityInput, ItemInput, SceneInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';

const ITEMS: Record<string, ItemInput> = {
  potion: { name: 'Potion', category: 'consumable', tags: ['healing'], price: 5 },
  sword: { name: 'Sword', category: 'weapon', tags: ['sharp'], price: 30, consumable: false },
  key: { name: 'Key', category: 'quest' },
};

function game(entities: EntityInput[], opts: { scripts?: Record<string, string>; storage?: Record<string, unknown>; rules?: SceneInput['rules'] } = {}) {
  return Game.fromRaw(
    {
      config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 },
      scenes: { main: { id: 'main', width: 400, height: 300, entities, rules: opts.rules ?? [] } },
      scripts: opts.scripts ?? {},
      items: ITEMS,
    },
    { seed: 1, storage: opts.storage },
  );
}

const hero = (src: string): EntityInput => ({ id: 'hero', transform: { x: 50, y: 50 }, components: { Sprite: {}, Collider: { width: 20, height: 20 }, Script: { src } } });

describe('economy', () => {
  it('inventories count catalog items, refuse what is missing, list in catalog order, and live in storage', () => {
    const g = game([hero('scripts/h.js')], {
      scripts: {
        'scripts/h.js': `function onStart(self, game) {
          const bag = game.inventory();
          bag.add('sword');
          game.vars.potions = bag.add('potion', 3, 'found');
          game.vars.took = bag.remove('potion', 2);
          game.vars.tooMany = bag.remove('potion', 5);
          game.vars.has = bag.has('potion') && !bag.has('key');
          game.vars.list = bag.list().map((e) => e.item.id + ':' + e.count).join(',');
          game.vars.weapons = bag.list({ category: 'weapon' }).length;
          game.vars.size = bag.size;
          game.inventory('chest').add('key');
          bag.add('dragon');
        }`,
      },
    });
    g.step(1);
    expect(g.world.vars).toMatchObject({ potions: 3, took: true, tooMany: false, has: true, list: 'potion:1,sword:1', weapons: 1, size: 2 });
    expect(g.storage.get('vibe.inventory')).toEqual({ default: { sword: 1, potion: 1 }, chest: { key: 1 } });
    expect(g.events(0, 'inventory_change').map((e) => [e.item, e.delta, e.count, e.reason])).toEqual([
      ['sword', 1, 1, undefined],
      ['potion', 3, 3, 'found'],
      ['potion', -2, 1, undefined],
      ['key', 1, 1, undefined],
    ]);
    expect(g.console.read(0, 'error')[0].message).toMatch(/item "dragon" does not exist/);
    expect(g.getState().inventories).toEqual({ default: { sword: 1, potion: 1 }, chest: { key: 1 } });
  });

  it('wallets add, spend only what there is, never go below 0, per currency', () => {
    const g = game([hero('scripts/h.js')], {
      scripts: {
        'scripts/h.js': `function onStart(self, game) {
          game.wallet.add(10, undefined, 'quest');
          game.wallet.add(2, 'gems');
          game.vars.spent = game.wallet.spend(4);
          game.vars.broke = game.wallet.spend(100);
          game.vars.coins = game.wallet.add(-50);
          game.vars.gems = game.wallet.get('gems');
        }`,
      },
    });
    g.step(1);
    expect(g.world.vars).toMatchObject({ spent: true, broke: false, coins: 0, gems: 2 });
    expect(g.events(0, 'currency_change').map((e) => [e.currency, e.delta, e.amount])).toEqual([
      ['coins', 10, 10],
      ['gems', 2, 2],
      ['coins', -4, 6],
      ['coins', -6, 0],
    ]);
    expect(g.getState().wallet).toEqual({ coins: 0, gems: 2 });
  });

  it('the shop sells priced items: wallet → inventory, and says why a purchase was refused', () => {
    const g = game([hero('scripts/h.js')], {
      storage: { 'vibe.wallet': { coins: 35 } },
      scripts: {
        'scripts/h.js': `function onStart(self, game) {
          game.vars.forSale = game.shop.list().map((i) => i.id).join(',');
          game.vars.a = JSON.stringify(game.shop.buy('potion', { qty: 2 }));
          game.vars.b = JSON.stringify(game.shop.buy('sword'));
          game.vars.c = JSON.stringify(game.shop.buy('key'));
          game.vars.d = JSON.stringify(game.shop.buy('nope'));
        }`,
      },
    });
    g.step(1);
    expect(g.world.vars.forSale).toBe('potion,sword');
    expect(JSON.parse(String(g.world.vars.a))).toEqual({ ok: true, item: 'potion', qty: 2, price: 10, currency: 'coins', count: 2 });
    expect(JSON.parse(String(g.world.vars.b))).toEqual({ ok: false, item: 'sword', reason: 'funds', price: 30, currency: 'coins' });
    expect(JSON.parse(String(g.world.vars.c))).toMatchObject({ ok: false, reason: 'notForSale' });
    expect(JSON.parse(String(g.world.vars.d))).toMatchObject({ ok: false, reason: 'unknown' });
    expect(g.getState().wallet).toEqual({ coins: 25 });
    expect(g.events(0, 'purchase')).toEqual([expect.objectContaining({ item: 'potion', qty: 2, price: 10, currency: 'coins', inventory: 'default' })]);
    expect(g.events(0, 'purchase_failed').map((e) => e.reason)).toEqual(['funds', 'notForSale', 'unknown']);
  });

  it('rules give and take items and currency; expressions read itemCount() and currency(); restart resets', () => {
    const g = game([{ id: 'chest', tags: ['clickable'], transform: { x: 200, y: 100 }, components: { Sprite: { width: 40, height: 40 }, Collider: { width: 40, height: 40 } } }], {
      rules: [
        { id: 'loot', when: { event: 'click', match: { entity: 'chest' } }, do: [{ action: 'giveItem', item: 'potion', count: 2 }, { action: 'addCurrency', amount: 7 }] },
        { id: 'drink', when: { expr: 'itemCount(\'potion\') >= 2 && currency() == 7' }, do: [{ action: 'takeItem', item: 'potion' }, { action: 'takeItem', item: 'key' }] },
      ],
    });
    g.perform([{ type: 'click', entity: 'chest' }, { type: 'wait', ms: 100 }]);
    expect(g.getState().inventories).toEqual({ default: { potion: 1 } });
    expect(g.getState().wallet).toEqual({ coins: 7 });
    expect(g.console.read(0).some((l) => /takeItem: not enough "key"/.test(l.message))).toBe(true);
    g.restart();
    expect(g.getState().inventories).toBeUndefined();
    expect(() =>
      game([], { rules: [{ id: 'r', when: { start: true }, do: [{ action: 'giveItem', item: 'dragon' }] }] }),
    ).toThrow(/rules\(r\)\.do\[0\]\.item: item "dragon" does not exist/);
  });

  it('save slots keep inventories and wallets', () => {
    const g = game([hero('scripts/h.js')], {
      scripts: {
        'scripts/h.js': `function onStart(self, game) { if (game.wallet.get() === 0) { game.wallet.add(5); game.saveSlot('s'); } }
          function onClick(self, game) { game.wallet.add(100); game.inventory().add('key'); game.loadSlot('s'); }`,
      },
    });
    g.step(1);
    g.perform([{ type: 'click', entity: 'hero' }, { type: 'wait', ms: 50 }]);
    expect(g.getState().wallet).toEqual({ coins: 5 });
    expect(g.getState().inventories).toBeUndefined();
  });
});
