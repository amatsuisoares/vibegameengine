import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createVibeMcpServer } from './server';
import { Workspace } from './workspace';

// stdout carries the MCP protocol: anything else must go to stderr.
const projectsRoot = process.env.VIBE_PROJECTS_DIR ?? fileURLToPath(new URL('../../../../projects/', import.meta.url));
const workspace = new Workspace(projectsRoot);
const server = createVibeMcpServer(workspace);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  // Closes Chromium and the Vite server started for screenshots.
  await workspace.close().catch((err) => console.error('[vibe] shutdown error:', err));
  process.exit(0);
}

server.onclose = shutdown;
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
console.error(`[vibe] MCP server ready (projects: ${projectsRoot})`);
