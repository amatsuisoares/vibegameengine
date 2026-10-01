import Anthropic from '@anthropic-ai/sdk';

export interface LLMRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

export interface LLMCallOptions {
  signal?: AbortSignal;
  /** Receives assistant text as it streams. */
  onText?: (delta: string) => void;
}

/** A model the agent loop can talk to. Responses use the Messages API shape. */
export interface LLMProvider {
  readonly model: string;
  complete(request: LLMRequest, options?: LLMCallOptions): Promise<Anthropic.Beta.BetaMessage>;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeProviderOptions {
  model?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Server-side fallback to another model when the requested one declines for policy reasons. */
  fallbacks?: boolean;
  client?: Anthropic;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Claude through the official SDK: streaming (long turns never hit HTTP timeouts),
 * adaptive thinking with summaries for the log, automatic prompt caching of the growing
 * conversation, and opt-in server-side refusal fallbacks.
 */
export class ClaudeProvider implements LLMProvider {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly options: ClaudeProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    // Credentials come from the environment (ANTHROPIC_API_KEY, or an `ant auth login` profile).
    this.client = options.client ?? new Anthropic();
  }

  async complete(request: LLMRequest, { signal, onText }: LLMCallOptions = {}) {
    const fallbacks = this.options.fallbacks ?? true;
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: this.options.maxTokens ?? 64000,
        system: request.system,
        messages: request.messages,
        // Large inputs (file contents) stream as generated; the tool registry validates every input.
        tools: request.tools.map((t) => ({ ...t, eager_input_streaming: true })),
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: this.options.effort ?? 'high' },
        cache_control: { type: 'ephemeral' },
        ...(fallbacks && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
      },
      { signal },
    );
    if (onText) stream.on('text', onText);
    return stream.finalMessage();
  }
}

/** One scripted model turn: text and/or tool calls. A function can compute the turn from the request. */
export type ScriptedTurn =
  | {
      text?: string;
      toolCalls?: { name: string; input: unknown }[];
      stopReason?: Anthropic.Beta.BetaStopReason;
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    }
  | ((request: LLMRequest) => Exclude<ScriptedTurn, (r: LLMRequest) => unknown>);

/**
 * Plays back predefined turns instead of calling a model. Used by tests and for
 * running the agent loop without an API key (`vibe agent --scripted turns.json`).
 */
export class ScriptedProvider implements LLMProvider {
  readonly requests: LLMRequest[] = [];
  private next = 0;

  /** `model` only affects cost estimates (tests use a priced model name to exercise budgets). */
  constructor(
    private readonly turns: ScriptedTurn[],
    readonly model = 'scripted',
  ) {}

  async complete(request: LLMRequest, { signal, onText }: LLMCallOptions = {}) {
    signal?.throwIfAborted();
    this.requests.push(structuredClone(request));
    const entry = this.turns[this.next++] ?? { text: '(end of script)' };
    const turn = typeof entry === 'function' ? entry(request) : entry;
    const content: Anthropic.Beta.BetaContentBlock[] = [];
    if (turn.text) {
      onText?.(turn.text);
      content.push({ type: 'text', text: turn.text, citations: null } as Anthropic.Beta.BetaTextBlock);
    }
    (turn.toolCalls ?? []).forEach((c, i) =>
      content.push({ type: 'tool_use', id: `toolu_${this.next}_${i}`, name: c.name, input: c.input } as Anthropic.Beta.BetaToolUseBlock),
    );
    return {
      id: `msg_scripted_${this.next}`,
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: turn.stopReason ?? (turn.toolCalls?.length ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: {
        input_tokens: turn.usage?.input_tokens ?? 0,
        output_tokens: turn.usage?.output_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: turn.usage?.cache_read_input_tokens ?? 0,
      },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}
