import { IdSchema, ItemSchema, mergePatch } from '@vibe/shared';
import { z } from 'zod';
import { ToolError } from '../project-store';
import { defineTool } from './registry';
import { changeInfo } from './scene-tools';

const ItemId = IdSchema.describe('Item id (file items/<id>.json).');
const fileOf = (id: string) => `items/${id}.json`;

export const itemTools = [
  defineTool({
    name: 'list_items',
    description:
      'The item catalog (items/<id>.json): id, name, category, tags, props, price, icon... Filter by category or tag. Items are data: scripts use them with game.items / game.useItem(item, target) and the target reacts in onItem (Preferences: self.prefs.item(item)).',
    input: z.object({ category: z.string().optional(), tag: z.string().optional() }),
    run: ({ store }, { category, tag }) => {
      const status = store.validate();
      if (!status.project) throw new ToolError('The project is invalid; fix it first', status.errors);
      const items = Object.entries(status.project.items)
        .filter(([, i]) => (category === undefined || i.category === category) && (tag === undefined || i.tags.includes(tag)))
        .map(([id, i]) => ({ id, ...i }));
      const categories = [...new Set(Object.values(status.project.items).map((i) => i.category))];
      return { count: items.length, categories, items };
    },
  }),

  defineTool({
    name: 'create_item',
    description:
      'Adds an item to the catalog as items/<id>.json: {name, category, tags, props, price?, icon?, asset?, prefab?, consumable, description?}. Describe what the item IS with tags ("fruit", "sweet", "noisy", "soft") rather than fixed bonuses, so each individual can react to it differently.',
    mutates: true,
    input: z.object({ id: ItemId, item: z.record(z.string(), z.unknown()).describe('Item data (validated with the item schema).') }),
    run: ({ store }, { id, item }, meta) => {
      if (store.readText(fileOf(id)) !== null) throw new ToolError(`Item "${id}" already exists; use modify_item`);
      const parsed = ItemSchema.safeParse(item);
      if (!parsed.success) throw new ToolError('Invalid item', parsed.error.issues.map((i) => `${i.path.join('.') || 'item'}: ${i.message}`));
      const r = store.edit(meta(`Create item ${id}`), (tx) => tx.writeJson(fileOf(id), item));
      return { ...changeInfo(r), file: fileOf(id) };
    },
  }),

  defineTool({
    name: 'modify_item',
    description: 'Changes an item with a merge patch, e.g. {"tags":["fruit","sour"]} (arrays are replaced) or {"props":{"satiety":30}}.',
    mutates: true,
    input: z.object({ id: ItemId, patch: z.record(z.string(), z.unknown()) }),
    run: ({ store }, { id, patch }, meta) =>
      changeInfo(
        store.edit(meta(`Modify item ${id} (${Object.keys(patch).join(', ')})`), (tx) => {
          if (tx.read(fileOf(id)) === null) throw new ToolError(`Item "${id}" does not exist`);
          tx.writeJson(fileOf(id), mergePatch(tx.readJson(fileOf(id)), patch));
        }),
      ),
  }),

  defineTool({
    name: 'delete_item',
    description: 'Removes an item from the catalog. Scripts that still use its id will fail at runtime (game.items.get returns null).',
    mutates: true,
    destructive: true,
    input: z.object({ id: ItemId }),
    run: ({ store }, { id }, meta) => {
      if (store.readText(fileOf(id)) === null) throw new ToolError(`Item "${id}" does not exist`);
      return changeInfo(store.edit(meta(`Delete item ${id}`), (tx) => tx.delete(fileOf(id))));
    },
  }),
];

