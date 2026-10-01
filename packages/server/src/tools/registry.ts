import { z } from 'zod';
import { formatIssues } from '@vibe/shared';
import type { Author } from '../history';
import { ToolError, type ChangeMeta, type ProjectStore } from '../project-store';
import type { RuntimeHost } from '../runtime/host';

export interface ToolContext {
  store: ProjectStore;
  author: Author;
  /** Needed by runtime tools (run_game, wait, take_screenshot...). */
  host?: RuntimeHost;
}

export interface ToolImage {
  /** Absolute path of the image file. */
  path: string;
  mediaType: 'image/png';
}

/** Return this from a tool to attach images (e.g. screenshots) to its JSON result. */
export class WithImages {
  constructor(
    readonly result: unknown,
    readonly images: ToolImage[],
  ) {}
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  input: S;
  /** Mutating tools get an optional `reason` parameter that is recorded in the history. */
  mutates?: boolean;
  /** Changes the state of the current game run (not the project files). */
  changesRun?: boolean;
  /** Writes platform data that is not in the undo history (e.g. the project memory). */
  writesMeta?: boolean;
  /** Deletes or may overwrite data (reported to MCP clients as destructiveHint). */
  destructive?: boolean;
  run(ctx: ToolContext, input: z.output<S>, meta: (summary: string) => ChangeMeta): unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export type ToolResult = { ok: true; result: unknown; images?: ToolImage[] } | { ok: false; error: string; details?: string[] };

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

  /** Behavior hints for MCP clients. Only editing tools change files; runtime tools only change the current run. */
  annotations(name: string) {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return { readOnlyHint: !tool.mutates && !tool.changesRun && !tool.writesMeta, destructiveHint: !!tool.destructive };
  }

  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => {
      const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
      return { name: t.name, description: t.description, input_schema: schema };
    });
  }

  /** Never throws: invalid input, tool errors and crashes all come back as `{ ok: false }`. */
  async call(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool "${name}". Available: ${this.names().join(', ')}` };
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) return { ok: false, error: `Invalid input for ${name}`, details: formatIssues(parsed.error, input) };
    const data = parsed.data as { reason?: string };
    const meta = (summary: string): ChangeMeta => ({ author: ctx.author, tool: name, reason: data.reason, summary });
    try {
      const out = await tool.run(ctx, parsed.data, meta);
      return out instanceof WithImages ? { ok: true, result: out.result, images: out.images } : { ok: true, result: out };
    } catch (err) {
      if (err instanceof ToolError) return { ok: false, error: err.message, ...(err.details.length && { details: err.details }) };
      return { ok: false, error: `Internal error in ${name}: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      // Even a failed action (e.g. a wait_until timeout) may have advanced the run.
      if (tool.changesRun) ctx.host?.publishLive();
    }
  }
}
