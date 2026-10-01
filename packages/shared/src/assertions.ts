import { z } from 'zod';

/**
 * Structured gameplay assertions: checks over the engine's structured state (entities, components,
 * state machines, variables, events, scene, game status) with no code or expressions. Used by
 * verify_game (and saved playbooks); evaluated by the engine (`checkAssertion`).
 */

const Id = z.string().min(1).describe('Entity id.');
const Value = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** Comparisons on a value; none = the value must be present (not null). */
const Compare = {
  equals: Value.optional(),
  notEquals: Value.optional(),
  gt: z.number().optional(),
  gte: z.number().optional(),
  lt: z.number().optional(),
  lte: z.number().optional(),
};
export const COMPARE_OPS = ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte'] as const;

const Name = z.string().min(1).max(120).optional().describe('What this checks, in plain words (shown in the report).');
const Path = z.string().min(1).describe('Dotted path, e.g. "health", "interactable.uses", "ai.choice", "props.fome".');

export const AssertionSchema = z.discriminatedUnion('assert', [
  z.object({ assert: z.literal('entityExists'), id: Id, exists: z.boolean().default(true).describe('false = the entity must not exist.'), name: Name }),
  z
    .object({
      assert: z.literal('entityAt'),
      id: Id,
      x: z.number().optional(),
      y: z.number().optional(),
      tolerance: z.number().min(0).default(4).describe('Pixels (default 4).'),
      name: Name,
    })
    .refine((a) => a.x !== undefined || a.y !== undefined, 'entityAt needs x and/or y'),
  z.object({
    assert: z.literal('entityNear'),
    id: Id,
    target: Id.describe('The other entity.'),
    within: z.number().min(0).describe('Max distance between centers (px).'),
    name: Name,
  }),
  z.object({ assert: z.literal('entity'), id: Id, field: Path.describe('Field of the entity state (as inspect_game_state shows it).'), ...Compare, name: Name }),
  z.object({
    assert: z.literal('component'),
    id: Id,
    component: z.string().min(1).describe('Component type, e.g. "Health".'),
    field: Path.optional().describe('Field of the component data (omit to check the component is there).'),
    ...Compare,
    name: Name,
  }),
  z.object({ assert: z.literal('state'), id: Id, is: z.string().min(1).describe('StateMachine state.'), name: Name }),
  z.object({ assert: z.literal('variable'), var: z.string().min(1).describe('Scene variable (vars.<var>).'), ...Compare, name: Name }),
  z.object({ assert: z.literal('count'), tag: z.string().min(1).describe('Entities with this tag (no comparison = at least one).'), ...Compare, name: Name }),
  z.object({
    assert: z.literal('eventOccurred'),
    event: z.string().min(1).describe('Event type, e.g. "collect".'),
    match: z.record(z.string(), Value).optional().describe('Fields the event must have, e.g. {"entity": "coin1"}.'),
    ...Compare,
    name: Name,
  }).describe('How many matching events happened (no comparison = at least one; equals 0 = never).'),
  z.object({ assert: z.literal('scene'), is: z.string().min(1), name: Name }),
  z.object({ assert: z.literal('gameWon'), name: Name }),
  z.object({ assert: z.literal('gameLost'), name: Name }),
  z.object({ assert: z.literal('status'), is: z.enum(['running', 'won', 'lost', 'crashed']), name: Name }),
]);

export type Assertion = z.output<typeof AssertionSchema>;
export type AssertionInput = z.input<typeof AssertionSchema>;
export const ASSERTION_KINDS = AssertionSchema.options.map((o) => o.shape.assert.value);
