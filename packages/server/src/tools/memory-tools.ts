import { MEMORY_KINDS, MEMORY_STATUSES, type MemoryItem, type ProjectMemory } from '@vibe/shared';
import { z } from 'zod';
import { ToolError, type ProjectStore } from '../project-store';
import { defineTool } from './registry';

const Kind = z.enum(MEMORY_KINDS);
const Status = z.enum(MEMORY_STATUSES);

const ID_PREFIX: Record<MemoryItem['kind'], string> = { feature: 'f', todo: 't', issue: 'i', note: 'n' };

function nextId(memory: ProjectMemory, kind: MemoryItem['kind']) {
  const prefix = ID_PREFIX[kind];
  const used = new Set(memory.items.map((i) => i.id));
  let n = memory.items.filter((i) => i.kind === kind).length + 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Memory grouped for reading: open work first, so it is what the agent sees. */
export function memoryView(memory: ProjectMemory) {
  const pick = (kind: MemoryItem['kind']) =>
    memory.items
      .filter((i) => i.kind === kind)
      .map(({ kind: _kind, updatedAt: _at, ...rest }) => rest);
  return { summary: memory.summary, features: pick('feature'), todos: pick('todo'), issues: pick('issue'), notes: pick('note') };
}

/** One line per open item, for the project summary. */
export function openMemoryItems(store: ProjectStore): string[] | { error: string } {
  try {
    return store
      .readMemory()
      .items.filter((i) => i.status === 'open' && i.kind !== 'note')
      .map((i) => `${i.id} [${i.kind}] ${i.text}`);
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export const memoryTools = [
  defineTool({
    name: 'read_memory',
    description:
      'Project memory kept across conversations: game summary, features (open/done/verified, with evidence), todos, known issues and notes, plus the scenes, assets and latest changes. Read it when you start working on a project.',
    input: z.object({}),
    run: ({ store }) => {
      const memory = store.readMemory();
      const project = store.validate().project;
      return {
        ...memoryView(memory),
        project: project && {
          scenes: Object.values(project.scenes).map((s) => ({ id: s.id, entities: s.entities.length })),
          assets: project.config.assets.map((a) => `${a.id} (${a.type})`),
        },
        recentChanges: store.history
          .all()
          .slice(-5)
          .map((e) => ({ seq: e.seq, author: e.author, summary: e.summary, ...(e.reason && { reason: e.reason }) })),
      };
    },
  }),

  defineTool({
    name: 'update_memory',
    writesMeta: true,
    description:
      'Updates the project memory. upsert adds items (id is generated: f1, t1, i1, n1...) or changes existing ones by id; remove deletes by id. Record features you planned, mark them done when implemented and verified (with evidence) after testing; record todos, known issues and decisions.',
    input: z.object({
      summary: z.string().optional().describe('Replaces the game summary.'),
      upsert: z
        .array(
          z.object({
            id: z.string().min(1).optional().describe('Existing item to change; omit to create a new item.'),
            kind: Kind.optional().describe('Required when creating.'),
            text: z.string().min(1).optional().describe('Required when creating.'),
            status: Status.optional(),
            evidence: z.string().optional(),
          }),
        )
        .default([]),
      remove: z.array(z.string()).default([]),
    }),
    run: ({ store }, { summary, upsert, remove }) => {
      const memory = store.readMemory();
      const missing = remove.filter((id) => !memory.items.some((i) => i.id === id));
      if (missing.length) throw new ToolError(`No memory item with id ${missing.join(', ')}`);
      memory.items = memory.items.filter((i) => !remove.includes(i.id));
      if (summary !== undefined) memory.summary = summary;

      const now = store.now();
      const created: string[] = [];
      upsert.forEach((u, n) => {
        const existing = u.id ? memory.items.find((i) => i.id === u.id) : undefined;
        if (existing) {
          Object.assign(existing, Object.fromEntries(Object.entries(u).filter(([k, v]) => k !== 'id' && v !== undefined)), { updatedAt: now });
          return;
        }
        if (!u.kind || !u.text) {
          throw new ToolError(u.id ? `upsert[${n}]: no item "${u.id}"; to create it, give kind and text` : `upsert[${n}]: kind and text are required to create an item`);
        }
        const id = u.id ?? nextId(memory, u.kind);
        memory.items.push({ id, kind: u.kind, text: u.text, status: u.status ?? 'open', ...(u.evidence && { evidence: u.evidence }), updatedAt: now });
        created.push(id);
      });
      store.writeMemory(memory);
      const count = (status: string) => memory.items.filter((i) => i.kind !== 'note' && i.status === status).length;
      return { ...(created.length && { created }), open: count('open'), done: count('done'), verified: count('verified') };
    },
  }),
];
