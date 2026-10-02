import type { EntityInput, ItemInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';

/** A shop-keeper NPC with tastes (nothing pet-specific) and a tiny catalog. */
const ITEMS: Record<string, ItemInput> = {
  apple: { name: 'Apple', category: 'food', tags: ['fruit', 'sweet'], props: { satiety: 20 }, icon: '🍎', price: 3 },
  pepper: { name: 'Pepper', category: 'food', tags: ['spicy'], props: { satiety: 5 } },
  lute: { name: 'Lute', category: 'instrument', tags: ['noisy'], consumable: false },
};

function game(entities: EntityInput[], scripts: Record<string, string> = {}, items: Record<string, unknown> = ITEMS) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, entities } }, scripts, items },
    { seed: 1 },
  );
}

const keeper = (components: NonNullable<EntityInput['components']> = {}): EntityInput => ({
  id: 'keeper',
  transform: { x: 100, y: 100 },
  components: {
    Sprite: {},
    Preferences: { values: { apple: { innate: -0.5 }, fruit: { innate: 1 }, food: { innate: 0.2 }, noisy: { innate: -0.8 } } },
    Script: { src: 'scripts/keeper.js' },
    ...components,
  },
});

describe('items', () => {
  it('scripts read the catalog: get (a copy with its id), has, list by category or tag', () => {
    const g = game([keeper()], {
      'scripts/keeper.js': `function onStart(self, game) {
        const a = game.items.get('apple');
        a.name = 'changed';
        game.vars.name = game.items.get('apple').name;
        game.vars.icon = a.icon;
        game.vars.foods = game.items.list({ category: 'food' }).map((i) => i.id).join(',');
        game.vars.sweet = game.items.list({ tag: 'sweet' }).map((i) => i.id).join(',');
        game.vars.missing = game.items.get('nope') === null && !game.items.has('nope');
        game.vars.lute = game.items.get('lute').consumable;
      }`,
    });
    g.step(1);
    expect(g.world.vars).toMatchObject({ name: 'Apple', icon: '🍎', foods: 'apple,pepper', sweet: 'apple', missing: true, lute: false });
  });

  it('useItem emits item_used and runs the target onItem, whose answer goes back to the caller', () => {
    const g = game(
      [
        keeper(),
        { id: 'player', transform: { x: 0, y: 0 }, components: { Sprite: {}, Collider: { width: 20, height: 20 }, Script: { src: 'scripts/player.js' } } },
        { id: 'rock', transform: { x: 300, y: 0 }, components: { Sprite: {} } },
      ],
      {
        'scripts/keeper.js': `function onItem(self, item, game, by) {
          const r = self.prefs.item(item);
          game.vars.by = by ? by.id : 'nobody';
          return { level: r.level, parts: r.parts };
        }`,
        'scripts/player.js': `function onClick(self, game) {
          game.vars.answer = JSON.stringify(game.useItem('apple', 'keeper', self));
          game.vars.rock = JSON.stringify(game.useItem('lute', 'rock'));
          game.useItem('nope', 'keeper');
        }`,
      },
    );
    g.perform([{ type: 'click', entity: 'player' }, { type: 'wait', ms: 50 }]);
    // apple: 0.6 × -0.5 + 0.4 × mean(food 0.2, fruit 1, sweet unknown) = -0.06 → neutral
    expect(JSON.parse(String(g.world.vars.answer))).toEqual({ handled: true, result: { level: 'neutral', parts: { apple: -0.5, food: 0.2, fruit: 1 } } });
    expect(g.world.vars.by).toBe('player');
    expect(JSON.parse(String(g.world.vars.rock))).toEqual({ handled: false }); // no hook: nobody reacts
    expect(g.events(0, 'item_used').map((e) => [e.item, e.target, e.by, e.category])).toEqual([
      ['apple', 'keeper', 'player', 'food'],
      ['lute', 'rock', undefined, 'instrument'],
    ]);
    expect(g.console.read(0, 'error')[0].message).toMatch(/item "nope" does not exist \(items: apple, pepper, lute\)/);
  });

  it('likes() in expressions evaluates an item by its id, category and tags; item() reads the catalog', () => {
    const g = game([
      keeper({
        Script: undefined,
        UtilityAI: { options: { trade: { score: "likes('apple') + 1" }, shun: { score: "-likes('lute') + item('apple').price" }, plain: { score: "likes('fruit')" } } },
      }),
    ]);
    g.step(1);
    expect(g.getState({ ids: ['keeper'] }).entities[0].ai!.scores).toEqual({ trade: 0.94, shun: 3.8, plain: 1 });
  });

  it('validation: items need a valid shape, existing assets and prefabs', () => {
    expect(() => game([], {}, { bad: { name: 'Bad', category: 'food', tags: 'fruit' } })).toThrow(/items\.bad\.tags/);
    expect(() => game([], {}, { pic: { name: 'Pic', category: 'deco', asset: 'nope' } })).toThrow(/items\.pic\.asset: asset "nope" does not exist/);
    expect(() => game([], {}, { bed: { name: 'Bed', category: 'furniture', prefab: 'nope' } })).toThrow(/items\.bed\.prefab: prefab "nope" does not exist/);
    expect(() => game([], {}, { x: { name: 'X', category: 'food', bonus: 10 } })).toThrow(/bonus/);
  });
});
