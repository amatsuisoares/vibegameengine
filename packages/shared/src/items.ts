import { z } from 'zod';

/**
 * Items: the catalog of things a game has (foods, toys, furniture, keys, potions...), one file per
 * item in `items/<id>.json`. An item is data, not an entity: what it does is up to the game. Tags
 * and properties describe it, so systems react to *what it is* (a "sweet, fresh fruit") instead
 * of a fixed bonus — Preferences evaluate an item by its id, category and tags.
 */
export const ITEM_DIR = 'items';
export const ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const ItemPropSchema = z.union([z.number(), z.string(), z.boolean()]);

export const ItemSchema = z.strictObject({
  name: z.string().min(1).describe('Display name, e.g. "Maçã".'),
  category: z.string().min(1).describe('Kind of item, e.g. "food", "toy", "furniture". Also counts as a tag when evaluating preferences.'),
  tags: z.array(z.string().min(1)).default(() => []).describe('What it is like, e.g. ["fruit", "sweet", "fresh"]. Preferences react to these.'),
  props: z
    .record(z.string(), ItemPropSchema)
    .default(() => ({}))
    .describe('Game-defined properties, e.g. {"satiety": 25, "texture": "crunchy"}. The engine does not interpret them.'),
  description: z.string().optional(),
  icon: z.string().optional().describe('Glyph or emoji for menus, e.g. "🍎".'),
  asset: z.string().optional().describe('Image asset id for menus.'),
  prefab: z.string().optional().describe('Prefab that represents the item in the world (placed or dropped).'),
  price: z.number().int().min(0).optional().describe('Price in the game currency (shops).'),
  consumable: z.boolean().default(true).describe('Used up when used (food, potion) vs kept (toy, furniture).'),
});

export type Item = z.output<typeof ItemSchema>;
export type ItemInput = z.input<typeof ItemSchema>;
