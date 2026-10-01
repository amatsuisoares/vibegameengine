import { readFileSync, writeFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { defineTool, runAgent, ScriptedProvider, ToolRegistry, WithImages, type AgentEvent, type ScriptedTurn } from '../src';
import { setup } from './helpers';

function agent(turns: ScriptedTurn[], extra: Partial<Parameters<typeof runAgent>[1]> = {}, model?: string) {
  const t = setup();
  const provider = new ScriptedProvider(turns, model);
  const events: AgentEvent[] = [];
  const run = (prompt = 'Add a coin') => runAgent(prompt, { provider, store: t.store, host: t.host, tools: t.tools, onEvent: (e) => events.push(e), ...extra });
  return { ...t, provider, events, run };
}

type Blocks = Anthropic.Beta.BetaContentBlockParam[];
const lastUserBlocks = (p: ScriptedProvider, request: number) => p.requests[request].messages.at(-1)!.content as Blocks;

describe('agent loop', () => {
  it('runs tools, feeds results back and finishes with a report', async () => {
    const a = agent([
      { text: 'Let me look.', toolCalls: [{ name: 'get_project_summary', input: {} }] },
      {
        toolCalls: [
          {
            name: 'create_game_object',
            input: {
              scene: 'level1',
              entity: { id: 'coin4', tags: ['coin'], transform: { x: 250, y: 390 }, components: { Collider: { width: 16, height: 16, isTrigger: true }, Collectible: {} } },
              reason: 'requested coin',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'run_test', input: { steps: [{ type: 'hold', key: 'D', ms: 1500 }], assertions: ['vars.coins >= 1'] } }] },
      { text: 'Added coin4 and verified it can be collected.' },
    ]);
    const r = await a.run();

    expect(r.status).toBe('completed');
    expect(r.finalText).toBe('Added coin4 and verified it can be collected.');
    expect(r.iterations).toBe(4);
    expect(r.toolCalls).toBe(3);
    expect(readFileSync(`${a.dir}/scenes/level1.json`, 'utf8')).toContain('"coin4"');
    expect(a.store.history.all()[0]).toMatchObject({ author: 'agent', tool: 'create_game_object', reason: 'requested coin' });

    // The model saw each tool result, matched to its call.
    const [summary] = lastUserBlocks(a.provider, 1) as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(summary.tool_use_id).toBe('toolu_1_0');
    expect(String(summary.content)).toContain('"level1"');
    const test = JSON.parse(String((lastUserBlocks(a.provider, 3) as Anthropic.Beta.BetaToolResultBlockParam[])[0].content));
    expect(test.passed).toBe(true);
    // System prompt and tools were sent.
    expect(a.provider.requests[0].system).toContain('VibeGameEngine');
    expect(a.provider.requests[0].tools.map((t) => t.name)).toContain('take_screenshot');

    // Every event is in the JSONL log.
    const log = readFileSync(a.store.path(r.logPath), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(log[0]).toMatchObject({ type: 'start', model: 'scripted' });
    expect(log.filter((e) => e.type === 'tool_call')).toHaveLength(3);
    expect(log.at(-1)).toMatchObject({ type: 'done', status: 'completed' });
  });

  it('returns tool errors to the model and keeps going', async () => {
    const a = agent([{ toolCalls: [{ name: 'delete_game_object', input: { scene: 'level1', id: 'ghost' } }] }, { text: 'done' }]);
    const r = await a.run();
    expect(r.status).toBe('completed');
    const [res] = lastUserBlocks(a.provider, 1) as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(res.is_error).toBe(true);
    expect(String(res.content)).toContain('does not exist');
  });

  it('answers parallel tool calls in a single user message, in order', async () => {
    const a = agent([
      { toolCalls: [{ name: 'run_game', input: {} }, { name: 'wait', input: { ms: 500 } }, { name: 'inspect_game_state', input: { ids: ['player'] } }] },
      { text: 'ok' },
    ]);
    await a.run();
    const blocks = lastUserBlocks(a.provider, 1) as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(blocks.map((b) => b.tool_use_id)).toEqual(['toolu_1_0', 'toolu_1_1', 'toolu_1_2']);
    expect(JSON.parse(String(blocks[2].content)).frame).toBe(30);
  });

  it('stops at the iteration limit', async () => {
    const forever: ScriptedTurn = () => ({ toolCalls: [{ name: 'get_scene', input: { scene: 'level1' } }] });
    const a = agent(Array(10).fill(forever), { limits: { maxIterations: 3 } });
    const r = await a.run();
    expect(r).toMatchObject({ status: 'max_iterations', iterations: 3, toolCalls: 3 });
  });

  it('stops when the estimated cost reaches the budget', async () => {
    // 300k output tokens on Opus 5.5 = $6 > $5 default budget.
    const a = agent([{ toolCalls: [{ name: 'get_scene', input: { scene: 'level1' } }], usage: { output_tokens: 300_000 } }, { text: 'never reached' }], {}, 'claude-opus-5-5');
    const r = await a.run();
    expect(r.status).toBe('budget');
    expect(r.costUsd).toBeCloseTo(6);
    expect(r.iterations).toBe(1);
  });

  it('can be aborted between tool calls', async () => {
    const controller = new AbortController();
    const a = agent(
      [{ toolCalls: [{ name: 'run_game', input: {} }, { name: 'wait', input: { ms: 100 } }] }, { text: 'never' }],
      { signal: controller.signal, onEvent: (e) => e.type === 'tool_call' && controller.abort() },
    );
    const r = await a.run();
    expect(r.status).toBe('aborted');
    const blocks = r.messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(blocks.map((b) => b.content)).toEqual(['Not run: the agent was stopped.', 'Not run: the agent was stopped.']);
  });

  it('times out', async () => {
    const slow: ScriptedTurn = () => {
      const until = Date.now() + 30;
      while (Date.now() < until) {
        // burn time synchronously so the timeout fires between requests
      }
      return { toolCalls: [{ name: 'get_scene', input: { scene: 'level1' } }] };
    };
    const a = agent(Array(50).fill(slow), { limits: { timeoutMs: 100 } });
    const r = await a.run();
    expect(r.status).toBe('timeout');
  });

  it('asks before destructive calls and respects a refusal', async () => {
    const asked: string[] = [];
    const a = agent(
      [
        { toolCalls: [{ name: 'delete_game_object', input: { scene: 'level1', id: 'enemy2' } }, { name: 'modify_game_object', input: { scene: 'level1', id: 'enemy1', patch: { name: 'Bob' } } }] },
        { text: 'ok' },
      ],
      { confirm: async ({ name }) => (asked.push(name), false) },
    );
    await a.run();
    expect(asked).toEqual(['delete_game_object']); // non-destructive edits are not asked about
    expect(readFileSync(`${a.dir}/scenes/level1.json`, 'utf8')).toContain('"enemy2"');
    expect(a.events.some((e) => e.type === 'tool_declined')).toBe(true);
    const [declined, modified] = lastUserBlocks(a.provider, 1) as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(declined).toMatchObject({ is_error: true, content: expect.stringContaining('declined') });
    expect(modified.is_error).toBeUndefined();
  });

  it('treats overwriting an existing file as destructive, but not creating one', async () => {
    const asked: string[] = [];
    const a = agent(
      [{ toolCalls: [{ name: 'write_file', input: { path: 'notes.txt', content: 'a' } }, { name: 'write_file', input: { path: 'notes.txt', content: 'b' } }] }, { text: 'ok' }],
      { confirm: async ({ input }) => (asked.push((input as { content: string }).content), true) },
    );
    await a.run();
    expect(asked).toEqual(['b']);
  });

  it('stops on a refusal without running that turn’s tools', async () => {
    const a = agent([{ toolCalls: [{ name: 'delete_scene', input: { scene: 'level1' } }], stopReason: 'refusal' }]);
    const r = await a.run();
    expect(r.status).toBe('refusal');
    expect(r.toolCalls).toBe(0);
  });

  it('retries a turn whose streamed tool input could not be parsed', async () => {
    let failed = false;
    const t = setup();
    const scripted = new ScriptedProvider([{ text: 'done' }]);
    const provider = {
      model: 'scripted',
      complete: async (...args: Parameters<ScriptedProvider['complete']>) => {
        if (!failed) {
          failed = true;
          throw new SyntaxError('Unexpected end of JSON input');
        }
        return scripted.complete(...args);
      },
    };
    const events: AgentEvent[] = [];
    const r = await runAgent('x', { provider, store: t.store, host: t.host, tools: t.tools, onEvent: (e) => events.push(e) });
    expect(r.status).toBe('completed');
    expect(events.some((e) => e.type === 'retry')).toBe(true);
  });

  it('sends tool images to the model as image blocks', async () => {
    const t = setup();
    const png = `${t.dir}/shot.png`;
    writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
    const tools = new ToolRegistry([
      defineTool({ name: 'snap', description: 'Takes a test picture of the game.', input: z.object({}), run: () => new WithImages({ frame: 1 }, [{ path: png, mediaType: 'image/png' }]) }),
    ]);
    const provider = new ScriptedProvider([{ toolCalls: [{ name: 'snap', input: {} }] }, { text: 'seen' }]);
    await runAgent('look', { provider, store: t.store, host: t.host, tools });
    const [result] = provider.requests[1].messages.at(-1)!.content as Anthropic.Beta.BetaToolResultBlockParam[];
    expect(result.content).toEqual([
      { type: 'text', text: '{"frame":1}' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
  });
});
