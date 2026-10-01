import { IdSchema, isPlainObject, mergePatch } from '@vibe/shared';
import { z } from 'zod';
import { ToolError } from '../project-store';
import { defineTool } from './registry';
import { changeInfo } from './scene-tools';

type Raw = Record<string, unknown>;

const PrefabId = IdSchema.describe('Prefab id (file prefabs/<id>.json).');
const fileOf = (id: string) => `prefabs/${id}.json`;

export const prefabTools = [
  defineTool({
    name: 'create_prefab',
    description:
      'Creates a reusable entity template prefabs/<id>.json, from `entity` data (an entity without id) or copied from an existing entity (`from`). With from + link=true that entity becomes an instance. Instances: create_game_object with {"id","prefab":"<id>","transform":{...}} — they store only what differs, and editing the prefab changes them all. Rules (spawn action) and scripts (game.spawn) create prefabs at runtime.',
    mutates: true,
    input: z.object({
      id: PrefabId,
      entity: z.record(z.string(), z.unknown()).optional().describe('Template: tags, components, transform (scale/rotation)... without id.'),
      from: z.object({ scene: z.string(), id: z.string() }).optional().describe('Copy an existing entity (its position is not kept).'),
      link: z.boolean().default(false).describe('With `from`: turn that entity into an instance of the new prefab.'),
    }),
    run: ({ store }, { id, entity, from, link }, meta) => {
      if (!entity === !from) throw new ToolError('Give either entity or from');
      if (store.readText(fileOf(id)) !== null) throw new ToolError(`Prefab "${id}" already exists; use modify_prefab`);
      const r = store.edit(meta(`Create prefab ${id}${from ? ` from ${from.scene}/${from.id}` : ''}`), (tx) => {
        let template: Raw;
        if (from) {
          const scene = tx.scene(from.scene);
          const list = Array.isArray(scene.entities) ? (scene.entities as Raw[]) : [];
          const i = list.findIndex((e) => e.id === from.id);
          if (i < 0) throw new ToolError(`Entity "${from.id}" does not exist in scene "${from.scene}"`);
          const { id: _id, prefab: _p, ...rest } = structuredClone(list[i]);
          template = rest;
          const t = isPlainObject(template.transform) ? { ...template.transform } : {};
          delete t.x;
          delete t.y;
          if (Object.keys(t).length) template.transform = t;
          else delete template.transform;
          if (link) {
            const pos = isPlainObject(list[i].transform) ? list[i].transform : {};
            list[i] = { id: from.id, prefab: id, transform: { x: pos.x ?? 0, y: pos.y ?? 0 } };
            tx.setScene(from.scene, scene);
          }
        } else {
          if ('id' in entity!) throw new ToolError('A prefab has no id: instances get their own');
          template = entity!;
        }
        tx.writeJson(fileOf(id), template);
      });
      return { ...changeInfo(r), file: fileOf(id) };
    },
  }),

  defineTool({
    name: 'modify_prefab',
    description: 'Changes a prefab with a merge patch (e.g. {"components":{"Patrol":{"speed":90}}}). Every instance follows, except fields the instance overrides.',
    mutates: true,
    input: z.object({ id: PrefabId, patch: z.record(z.string(), z.unknown()) }),
    run: ({ store }, { id, patch }, meta) => {
      if ('id' in patch) throw new ToolError('A prefab has no id');
      return changeInfo(
        store.edit(meta(`Modify prefab ${id} (${Object.keys(patch).join(', ')})`), (tx) => {
          const current = tx.read(fileOf(id));
          if (current === null) throw new ToolError(`Prefab "${id}" does not exist`);
          tx.writeJson(fileOf(id), mergePatch(tx.readJson(fileOf(id)), patch));
        }),
      );
    },
  }),

  defineTool({
    name: 'delete_prefab',
    description: 'Deletes a prefab. Fails while instances or spawn rules still use it.',
    mutates: true,
    destructive: true,
    input: z.object({ id: PrefabId }),
    run: ({ store }, { id }, meta) => {
      if (store.readText(fileOf(id)) === null) throw new ToolError(`Prefab "${id}" does not exist`);
      return changeInfo(store.edit(meta(`Delete prefab ${id}`), (tx) => tx.delete(fileOf(id))));
    },
  }),
];
