import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

describe('MCP server launched from .mcp.json (as Claude Code does)', () => {
  it('starts, plays, returns a screenshot image and shuts down cleanly', async () => {
    const config = JSON.parse(readFileSync(join(REPO, '.mcp.json'), 'utf8')).mcpServers.vibe as { command: string; args: string[] };
    const root = mkdtempSync(join(tmpdir(), 'vibe-stdio-'));
    cpSync(join(REPO, 'test-fixtures', 'demo-platformer'), join(root, 'demo-platformer'), { recursive: true, filter: (s) => !s.includes('.vibe') });

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: REPO,
      env: { ...(process.env as Record<string, string>), VIBE_PROJECTS_DIR: root },
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (d) => (stderr += d));
    const client = new Client({ name: 'e2e', version: '1' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBe(57);

      await client.callTool({ name: 'run_game', arguments: {} });
      await client.callTool({ name: 'perform_inputs', arguments: { steps: [{ type: 'hold', key: 'D', ms: 1500 }, { type: 'tap', key: 'Space' }] } });
      const shot = (await client.callTool({ name: 'take_screenshot', arguments: { annotate: true } })) as CallToolResult;
      expect(shot.isError).toBeFalsy();
      const image = shot.content.find((c) => c.type === 'image') as { data: string; mimeType: string };
      expect(image.mimeType).toBe('image/png');
      expect(Buffer.from(image.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
      expect(stderr).toContain('[vibe] MCP server ready');
    } finally {
      await client.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
