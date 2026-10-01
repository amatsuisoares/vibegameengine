# VibeGameEngine

Plataforma de criação de jogos 2D em que um agente de IA **constrói, executa, joga, observa e corrige** o próprio jogo.

> Status: **Etapa 8 concluída** — o **Claude Code é o agente**: pelo chat ele cria e edita o jogo, roda, joga,
> vê screenshots, testa e corrige, usando as tools do servidor MCP `vibe`. O jogo aparece num painel do VS Code,
> com hot reload e um modo que segue ao vivo o que o agente está jogando. Além dos componentes prontos há scripts,
> regras de evento/condição, prefabs, som, plataformas móveis e memória do projeto.
> Veja [TODO.md](TODO.md) para o roadmap e [ARCHITECTURE.md](ARCHITECTURE.md) para o desenho.

## Requisitos

- Node.js 24+ (npm 11+)
- Git

## Comandos

```bash
npm install
npm run dev         # runtime no browser: http://localhost:5173
npm test            # vitest (todos os pacotes)
npm run typecheck   # tsc --noEmit
npm run test:e2e    # testes no Chromium headless (requer: npx playwright install chromium)
npm run vibe -- tools   # CLI das tools de edição (ver abaixo)
```

### Usando pelo Claude Code (VS Code)

1. Abra a pasta do repositório no VS Code (**File → Open Folder → `C:\dev\vibegameengine`**).
2. O Claude Code lê `.mcp.json` e inicia o servidor MCP `vibe` (as tools aparecem como `mcp__vibe__*`).
3. Peça pelo chat, por exemplo: *"Crie um jogo de plataforma com três moedas, dois inimigos e uma bandeira; teste
   tudo"*. O agente cria/edita o projeto em `projects/`, joga, tira screenshots e roda testes.
4. Cada alteração entra no histórico do projeto (`undo`/`redo`).

### Jogo dentro do VS Code

- **Command Palette → "Tasks: Run Task" → "Vibe: abrir jogo"**: sobe o dev server e abre o jogo no Simple Browser,
  num painel do editor. Cada edição do agente recarrega o jogo na hora.
- **"Vibe: seguir agente"**: o painel mostra ao vivo a run que o Claude Code está jogando (`run_game`,
  `perform_inputs`...). O mesmo modo liga e desliga pela caixa **Seguir agente** na barra do jogo.
- Pelo chat: peça *"abra o jogo"*. A tool `open_game_view` devolve um link que o VS Code abre no Simple Browser
  (`.vscode/settings.json`).

### Tools pela CLI

```bash
npm run vibe -- call meu-pet get_project_summary
npm run vibe -- call meu-pet modify_component @patch.json --as agent   # JSON inline, @arquivo ou - (stdin)
npm run vibe -- history meu-pet
npm run vibe -- undo meu-pet
npm run vibe -- schema modify_game_object      # JSON Schema no formato de tool use
npm run vibe -- format meu-pet         # normaliza o JSON do projeto
npm run vibe -- script meu-pet @play.json   # várias tools numa mesma run (jogar + screenshot)
```

Exemplo de `play.json` — anda, pula e fotografa com colliders anotados:

```json
[
  { "tool": "run_game" },
  { "tool": "perform_inputs", "input": { "steps": [{ "type": "hold", "key": "D", "ms": 1200 }, { "type": "tap", "key": "Space" }] } },
  { "tool": "take_screenshot", "input": { "annotate": true } },
  { "tool": "run_test", "input": { "steps": [{ "type": "keyDown", "key": "D" }, { "type": "waitUntil", "expr": "vars.coins == 1" }], "assertions": ["status == 'running'"] } }
]
```

Screenshots ficam em `projects/<nome>/.vibe/runs/`.

Com `npm run dev` aberto, cada alteração aparece no jogo na hora (hot reload).

### Runtime no browser

`npm run dev` abre a página do runtime. A/D (ou setas) andam, Espaço pula, **R** reinicia depois do fim de jogo.
A barra superior tem seletor de projeto, Restart, Pause/Resume, Step (1 frame), Debug (colliders e ids), Som e
Seguir agente. O som começa depois do primeiro clique ou tecla na página (regra dos navegadores).
Editar arquivos em `projects/<nome>/` recarrega o jogo automaticamente; erros de validação aparecem no console.

Parâmetros de URL: `?project=meu-pet&scene=quarto&seed=7&debug=1&paused=1&live=1`.
Com `paused=1` nada avança sozinho — o jogo só anda por `window.__vibe` (modo usado por hosts externos).
Com `live=1` a página segue a run do agente (`.vibe/live.json`) em vez de ser jogada.

## Estrutura

```
packages/
  shared/   schemas (zod) do projeto, cenas, entidades e componentes + validação
  engine/   engine 2D headless: física, input virtual, gameplay, câmera, estado
  server/   ProjectStore (disco, escrita atômica, histórico, undo/redo), RuntimeHost (runs headless,
            screenshots no Chromium), tools, servidor MCP (Claude Code como agente), CLI
  runtime/  runtime no browser: renderer Canvas2D, assets, loop, teclado/mouse, window.__vibe
    app/    página Vite (index.html + main.ts)
    vite/   plugin do dev server: serve projects/ e avisa a página quando arquivos mudam
    e2e/    testes no Chromium (Playwright)
projects/
  meu-pet/           o jogo de pet virtual (project.json + scenes/ + scripts/ + prefabs/ + assets/)
docs/
  PROMPT_ORIGINAL.md pedido original do projeto (escopo e prioridades)
```

Não há editor separado: o jogo roda dentro do VS Code (Simple Browser, `.vscode/tasks.json`) e o chat é o Claude Code.

## Uso da engine (headless)

```ts
import { Game } from '@vibe/engine';

const game = Game.fromRaw({ config, scenes });   // valida o JSON; lança erro listando cada problema
game.perform([
  { type: 'hold', key: 'D', ms: 1000 },         // tempo simulado, não relógio real
  { type: 'tap', key: 'Space' },
  { type: 'wait', ms: 500 },
]);
game.getState({ tags: ['player'] });             // estado estruturado
game.events(0, 'collect');                       // eventos de gameplay
game.console.read();                             // logs/erros do runtime
```

## Controle externo do runtime (browser)

```js
// página aberta com ?paused=1
__vibe.perform([{ type: 'hold', key: 'D', ms: 1000 }]);   // → { frame, status, scene }
__vibe.keyDown('Space'); __vibe.step(10); __vibe.keyUp('Space');
__vibe.getState({ tags: ['player'] });
__vibe.setDebug(true);                                     // desenha colliders/ids antes de um screenshot
```

API completa em [AGENT_TOOLS.md](AGENT_TOOLS.md#runtime-no-browser-window__vibe).
