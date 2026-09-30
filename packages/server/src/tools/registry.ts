import { z } from 'zod';
import { formatIssues } from '@vibe/shared';
import type { Author } from '../history';
import { ToolError, type ChangeMeta, type ProjectStore } from '../project-store';

export interface ToolContext {
  store: ProjectStore;
  author: Author;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  /** Mutating tools get an optional `reason` parameter that is recorded in the history. */
  mutates?: boolean;
  run(ctx: ToolContext, input: z.output<S>, meta: (summary: string) => ChangeMeta): unknown;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string; details?: string[] };

/** Tool definition in the shape the Claude Messages API expects. */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

const REASON = z.string().optional().describe('Why this change is made (recorded in the project history).');

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  constructor(defs: ToolDef[]) {
    for (const d of defs) {
      if (this.tools.has(d.name)) throw new Error(`Duplicate tool "${d.name}"`);
      this.tools.set(d.name, d.mutates ? { ...d, input: d.input.extend({ reason: REASON }) } : d);
    }
  }

  names() {
    return [...this.tools.keys()];
  }

  has(name: string) {
    return this.tools.has(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => {
      const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
      return { name: t.name, description: t.description, input_schema: schema };
    });
  }

  /** Never throws: invalid input, tool errors and crashes all come back as `{ ok: false }`. */
  call(name: string, input: unknown, ctx: ToolContext): ToolResult {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool "${name}". Available: ${this.names().join(', ')}` };
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, error: `Invalid input for ${name}`, details: formatIssues(parsed.error, input) };
    const data = parsed.data as { reason?: string };
    const meta = (summary: string): ChangeMeta => ({ author: ctx.author, tool: name, reason: data.reason, summary });
    try {
      return { ok: true, result: tool.run(ctx, parsed.data, meta) };
    } catch (err) {
      if (err instanceof ToolError) return { ok: false, error: err.message, ...(err.details.length && { details: err.details }) };
      return { ok: false, error: `Internal error in ${name}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
