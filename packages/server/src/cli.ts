import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { formatEvent } from './agent/console-view';
import { DEFAULT_LIMITS, runAgent } from './agent/loop';
import { ClaudeProvider, ScriptedProvider, type Effort, type LLMProvider, type ScriptedTurn } from './agent/provider';
import { isProjectDataFile, ProjectStore } from './project-store';
import { RuntimeHost } from './runtime/host';
import { createAgentTools } from './tools';
import type { Author } from './history';

const USAGE = `Usage: npm run vibe -- <command>

  tools                                   list tools
  schema [tool]                           tool definitions (Claude tool format, JSON Schema)
  call <project> <tool> [json | @file | -] [--as agent|user]
  script <project> [json | @file | -]     run [{"tool": "...", "input": {...}}, ...] in one session
                                          (runtime tools like run_game/wait/take_screenshot need this)
  agent <project> "<prompt>" [options]   let the AI agent build/fix the game (needs ANTHROPIC_API_KEY)
      --model <id>           default claude-opus-5-5
      --effort <level>       low | medium | high (default) | xhigh | max
      --max-iterations <n>   default ${DEFAULT_LIMITS.maxIterations}
      --max-cost <usd>       default ${DEFAULT_LIMITS.maxCostUsd}
      --timeout <minutes>    default ${DEFAULT_LIMITS.timeoutMs / 60000}
      --yes                  do not ask before deleting/overwriting
      --no-fallback          disable server-side refusal fallback
      --scripted <file>      replay scripted model turns instead of calling the API
  history <project> [limit]
  format <project>                        rewrite project.json and scenes/*.json in the canonical format
  undo <project> | redo <project>

<project> is a folder name under projects/ or a path.
Examples:
  npm run vibe -- call demo-platformer get_scene '{"scene":"level1"}'
  npm run vibe -- call demo-platformer modify_game_object @patch.json --as agent
  npm run vibe -- script demo-platformer @play.json`;

const PROJECTS = fileURLToPath(new URL('../../../projects/', import.meta.url));

function openStore(arg: string | undefined) {
  if (!arg) throw new Error('Missing <project>');
  const dir = existsSync(`${arg}/project.json`) ? arg : `${PROJECTS}${arg}`;
  return new ProjectStore(dir);
}

function readInput(arg: string | undefined): unknown {
  if (arg === undefined) return {};
  const text = arg === '-' ? readFileSync(0, 'utf8') : arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Removes `--name value` (or a bare `--name` flag when `isFlag`) from argv and returns it. */
function takeOption(argv: string[], name: string, isFlag = false): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  if (isFlag) {
    argv.splice(i, 1);
    return 'true';
  }
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  argv.splice(i, 2);
  return v;
}

function numberOption(argv: string[], name: string): number | undefined {
  const v = takeOption(argv, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`);
  return n;
}

async function agentCommand(argv: string[]): Promise<number> {
  const model = takeOption(argv, 'model');
  const effort = takeOption(argv, 'effort') as Effort | undefined;
  const maxIterations = numberOption(argv, 'max-iterations');
  const maxCostUsd = numberOption(argv, 'max-cost');
  const timeoutMin = numberOption(argv, 'timeout');
  const yes = takeOption(argv, 'yes', true) === 'true';
  const noFallback = takeOption(argv, 'no-fallback', true) === 'true';
  const scripted = takeOption(argv, 'scripted');
  const [projectArg, prompt] = argv;
  if (!prompt) throw new Error('Usage: agent <project> "<prompt>" [options]');
  if (effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('--effort must be low, medium, high, xhigh or max');

  const store = openStore(projectArg);
  const host = new RuntimeHost(store);
  const provider: LLMProvider = scripted
    ? new ScriptedProvider(JSON.parse(readFileSync(scripted, 'utf8')) as ScriptedTurn[])
    : new ClaudeProvider({ model, effort, fallbacks: !noFallback });
  if (!scripted && !noFallback) console.log('(server-side refusal fallback enabled; --no-fallback to disable)');

  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const abort = new AbortController();
  const onSigint = () => {
    if (abort.signal.aborted) process.exit(130);
    console.log('\n(stopping after the current step; press Ctrl+C again to quit now)');
    abort.abort();
  };
  process.on('SIGINT', onSigint);

  let midLine = false;
  try {
    const result = await runAgent(prompt, {
      provider,
      store,
      host,
      tools: createAgentTools(),
      signal: abort.signal,
      limits: {
        ...(maxIterations && { maxIterations }),
        ...(maxCostUsd && { maxCostUsd }),
        ...(timeoutMin && { timeoutMs: timeoutMin * 60_000 }),
      },
      confirm: yes
        ? undefined
        : async ({ name, input }) => {
            if (!rl) {
              console.log(`  ✗ ${name} needs confirmation; not a terminal, declined (use --yes to allow)`);
              return false;
            }
            const answer = await rl.question(`  ? allow ${name} ${JSON.stringify(input).slice(0, 160)} [y/N] `);
            return /^y(es)?$/i.test(answer.trim());
          },
      onText: (delta) => {
        process.stdout.write(delta);
        midLine = !delta.endsWith('\n');
      },
      onEvent: (e) => {
        if (midLine) process.stdout.write('\n');
        midLine = false;
        if (e.type === 'text') return; // already streamed
        const line = formatEvent(e);
        if (line) console.log(line);
      },
    });
    console.log(`log: ${store.path(result.logPath)}`);
    return result.status === 'completed' ? 0 : 2;
  } finally {
    process.off('SIGINT', onSigint);
    rl?.close();
    await host.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const asIdx = argv.indexOf('--as');
  let author: Author = 'user';
  if (asIdx >= 0) {
    const v = argv.splice(asIdx, 2)[1];
    if (v !== 'agent' && v !== 'user') throw new Error('--as must be "agent" or "user"');
    author = v;
  }
  const [cmd, ...rest] = argv;
  const tools = createAgentTools();
  const print = (v: unknown) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

  const run = async (store: ProjectStore, tool: string, input: unknown, host = new RuntimeHost(store)) => {
    const r = await tools.call(tool, input, { store, author, host });
    if (!r.ok) {
      print(r);
      return 1;
    }
    const result = r.result as { diff?: string } | undefined;
    if (result && typeof result === 'object' && typeof result.diff === 'string') {
      const { diff, ...meta } = result;
      print(meta);
      console.log(diff);
    } else print(result);
    for (const img of r.images ?? []) console.log(`[image] ${img.path}`);
    return 0;
  };

  switch (cmd) {
    case 'tools':
      for (const d of tools.definitions()) console.log(`${d.name.padEnd(24)} ${d.description.length > 90 ? `${d.description.slice(0, 87)}...` : d.description}`);
      return 0;
    case 'schema': {
      const defs = tools.definitions();
      print(rest[0] ? defs.find((d) => d.name === rest[0]) ?? `Unknown tool "${rest[0]}"` : defs);
      return 0;
    }
    case 'call':
      return run(openStore(rest[0]), rest[1] ?? '', readInput(rest[2]));
    case 'agent':
      return agentCommand(rest);
    case 'script': {
      const store = openStore(rest[0]);
      const steps = readInput(rest[1]) as { tool: string; input?: unknown }[];
      if (!Array.isArray(steps)) throw new Error('Script must be a JSON array of {"tool", "input"}');
      const host = new RuntimeHost(store);
      try {
        for (const [i, step] of steps.entries()) {
          console.log(`\n### ${i + 1}. ${step.tool} ${JSON.stringify(step.input ?? {})}`);
          if ((await run(store, step.tool, step.input ?? {}, host)) !== 0) return 1;
        }
      } finally {
        await host.close();
      }
      return 0;
    }
    case 'history':
      return run(openStore(rest[0]), 'get_history', rest[1] ? { limit: Number(rest[1]) } : {});
    case 'format': {
      const store = openStore(rest[0]);
      const r = store.edit({ author, summary: 'Format project JSON files', tool: 'format' }, (tx) => {
        for (const file of ['project.json', ...store.sceneFiles()]) {
          if (isProjectDataFile(file)) tx.writeJson(file, tx.readJson(file));
        }
      });
      print(r.seq === null ? 'Already formatted.' : `Formatted: ${r.files.map((f) => f.file).join(', ')} (history #${r.seq})`);
      return 0;
    }
    case 'undo':
    case 'redo':
      return run(openStore(rest[0]), cmd, {});
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
