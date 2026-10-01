import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isProjectDataFile, ProjectStore } from './project-store';
import { RuntimeHost } from './runtime/host';
import { createAgentTools } from './tools';
import type { Author } from './history';

const USAGE = `Usage: npm run vibe -- <command>

  tools                                   list tools
  schema [tool]                           tool definitions (JSON Schema)
  call <project> <tool> [json | @file | -] [--as agent|user]
  script <project> [json | @file | -]     run [{"tool": "...", "input": {...}}, ...] in one session
                                          (runtime tools like run_game/wait/take_screenshot need this)
  history <project> [limit]
  format <project>                        rewrite project.json and scenes/*.json in the canonical format
  undo <project> | redo <project>

<project> is a folder name under projects/ or a path.
Examples:
  npm run vibe -- call meu-pet get_scene '{"scene":"quarto"}'
  npm run vibe -- call meu-pet modify_game_object @patch.json --as agent
  npm run vibe -- script meu-pet @play.json`;

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
    case 'call': {
      const store = openStore(rest[0]);
      const host = new RuntimeHost(store);
      try {
        return await run(store, rest[1] ?? '', readInput(rest[2]), host);
      } finally {
        await host.close();
      }
    }
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
