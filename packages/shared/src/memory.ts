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

export const ProjectMemorySchema = z.strictObject({
  version: z.literal(1).default(1),
  summary: z.string().default('').describe('What the game is, in a few sentences.'),
  items: z.array(MemoryItemSchema).default(() => []),
});

export type MemoryItem = z.output<typeof MemoryItemSchema>;
export type ProjectMemory = z.output<typeof ProjectMemorySchema>;

export const MEMORY_FILE = '.vibe/memory.json';
