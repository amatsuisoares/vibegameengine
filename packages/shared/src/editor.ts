import { z } from 'zod';

/**
 * What the user selected in the editor panels of the runtime page, written to
 * `projects/<name>/.vibe/selection.json` so the agent can resolve "this one" (get_selection).
 * It is editor state, not project data: it never goes into the history.
 */
export const EditorSelectionSchema = z.strictObject({
  version: z.literal(1),
  /** Scene the selected entity belongs to. */
  scene: z.string().min(1).max(200),
  /** Selected entity id (null = the scene itself). */
  entity: z.string().min(1).max(200).nullable(),
  /** When it was selected (ms since epoch, from the page). */
  at: z.number().optional(),
});

export type EditorSelection = z.output<typeof EditorSelectionSchema>;

/** Project-relative path of the editor selection. */
export const EDITOR_SELECTION_FILE = '.vibe/selection.json';
