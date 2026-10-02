import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setup } from './helpers';

const json = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));

describe('item tools', () => {
  it('create, list, modify and delete catalog items; the run sees them; bad items are rejected without writing', async () => {
    const { ok, fail, dir } = setup();
    const created = await ok<{ file: string }>('create_item', {
      id: 'apple',
      item: { name: 'Apple', category: 'food', tags: ['fruit', 'sweet'], props: { satiety: 20 }, icon: '🍎', price: 3 },
      reason: 'first food',
    });
    expect(created.file).toBe('items/apple.json');
    expect(json(dir, 'items/apple.json')).toEqual({ name: 'Apple', category: 'food', tags: ['fruit', 'sweet'], props: { satiety: 20 }, icon: '🍎', price: 3 });
    await ok('create_item', { id: 'ball', item: { name: 'Ball', category: 'toy', tags: ['active'], consumable: false } });

    const all = await ok<{ count: number; categories: string[]; items: { id: string; consumable: boolean }[] }>('list_items', {});
    expect(all.count).toBe(2);
    expect(all.categories).toEqual(['food', 'toy']);
    expect(all.items.find((i) => i.id === 'apple')!.consumable).toBe(true); // defaults filled in
    expect((await ok<{ items: { id: string }[] }>('list_items', { tag: 'sweet' })).items.map((i) => i.id)).toEqual(['apple']);

    await ok('modify_item', { id: 'apple', patch: { tags: ['fruit', 'sour'], props: { satiety: 25 } } });
    expect(json(dir, 'items/apple.json')).toMatchObject({ tags: ['fruit', 'sour'], props: { satiety: 25 } });

    // The run gets the catalog (expressions read it).
    await ok('run_game');
    const r = await ok<{ passed: boolean }>('run_test', { steps: [], assertions: ["item('apple').props.satiety == 25", "item('nope') == null"] });
    expect(r.passed).toBe(true);

    const dup = await fail('create_item', { id: 'apple', item: { name: 'Apple', category: 'food' } });
    expect(dup.error).toMatch(/already exists/);
    const bad = await fail('create_item', { id: 'cake', item: { name: 'Cake', category: 'food', bonus: 10 } });
    expect(bad.details?.join(' ')).toMatch(/bonus/);
    const badPatch = await fail('modify_item', { id: 'apple', patch: { price: -1 } });
    expect(badPatch.details?.[0]).toMatch(/items\.apple\.price/);
    expect(json(dir, 'items/apple.json').price).toBe(3);

    await ok('delete_item', { id: 'ball' });
    expect((await ok<{ count: number }>('list_items', {})).count).toBe(1);
    expect((await fail('delete_item', { id: 'ball' })).error).toMatch(/does not exist/);
  });
});
