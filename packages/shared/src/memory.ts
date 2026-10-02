import { z } from 'zod';

/**
 * Project memory: what the agent knows about the project beyond its data files — the goal,
 * features (planned, done, verified), pending tasks, known issues and notes. It lets a new
 * conversation pick up where the last one stopped instead of relying on chat history.
 * Stored in `.vibe/memory.json`; scenes, entities, assets and recent changes are derived
 * from the project itself when the memory is read.
 */
export const MEMORY_KINDS = ['feature', 'todo', 'issue', 'note'] as const;
export const MEMORY_STATUSES = ['open', 'done', 'verified'] as const;

export const MemoryItemSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(MEMORY_KINDS).describe('feature: something the game does; todo: pending work; issue: known bug; note: decision or fact.'),
  text: z.string().min(1),
  status: z
    .enum(MEMORY_STATUSES)
    .default('open')
    .describe('open: not done (or not fixed); done: implemented/fixed; verified: done and checked by a test or play session.'),
  evidence: z.string().optional().describe('How it was verified, e.g. the run_test assertions or what a screenshot showed.'),
  updatedAt: z.string(),
});

/**
 * Plans (V0.6, agent planning): operational memory for complex work — a goal, the tasks towards
 * it in order, and how it is verified (saved playbooks). The agent does the reasoning; the plan
 * only keeps track of it, so work survives the end of a conversation and ends with a check.
 */
export const PLAN_STATUSES = ['active', 'done', 'verified', 'abandoned'] as const;
export const PLAN_TASK_STATUSES = ['todo', 'doing', 'done', 'blocked'] as const;

export const PlanTaskSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(PLAN_TASK_STATUSES).default('todo'),
  note: z.string().optional().describe('Why it is blocked, what is left, a decision...'),
  evidence: z.string().optional().describe('How it was checked (a run_test, what a screenshot showed...).'),
  updatedAt: z.string(),
});

export const PlanResultSchema = z.strictObject({
  passed: z.boolean(),
  summary: z.string(),
  at: z.string(),
  failures: z.array(z.string()).optional(),
});

export const PlanSchema = z.strictObject({
  id: z.string().min(1),
  goal: z.string().min(1),
  status: z
    .enum(PLAN_STATUSES)
    .default('active')
    .describe('active: in progress; done: every task done (not verified yet); verified: tasks done and its playbooks pass; abandoned.'),
  tasks: z.array(PlanTaskSchema).default(() => []),
  verifyWith: z.array(z.string()).default(() => []).describe('Ids of the saved playbooks that prove the goal is reached.'),
  result: PlanResultSchema.optional().describe('Last verification.'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ProjectMemorySchema = z.strictObject({
  version: z.literal(1).default(1),
  summary: z.string().default('').describe('What the game is, in a few sentences.'),
  items: z.array(MemoryItemSchema).default(() => []),
  plans: z.array(PlanSchema).default(() => []),
});

export type MemoryItem = z.output<typeof MemoryItemSchema>;
export type ProjectMemory = z.output<typeof ProjectMemorySchema>;
export type Plan = z.output<typeof PlanSchema>;
export type PlanTask = z.output<typeof PlanTaskSchema>;

export const MEMORY_FILE = '.vibe/memory.json';
