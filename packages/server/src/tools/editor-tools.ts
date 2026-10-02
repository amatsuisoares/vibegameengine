import { z } from 'zod';
import { EDITOR_SELECTION_FILE, EditorSelectionSchema } from '@vibe/shared';
import { ToolError } from '../project-store';
import { defineTool } from './registry';
import { gameObjectOf } from './scene-tools';

/**
 * Tools about the editor panels of the runtime page (V0.5): what the user is looking at, so
 * "make this bigger" can be resolved without asking. Read-only: the panels are the user's.
 */
export const editorTools = [
  defineTool({
    name: 'get_selection',
    description:
      'What the user selected in the hierarchy panel of the game page: the scene and the entity (null = nothing / the scene itself), with the entity data (raw + effective, like get_game_object) and, when your run is in that scene, its live snapshot. Use it when the user says "this", "the selected one", "isso", "esse".',
    input: z.object({}),
    run: ({ store, host }) => {
      const text = store.readText(EDITOR_SELECTION_FILE);
      if (text === null) return { selection: null, note: 'Nothing selected: the user has not picked anything in the hierarchy panel.' };
      let parsed;
      try {
        parsed = EditorSelectionSchema.safeParse(JSON.parse(text));
      } catch {
        parsed = null;
      }
      if (!parsed?.success) return { selection: null, note: `${EDITOR_SELECTION_FILE} is unreadable; ask the user to select again.` };
      const selection = parsed.data;
      const result: Record<string, unknown> = {
        selection: { scene: selection.scene, entity: selection.entity, ...(selection.at !== undefined && { selectedAt: new Date(selection.at).toISOString() }) },
      };
      if (!store.snapshot().scenes.some((s) => s.id === selection.scene)) {
        return { ...result, note: `Scene "${selection.scene}" no longer exists (the selection is outdated).` };
      }
      if (!selection.entity) return result;
      try {
        Object.assign(result, gameObjectOf(store, selection.scene, selection.entity));
      } catch (err) {
        // Selected while the game ran: it may be an entity spawned at runtime (not in the scene file).
        if (!(err instanceof ToolError)) throw err;
        result.note = `Entity "${selection.entity}" is not in the scene file of "${selection.scene}" (spawned while the game ran, or deleted since).`;
      }
      const game = host?.session?.game;
      if (game && game.world.scene.id === selection.scene) {
        const snapshot = game.getState({ ids: [selection.entity] }).entities[0];
        if (snapshot) result.inYourRun = snapshot;
      }
      return result;
    },
  }),
];
