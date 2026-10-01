import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { formatIssues } from '@vibe/shared';
import { ToolError } from '../project-store';
import { createAgentTools, type ToolResult } from '../tools';
import { VIBE_INSTRUCTIONS } from './guide';
import type { Workspace } from './workspace';

const ProjectName = z.string().describe('Project folder name under projects/.');

/** Tools that choose the project; every other tool works on the open project. */
const WORKSPACE_TOOLS = {
  list_projects: {
    description: 'Lists the projects in projects/ and which one is open.',
    input: z.object({}),
  },
  open_project: {
    description: 'Opens a project; the following tools work on it. Ends the current game run.',
    input: z.object({ name: ProjectName }),
  },
  create_project: {
    description: 'Creates a new project with an empty "main" scene and opens it.',
    input: z.object({
      name: ProjectName,
      title: z.string().optional().describe('Display name (default: name).'),
      width: z.number().int().positive().optional().describe('Viewport width (default 800).'),
      height: z.number().int().positive().optional().describe('Viewport height (default 450).'),
      sceneWidth: z.number().positive().optional().describe('World width of the main scene (default: viewport width).'),
      sceneHeight: z.number().positive().optional().describe('World height of the main scene (default: viewport height).'),
    }),
  },
} as const;

type WorkspaceToolName = keyof typeof WORKSPACE_TOOLS;

function jsonSchema(schema: z.ZodObject) {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return rest as Tool['inputSchema'];
}

/** Renders a tool result for the model: compact JSON, with diffs as readable text and images as image content. */
export function toMcpResult(r: ToolResult): CallToolResult {
  if (!r.ok) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: r.error, ...(r.details && { details: r.details }) }) }] };
  }
  let text: string;
  const result = r.result as Record<string, unknown> | undefined;
  if (result && typeof result === 'object' && !Array.isArray(result) && typeof result.diff === 'string') {
    const { diff, ...rest } = result;
    text = `${JSON.stringify(rest)}\n${diff}`;
  } else {
    text = JSON.stringify(r.result ?? null);
  }
  return {
    content: [
      { type: 'text', text },
      ...(r.images ?? []).map((img) => ({ type: 'image' as const, data: readFileSync(img.path).toString('base64'), mimeType: img.mediaType })),
    ],
  };
}

/** The MCP server that lets Claude Code (or any MCP client) act as the game developer agent. */
export function createVibeMcpServer(workspace: Workspace): Server {
  const tools = createAgentTools();
  const server = new Server({ name: 'vibe', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: VIBE_INSTRUCTIONS });

  const definitions: Tool[] = [
    ...Object.entries(WORKSPACE_TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: jsonSchema(t.input),
      annotations: { readOnlyHint: name === 'list_projects', destructiveHint: false },
    })),
    ...tools.definitions().map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.input_schema as Tool['inputSchema'],
      annotations: tools.annotations(d.name),
    })),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name in WORKSPACE_TOOLS) return toMcpResult(runWorkspaceTool(workspace, name as WorkspaceToolName, args));
    let project;
    try {
      project = workspace.require();
    } catch (err) {
      return toMcpResult({ ok: false, error: (err as Error).message });
    }
    return toMcpResult(await tools.call(name, args, { store: project.store, host: project.host, author: 'agent' }));
  });

  return server;
}

function runWorkspaceTool(workspace: Workspace, name: WorkspaceToolName, args: unknown): ToolResult {
  const parsed = WORKSPACE_TOOLS[name].input.safeParse(args);
  if (!parsed.success) return { ok: false, error: `Invalid input for ${name}`, details: formatIssues(parsed.error, args) };
  try {
    switch (name) {
      case 'list_projects':
        return { ok: true, result: workspace.list() };
      case 'open_project': {
        const { store } = workspace.open((parsed.data as { name: string }).name);
        const status = store.validate();
        return { ok: true, result: { opened: store.name, valid: status.ok, ...(status.errors.length && { errors: status.errors }) } };
      }
      case 'create_project': {
        const { name: projectName, ...options } = parsed.data as z.output<(typeof WORKSPACE_TOOLS)['create_project']['input']>;
        const { store } = workspace.create(projectName, options);
        return { ok: true, result: { created: store.name, files: ['project.json', 'scenes/main.json', 'assets/'] } };
      }
    }
  } catch (err) {
    if (err instanceof ToolError) return { ok: false, error: err.message, ...(err.details.length && { details: err.details }) };
    return { ok: false, error: `Internal error in ${name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
