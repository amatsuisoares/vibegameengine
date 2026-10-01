import type { AgentEvent } from './loop';

const short = (v: unknown, max = 140) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
};

/** One-line rendering of agent events for the terminal. Text is printed by the stream handler. */
export function formatEvent(e: AgentEvent): string | null {
  switch (e.type) {
    case 'start':
      return `▶ ${e.runId} · ${e.model} · limits: ${e.limits.maxIterations} requests, $${e.limits.maxCostUsd}, ${Math.round(e.limits.timeoutMs / 60000)} min`;
    case 'thinking':
      return `  … ${short(e.text.replace(/\s+/g, ' '), 200)}`;
    case 'tool_call':
      return `  → ${e.name} ${short(e.input)}`;
    case 'tool_declined':
      return `  ✗ ${e.name} declined by the user`;
    case 'tool_result': {
      if (!e.ok) return `  ← ${e.name} ERROR: ${e.error}${e.details?.length ? ` (${short(e.details.join('; '), 200)})` : ''}`;
      const r = e.result as Record<string, unknown> | undefined;
      const bits: string[] = [];
      if (r && typeof r === 'object') {
        for (const k of ['passed', 'status', 'frame', 'changed', 'ok', 'historySeq', 'path']) if (k in r) bits.push(`${k}=${short(r[k], 60)}`);
        if (Array.isArray((r as { events?: unknown[] }).events)) {
          const types = ((r as { events: { type: string }[] }).events).map((x) => x.type);
          if (types.length) bits.push(`events=[${short(types.join(','), 80)}]`);
        }
      }
      if (e.images?.length) bits.push(`image: ${e.images[0]}`);
      return `  ← ${e.name} ok${bits.length ? ` ${bits.join(' ')}` : ''} (${e.ms} ms)`;
    }
    case 'usage':
      return e.costUsd === null ? null : `  · request ${e.iteration}: ${e.usage.input + e.usage.cacheRead + e.usage.cacheWrite} in / ${e.usage.output} out · total $${e.costUsd.toFixed(3)}`;
    case 'retry':
      return `  ↻ retrying the turn: ${short(e.reason)}`;
    case 'done':
      return `■ ${e.status}${e.message ? `: ${e.message}` : ''} · ${e.iterations} requests · ${e.toolCalls} tool calls${e.costUsd !== null ? ` · ~$${e.costUsd.toFixed(3)}` : ''}`;
    default:
      return null;
  }
}
