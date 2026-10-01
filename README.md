# VibeGameEngine

Plataforma de criação de jogos 2D em que um agente de IA **constrói, executa, joga, observa e corrige** o próprio jogo.

> Status: **Etapa 5 concluída** — engine headless determinística, runtime no browser (Canvas2D),
> ProjectStore com histórico/undo, tools para editar, jogar, testar e fotografar, e o agente (Claude) que usa
> essas tools sozinho, com limites de custo/tempo e log completo.
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

### Agente

```bash
# requer credenciais da Anthropic: ANTHROPIC_API_KEY ou `ant auth login`
npm run vibe -- agent demo-platformer "Adicione dois inimigos que sigam o jogador e teste se eles causam dano"
```

Opções: `--model` (padrão `claude-opus-5-5`), `--effort low|medium|high|xhigh|max` (padrão `high`),
`--max-iterations` (60), `--max-cost` (US$ 5), `--timeout` (30 min), `--yes` (não perguntar antes de apagar ou
sobrescrever), `--no-fallback`, `--scripted turnos.json` (roda o loop sem API, com respostas roteirizadas).
O terminal mostra cada tool chamada e seu resultado; Ctrl+C para depois do passo atual. O log completo fica em
`projects/<nome>/.vibe/agent/`, e cada alteração entra no histórico (dá para desfazer com `undo`).
Com `npm run dev` aberto, as alterações aparecem no jogo enquanto o agente trabalha.

### Tools pela CLI

```bash
npm run vibe -- call demo-platformer get_project_summary
npm run vibe -- call demo-platformer modify_component @patch.json --as agent   # JSON inline, @arquivo ou - (stdin)
npm run vibe -- history demo-platformer
npm run vibe -- undo demo-platformer
npm run vibe -- schema modify_game_object      # JSON Schema no formato de tool use
npm run vibe -- format demo-platformer         # normaliza o JSON do projeto
npm run vibe -- script demo-platformer @play.json   # várias tools numa mesma run (jogar + screenshot)
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
A barra superior tem seletor de projeto, Restart, Pause/Resume, Step (1 frame) e Debug (colliders e ids).
Editar arquivos em `projects/<nome>/` recarrega o jogo automaticamente; erros de validação aparecem no console.

Parâmetros de URL: `?project=demo-platformer&scene=level1&seed=7&debug=1&paused=1`.
Com `paused=1` nada avança sozinho — o jogo só anda por `window.__vibe` (modo usado por hosts externos).

## Estrutura

```
packages/
  shared/   schemas (zod) do projeto, cenas, entidades e componentes + validação
  engine/   engine 2D headless: física, input virtual, gameplay, câmera, estado
  server/   ProjectStore (disco, escrita atômica, histórico, undo/redo), RuntimeHost (runs headless,
            screenshots no Chromium), tools, agente (loop com Claude), CLI
  runtime/  runtime no browser: renderer Canvas2D, assets, loop, teclado/mouse, window.__vibe
    app/    página Vite (index.html + main.ts)
    vite/   plugin do dev server: serve projects/ e avisa a página quando arquivos mudam
    e2e/    testes no Chromium (Playwright)
projects/
  demo-platformer/   projeto de exemplo (project.json + scenes/*.json + assets/*.svg)
docs/
  PROMPT_ORIGINAL.md pedido original do projeto (escopo e prioridades)
```

Pacotes planejados: `editor` (React). O `server` ganha memória do projeto (Etapa 6) e a API do editor (Etapa 7).

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
