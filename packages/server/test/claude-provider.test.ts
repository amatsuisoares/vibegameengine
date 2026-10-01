import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeProvider } from '../src';

/** A fetch stand-in that records the request and streams back a minimal tool-use message. */
function fakeFetch() {
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_scene', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"scene":"level1"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const sse = events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, seen };
}

describe('ClaudeProvider', () => {
  it('sends a streaming request with the agent settings and parses the reply', async () => {
    const f = fakeFetch();
    const client = new Anthropic({ apiKey: 'test-key', fetch: f.fetch as typeof globalThis.fetch, maxRetries: 0 });
    const provider = new ClaudeProvider({ client });
    let streamed = '';
    const msg = await provider.complete(
      {
        system: 'You build games.',
        messages: [{ role: 'user', content: 'Add a coin' }],
        tools: [{ name: 'get_scene', description: 'Scene settings', input_schema: { type: 'object', properties: { scene: { type: 'string' } } } }],
      },
      { onText: (d) => (streamed += d) },
    );

    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content[1]).toMatchObject({ type: 'tool_use', name: 'get_scene', input: { scene: 'level1' } });
    expect(streamed).toBe('Checking.');

    const { url, headers, body } = f.seen[0];
    expect(url).toContain('/v1/messages');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      stream: true,
      system: 'You build games.',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default',
    });
    expect((body.tools as { eager_input_streaming?: boolean }[])[0].eager_input_streaming).toBe(true);
  });

  it('can disable fallbacks and change model and effort', async () => {
    const f = fakeFetch();
    const client = new Anthropic({ apiKey: 'test-key', fetch: f.fetch as typeof globalThis.fetch, maxRetries: 0 });
    await new ClaudeProvider({ client, model: 'claude-sonnet-5-5', effort: 'medium', fallbacks: false }).complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    const { headers, body } = f.seen[0];
    expect(body.model).toBe('claude-sonnet-5-5');
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body).not.toHaveProperty('fallbacks');
    expect(headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
  });
});
