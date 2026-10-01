import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ProjectStore } from '../project-store';
import type { RuntimeHost } from '../runtime/host';
import type { ToolRegistry, ToolResult } from '../tools/registry';
import { costOf, emptyUsage, type TokenUsage } from './pricing';
import { AGENT_SYSTEM_PROMPT } from './prompt';
import type { LLMProvider } from './provider';

export interface AgentLimits {
  /** Model requests per run. */
  maxIterations: number;
  /** Estimated spend ceiling in USD (ignored for models without a known price). */
  maxCostUsd: number;
  /** Ceiling on input + output tokens across the run. */
  maxTotalTokens: number;
  /** Wall-clock limit for the whole run. */
  timeoutMs: number;
}

export const DEFAULT_LIMITS: AgentLimits = {
  maxIterations: 60,
  maxCostUsd: 5,
  maxTotalTokens: 5_000_000,
  timeoutMs: 30 * 60_000,
};

export type AgentStatus = 'completed' | 'max_iterations' | 'budget' | 'timeout' | 'aborted' | 'refusal' | 'error';

export type AgentEvent =
  | { type: 'start'; runId: string; prompt: string; model: string; limits: AgentLimits }
  | { type: 'request'; iteration: number }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_declined'; id: string; name: string }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; result?: unknown; error?: string; details?: string[]; images?: string[]; ms: number }
  | { type: 'usage'; iteration: number; usage: TokenUsage; totalUsage: TokenUsage; costUsd: number | null }
  | { type: 'retry'; reason: string }
  | { type: 'done'; status: AgentStatus; message?: string; iterations: number; toolCalls: number; usage: TokenUsage; costUsd: number | null };

export interface AgentResult {
  runId: string;
  status: AgentStatus;
  /** Last text the model wrote (its final report when status is "completed"). */
  finalText: string;
  /** Why the run stopped, for statuses other than "completed". */
  message?: string;
  iterations: number;
  toolCalls: number;
  usage: TokenUsage;
  costUsd: number | null;
  /** Project-relative path of the JSONL log with every event. */
  logPath: string;
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface AgentOptions {
  provider: LLMProvider;
  store: ProjectStore;
  host: RuntimeHost;
  tools: ToolRegistry;
  limits?: Partial<AgentLimits>;
  /** Asked before destructive tool calls (deletes, overwrites). Return false to decline. Omit to allow all. */
  confirm?: (call: { name: string; input: unknown }) => Promise<boolean>;
  onEvent?: (event: AgentEvent) => void;
  /** Streams assistant text as it is generated. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  system?: string;
}

/** Tool results larger than this are cut, with an explicit note so the model knows. */
const MAX_RESULT_CHARS = 100_000;
const MAX_JSON_RETRIES = 2;

function toolResultBlock(id: string, r: ToolResult): Anthropic.Beta.BetaToolResultBlockParam {
  let text = JSON.stringify(r.ok ? (r.result ?? null) : { error: r.error, ...(r.details && { details: r.details }) });
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n[result truncated: ${text.length - MAX_RESULT_CHARS} more characters; request a narrower query]`;
  }
  if (!r.ok || !r.images?.length) return { type: 'tool_result', tool_use_id: id, content: text, ...(!r.ok && { is_error: true }) };
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: [
      { type: 'text', text },
      ...r.images.map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mediaType, data: readFileSync(img.path).toString('base64') },
      })),
    ],
  };
}

function addUsage(total: TokenUsage, u: Anthropic.Beta.BetaUsage): TokenUsage {
  const step = {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
  total.input += step.input;
  total.output += step.output;
  total.cacheRead += step.cacheRead;
  total.cacheWrite += step.cacheWrite;
  return step;
}

/**
 * The agent loop: send the conversation, run the requested tools against the project and
 * runtime, append the results, repeat until the model answers without tool calls or a
 * limit is reached. The history is append-only (required for preserved thinking and good
 * for caching), and every event is written to .vibe/agent/<runId>.jsonl.
 */
export async function runAgent(prompt: string, o: AgentOptions): Promise<AgentResult> {
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const runId = `agent-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const logPath = `.vibe/agent/${runId}.jsonl`;
  const logFile = o.store.path(logPath);
  mkdirSync(dirname(logFile), { recursive: true });
  const emit = (e: AgentEvent) => {
    appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), ...e })}\n`);
    o.onEvent?.(e);
  };

  // The timer aborts in-flight requests; the elapsed-time check also catches runs that never yield to timers.
  const startedAt = Date.now();
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const tools = o.tools.definitions() as Anthropic.Beta.BetaTool[];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
  const usage = emptyUsage();
  const ctx = { store: o.store, host: o.host, author: 'agent' as const };
  let iterations = 0;
  let toolCalls = 0;
  let finalText = '';
  let jsonRetries = 0;

  emit({ type: 'start', runId, prompt, model: o.provider.model, limits });

  const finish = (status: AgentStatus, message?: string): AgentResult => {
    const costUsd = costOf(o.provider.model, usage);
    emit({ type: 'done', status, message, iterations, toolCalls, usage, costUsd });
    return { runId, status, finalText, message, iterations, toolCalls, usage, costUsd, logPath, messages };
  };
  const stopReason = (): [AgentStatus, string] | null => {
    if (o.signal?.aborted) return ['aborted', 'Stopped by the user'];
    if (timeout.aborted || Date.now() - startedAt >= limits.timeoutMs) return ['timeout', `Time limit of ${Math.round(limits.timeoutMs / 1000)} s reached`];
    if (iterations >= limits.maxIterations) return ['max_iterations', `Reached ${limits.maxIterations} model requests`];
    const cost = costOf(o.provider.model, usage);
    if (cost !== null && cost >= limits.maxCostUsd) return ['budget', `Estimated cost $${cost.toFixed(2)} reached the $${limits.maxCostUsd} limit`];
    if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite >= limits.maxTotalTokens) {
      return ['budget', `Token limit of ${limits.maxTotalTokens} reached`];
    }
    return null;
  };

  for (;;) {
    const stop = stopReason();
    if (stop) return finish(...stop);

    iterations++;
    emit({ type: 'request', iteration: iterations });
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await o.provider.complete({ system: o.system ?? AGENT_SYSTEM_PROMPT, messages, tools }, { signal, onText: o.onText });
      jsonRetries = 0;
    } catch (err) {
      const stopped = stopReason();
      if (signal.aborted && stopped) return finish(...stopped);
      if (err instanceof Anthropic.APIError) return finish('error', `API error${err.status ? ` ${err.status}` : ''}: ${err.message}`);
      // With streamed tool inputs, an unparseable input rejects the stream: re-issue the turn.
      if (jsonRetries++ < MAX_JSON_RETRIES) {
        emit({ type: 'retry', reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      return finish('error', err instanceof Error ? err.message : String(err));
    }

    const step = addUsage(usage, response.usage);
    emit({ type: 'usage', iteration: iterations, usage: step, totalUsage: { ...usage }, costUsd: costOf(o.provider.model, usage) });
    for (const block of response.content) {
      if (block.type === 'thinking' && block.thinking) emit({ type: 'thinking', text: block.thinking });
      if (block.type === 'text' && block.text) {
        finalText = block.text;
        emit({ type: 'text', text: block.text });
      }
    }

    // A refusal can cut a tool call off mid-input: never run that turn's tools.
    if (response.stop_reason === 'refusal') {
      const d = response.stop_details;
      return finish('refusal', `The model declined${d?.category ? ` (${d.category})` : ''}${d?.explanation ? `: ${d.explanation}` : ''}`);
    }
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'pause_turn') continue;

    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (!calls.length) {
      if (response.stop_reason === 'max_tokens') return finish('error', 'The response hit max_tokens before finishing');
      return finish('completed');
    }
    if (response.stop_reason === 'max_tokens') return finish('error', 'A tool call was cut off by max_tokens');

    // Calls run in order (game state depends on it); all results go back in one user message.
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      toolCalls++;
      emit({ type: 'tool_call', id: call.id, name: call.name, input: call.input });
      if (signal.aborted) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Not run: the agent was stopped.', is_error: true });
        continue;
      }
      if (o.confirm && o.tools.isDestructive(call.name, call.input, ctx) && !(await o.confirm({ name: call.name, input: call.input }))) {
        emit({ type: 'tool_declined', id: call.id, name: call.name });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'The user declined this action. Do not retry it; find another way or explain.', is_error: true });
        continue;
      }
      const started = Date.now();
      const r = await o.tools.call(call.name, call.input, ctx);
      emit({
        type: 'tool_result',
        id: call.id,
        name: call.name,
        ok: r.ok,
        ms: Date.now() - started,
        ...(r.ok ? { result: r.result, images: r.images?.map((i) => i.path) } : { error: r.error, details: r.details }),
      });
      results.push(toolResultBlock(call.id, r));
    }
    messages.push({ role: 'user', content: results });
  }
}
