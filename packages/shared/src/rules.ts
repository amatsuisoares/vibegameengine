import { z } from 'zod';

/**
 * Scene rules: data-driven events and conditions ("when X, if Y, do Z") for game logic that
 * does not need a script — doors that open with enough coins, zones that show a message,
 * timers, chained events. Evaluated by the engine every frame, after the built-in systems.
 */

const Value = z.union([z.number(), z.string(), z.boolean()]);
const Expr = z.string().min(1);
/**
 * Entity id, "$by" for the entity that entered the zone / caused the event that fired the rule, or
 * "$entity" for the zone / the event's "entity" (e.g. the interactable of an "interact" event).
 */
const Target = z
  .string()
  .min(1)
  .describe('Entity id, "$by" (the entity that entered the zone, or the "by"/"entity" of the event) or "$entity" (the zone, or the "entity" of the event).');

export const RuleTriggerSchema = z.union([
  z.strictObject({ start: z.literal(true).describe('Once, when the scene starts.') }),
  z.strictObject({
    event: z.string().min(1).describe('Gameplay or custom event type, e.g. "collect", "stomp", "death" or one emitted by a script/rule.'),
    match: z.record(z.string(), Value).optional().describe('Event fields that must match, e.g. {"entity": "coin1"}.'),
  }),
  z.strictObject({
    enter: z.string().min(1).describe('Id of a zone entity (usually a trigger collider): fires when something starts touching it.'),
    tag: z.string().default('player').describe('Only entities with this tag.'),
  }),
  z.strictObject({ expr: Expr.describe('Fires when this expression becomes true (false -> true).') }),
  z.strictObject({ every: z.number().positive().describe('Fires every N milliseconds of game time.') }),
]);

/** Actions that run at once (also the ones an "after" action can delay). */
const immediateActions = [
  z.strictObject({ action: z.literal('setVar'), var: z.string().min(1), value: Value }),
  z.strictObject({ action: z.literal('addVar'), var: z.string().min(1), amount: z.number() }),
  z.strictObject({ action: z.literal('emit'), event: z.string().min(1), data: z.record(z.string(), Value).optional() }),
  z.strictObject({ action: z.literal('win') }),
  z.strictObject({ action: z.literal('lose') }),
  z.strictObject({ action: z.literal('loadScene'), scene: z.string().min(1) }),
  z.strictObject({ action: z.literal('destroy'), target: Target }),
  z.strictObject({ action: z.literal('setEnabled'), target: Target, enabled: z.boolean() }),
  z.strictObject({ action: z.literal('setText'), target: Target, text: z.string() }),
  z.strictObject({ action: z.literal('damage'), target: Target, amount: z.number().positive().default(1) }),
  z.strictObject({ action: z.literal('heal'), target: Target, amount: z.number().positive().default(1) }),
  z.strictObject({ action: z.literal('move'), target: Target, x: z.number().optional(), y: z.number().optional() }),
  z.strictObject({
    action: z.literal('modify'),
    target: Target,
    component: z.string().min(1),
    set: z.record(z.string(), z.unknown()).describe('Fields to set on the component (shallow).'),
  }),
  z.strictObject({ action: z.literal('log'), message: z.string() }),
  z.strictObject({ action: z.literal('playSound'), asset: z.string().min(1), volume: z.number().min(0).max(1).default(1) }),
  z.strictObject({
    action: z.literal('spawn'),
    prefab: z.string().min(1),
    x: z.number().optional().describe('World x (or offset from "at").'),
    y: z.number().optional().describe('World y (or offset from "at").'),
    at: Target.optional().describe('Spawn at this entity\'s position (x/y become offsets).'),
    id: z.string().optional().describe('Id of the new entity (default: <prefab><n>).'),
  }),
] as const;

export const ImmediateActionSchema = z.discriminatedUnion('action', [...immediateActions]);

const TimerId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'must start with a letter and contain only letters, digits, "_" or "-"');

export const RuleActionSchema = z.discriminatedUnion('action', [
  ...immediateActions,
  z.strictObject({
    action: z.literal('after'),
    ms: z.number().min(0).describe('Delay in ms of game time.'),
    do: z.array(ImmediateActionSchema).min(1).describe('Actions run after the delay (not another "after").'),
    id: TimerId.optional().describe('Timer id: scheduling the same id again restarts it; cancelTimer stops it.'),
  }),
  z.strictObject({ action: z.literal('cancelTimer'), id: TimerId }),
]);

export const RuleSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'must start with a letter and contain only letters, digits, "_" or "-"'),
  when: RuleTriggerSchema,
  if: Expr.optional().describe('Extra condition checked when the trigger fires (same expressions as wait_until).'),
  do: z.array(RuleActionSchema).min(1),
  once: z.boolean().default(false).describe('Fire at most once per scene load.'),
  enabled: z.boolean().default(true),
});

export type RuleTrigger = z.output<typeof RuleTriggerSchema>;
export type RuleAction = z.output<typeof RuleActionSchema>;
export type Rule = z.output<typeof RuleSchema>;
export type RuleInput = z.input<typeof RuleSchema>;
