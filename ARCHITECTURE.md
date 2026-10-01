# Arquitetura

## Visão geral

O VibeGameEngine roda **dentro do VS Code**. O chat e o agente são o próprio **Claude Code**, que usa a engine
pelas tools de um servidor MCP. Não há editor nem chat separados.

```
┌──────────────── VS Code ───────────────────────────────────────────┐
│  Claude Code (chat = agente)          painel do jogo (Simple Browser)│
└───────────┬──────────────────────────────────▲──────────────────────┘
            │ MCP (stdio)                      │ hot reload + run ao vivo
┌───────────▼──────── servidor MCP "vibe" (Node) ──────────────────────┐
│ Workspace ── projeto aberto (list/open/create_project)               │
│ ToolRegistry ── 38 tools: edição, histórico, runtime                 │
│ ProjectStore ── validação, escrita atômica, histórico/undo           │
│ RuntimeHost ─┬─ run headless (Game + log de GameOp)                  │
│              └─ screenshots: Vite + Chromium (Playwright)            │
└───────────┬──────────────────────────────────────────────────────────┘
            │ mesma engine nos dois modos
┌───────────▼──────── Engine (TS) ─────────────────────────────────────┐
│ World · Entities · Systems · Input virtual · expressões              │
└──────────────────────────────────────────────────────────────────────┘
```

Implementado: `shared` e `engine` (Etapa 1), `runtime` no browser (Etapa 2), `server` com ProjectStore + tools
de edição (Etapa 3), RuntimeHost com runs headless, testes e screenshots (Etapa 4), o servidor MCP que faz do
Claude Code o agente (Etapa 6), o jogo dentro do VS Code (Etapa 7) e memória, scripts, regras, prefabs, som e
plataformas móveis (Etapa 8). A Etapa 5 (agente embutido via API) foi removida quando o projeto passou a usar o
Claude Code como agente.

## Princípios

1. **O projeto é dado.** Cenas são JSON validados por schema (zod). O agente edita entidades e
   componentes de forma incremental; nunca regenera o projeto inteiro.
2. **Componentes prontos primeiro, scripts depois.** A maior parte de um jogo de plataforma é composição
   de componentes built-in. Scripts customizados (etapa 8) cobrem o que faltar.
3. **Tempo simulado e determinismo.** A engine avança em passos fixos de 1/60 s. `wait(ms)` avança
   frames, não relógio. Mesmo input ⇒ mesmo estado (RNG com seed). Testes do agente são reproduzíveis
   e rodam mais rápido que tempo real.
4. **Input virtual.** Teclado/mouse reais (browser) e as tools do agente alimentam a mesma API `Input`.
   O agente nunca controla o sistema operacional.
5. **Observação estruturada primeiro, visão como complemento.** `getState()`, eventos e console são a
   fonte de verdade para verificar comportamento; screenshots servem para julgar layout/visual.
6. **Renderização não afeta a simulação.** A engine não conhece o DOM; renderers apenas leem o `World`.

## Modelo de projeto (`packages/shared`)

```
Project
├── config: ProjectConfig   name, width/height (viewport), gravity, startScene, actions, assets
└── scenes: { [id]: Scene }
       Scene: id, background, width/height (mundo), killY, fallDamage, camera, vars, entities[], rules[]
          Entity: id, name, tags[], enabled, transform{x,y,rotation,scaleX,scaleY},
                  components: { Sprite?, Body?, Collider?, PlatformerController?, ... }
```

Em disco: `projects/<nome>/project.json` (config) + `scenes/<id>.json` + `scripts/**/*.js` + `prefabs/<id>.json`.
Memória do agente em `.vibe/memory.json`.

- **Prefabs:** `parseProject` expande as instâncias antes da validação (`expandPrefabs`: prefab ⊕ entidade por JSON
  Merge Patch, mantendo o campo `prefab`), então a engine só vê entidades completas e erros apontam para a instância.
  `World.spawn` cria entidades a partir de `Project.prefabs` em execução (regras e scripts).

- Coordenadas em pixels, **y cresce para baixo**, `transform.x/y` é o **centro** da entidade.
- `rotation` (graus, horário) e `scaleX/scaleY` são **só visuais**: não mudam o collider. Escala negativa espelha.
- Assets (`config.assets`) ficam em `projects/<nome>/assets/`; caminho relativo, sem `..`. Spritesheets exigem
  `frameWidth/frameHeight`; frames contam da esquerda para a direita, de cima para baixo. SVG funciona como imagem.
- Componentes são um mapa `tipo → dados` (no máximo um de cada tipo por entidade), o que torna
  `modify_component(entity, "Body", {...})` trivial.
- Todos os campos têm default no schema; o JSON só precisa conter o que difere.
- Validação em duas camadas: **forma** (zod, `strictObject` rejeita campos/componentes desconhecidos) e
  **semântica** (`checkProject`: ids duplicados, referências a entidades/cenas/assets inexistentes).
- Mensagens de erro incluem o id da entidade no caminho, ex.
  `scenes.main.entities[3](enemy1).components.Body.type: Invalid option...` — feitas para o agente ler.
- As descrições `.describe()` dos schemas serão exportadas como documentação/JSON Schema para o LLM.

### Componentes built-in

| Componente | Função |
|---|---|
| `Sprite` | desenho: asset/frame ou forma colorida (`rect`/`circle`/`triangle`), layer, flip |
| `Body` | `dynamic` (gravidade + colisão), `static`, `kinematic` (move por velocidade) |
| `Collider` | AABB com offset; `isTrigger`; `oneWay` (plataforma atravessável por baixo) |
| `PlatformerController` | andar/pular por *actions*; aceleração, coyote time, jump buffer, pulo variável, pulo duplo |
| `Patrol` | anda de um lado a outro; vira em paredes, bordas e limite de distância |
| `FollowTarget` | persegue entidade por id ou tag dentro de um raio (horizontal ou voo livre) |
| `Health` | vida, invulnerabilidade, `onDeath`: destroy / lose / respawn / none |
| `Damage` | causa dano a tags alvo ao contato, com knockback |
| `Stompable` | morre (ou toma dano) quando pisado por cima; quica o atacante |
| `Collectible` | incrementa variável (ex. `coins`), soma `score`, pode curar |
| `Goal` | vitória ou troca de cena; `require` exige variáveis mínimas |
| `Checkpoint` | define ponto de respawn |
| `Text` | texto/HUD com placeholders `{coins}`, `{player.health}` |
| `Animator` | clipes de spritesheet; seleção automática idle/run/jump/fall |
| `Script` | comportamento em JavaScript (`scripts/*.js`): `onStart/onUpdate/onCollision` com API restrita |
| `Mover` | segue waypoints (vaivém ou loop, pausa); com Body kinematic vira plataforma móvel/elevador |

## Engine (`packages/engine`)

```
Game ── API pública: step/advance/perform/waitUntil/getState/events/console/restart/loadScene
 └── World ── entidades, vars, status (running|won|lost|crashed), eventos, câmera, checkpoints
      Passo fixo (1/60 s), nesta ordem:
        1. Input.beginFrame()        latch de teclas pressionadas entre frames
        2. controllerSystem           PlatformerController, Patrol, FollowTarget
           moverSystem                Mover: velocidade dos kinematic rumo ao próximo waypoint
           ScriptRunner.update        onStart (1ª vez) e onUpdate dos scripts
        3. physicsSystem              gravidade; move X e resolve; move Y e resolve (grounded)
        4. findContacts + interactionSystem   coleta, pisão, dano, checkpoint, goal
           ScriptRunner.collisions    onCollision dos contatos que começaram neste frame
        5. healthSystem               timers, queda no abismo (killY), morte
        6. animationSystem            flip e frames de animação
           RuleRunner.run             regras da cena (start/event/enter/expr/every → if → ações)
           SoundDirector.run          eventos com som em config.sounds → evento sound
        7. flushDestroyed, cameraSystem
```

- **Física:** arcade, AABB, resolução por eixo contra sólidos (colliders não-trigger sem Body dinâmico).
  Kinematic se move primeiro; um corpo que estava apoiado nele (`groundId`) é levado junto (fica no topo e segue o
  deslocamento lateral). One-way compara com a posição anterior da plataforma, então plataforma subindo não é atravessada.
  Corpos dinâmicos não bloqueiam uns aos outros — sobreposição vira contato (dano, pisão).
  Sem colisão contínua: sólidos devem ter ≥ 16 px de espessura (queda máx. 15 px/frame).
- **Contatos:** pares sobrepostos (tolerância 0,5 px, então “encostar” conta). Goal/Checkpoint usam
  semântica de *enter* (só no primeiro frame de contato).
- **Eventos:** `jump, collect, damage, stomp, death, fell, respawn, checkpoint, goal, goal_blocked, win,
  lose, scene_loaded, crash, script_error` e os que scripts emitem — registrados com o frame, consultáveis por
  `game.events()`.
- **Erros:** exceções dentro de um passo são capturadas, vão para o console com stack e o status vira
  `crashed` (o agente lê e corrige).
- **Scripts** (`engine/src/scripts.ts`): `Project.scripts` (fonte por caminho) vem do disco junto com config e
  cenas, então runs, screenshots e o modo seguir usam exatamente o mesmo código. `ScriptLibrary` compila cada
  arquivo uma vez por `Game` com `new Function` (igual no Node e no browser); o corpo começa na primeira linha, então
  a linha do erro é a do stack menos as 2 do cabeçalho. Cada entidade chama a fábrica e ganha suas próprias
  closures. Parâmetros com o nome de `Date`, `process`, `window`, `globalThis`... escondem esses globais; `Math` é
  um objeto derivado com `random` da RNG do mundo. Exceções de script são capturadas por chamada (não viram
  `crashed`). O `ProjectStore` checa a sintaxe com `node:vm` (que informa a linha) antes de gravar.
- **Regras** (`engine/src/rules.ts`): `RuleRunner` por mundo. Eventos novos são lidos por contagem
  (`World.emitted`), então eventos que uma regra emite são processados no frame seguinte. `expr` dispara na borda
  (falso → verdadeiro); expressões são compiladas uma vez (`compileExpr`). Erro em regra → `rule_error` e a regra
  fica desligada até a cena recarregar.
- **Som** (`engine/src/sound.ts`): a simulação só emite eventos. `SoundDirector` (depois das regras) converte eventos
  mapeados em `config.sounds` em `sound`; `loadScene` emite `music`. No browser, `Runtime.onEvents` entrega os eventos
  novos a cada quadro e o `SoundPlayer` (`runtime/src/audio.ts`, Web Audio) toca — sons com mais de 6 frames de
  atraso são descartados (o modo seguir adianta sem rajada). Páginas de screenshot (`?paused=1`) ficam mudas.
- **Fim de jogo:** com status `won`/`lost` a simulação congela (câmera continua).
- **Troca de cena:** variáveis são mantidas; frame/tempo/eventos continuam acumulando.

## Runtime no browser (`packages/runtime`)

```
app/main.ts ── busca /api/projects/<nome> ─▶ parseProject ─▶ AssetStore.loadAll
     │
     ▼
Runtime ── Game (a mesma engine headless)
  ├─ FixedLoop      requestAnimationFrame → acumula tempo real → game.step(n) (máx. 5 frames/tick)
  ├─ attachDomInput teclado (KeyboardEvent.code) e ponteiro → Input virtual
  ├─ render()       buildDrawList(world) → paint(ctx) → paintDebug? → paintStatusOverlay
  └─ window.__vibe  controle externo (pause/step/perform/getState/...)
```

- **Renderização em duas fases.** `buildDrawList(world)` é pura: converte entidades em comandos em
  coordenadas de tela (câmera, zoom, escala, rotação, flip), descarta o que está fora da tela e ordena por
  `layer` (estável: empate mantém a ordem da cena). `paint(ctx, cmds)` só faz chamadas Canvas2D. Testes usam
  um contexto falso que grava as chamadas.
- **Formas e sprites.** Sem `asset`, desenha `rect`/`circle`/`triangle` com `color`. Com `asset`, desenha o
  frame no tamanho `width×height` do Sprite. Asset ausente/frame inválido → retângulo magenta + aviso único no
  console do jogo (`source: renderer`), para o agente perceber.
- **Texto.** `screenSpace: true` ancora no canto superior (HUD); `false` centraliza no mundo e segue a câmera.
  `
` quebra linha.
- **pixelArt.** Sem suavização de imagem, cantos alinhados ao pixel, CSS `image-rendering: pixelated`.
- **Fim de jogo.** `won/lost/crashed` desenham um banner (aparece também em screenshots); **R** reinicia.
- **Debug.** Colliders por cor (verde sólido, amarelo one-way, azul trigger, magenta dinâmico), ids e linha de
  status (frame, status, cena, fps, PAUSED).
- **Tempo real × controle externo.** Os dois chamam `game.step`. Com `?paused=1` o loop só redesenha, e o
  host avança o jogo explicitamente — mesma sequência de input ⇒ mesmo estado que no modo headless (testado).
- **Dev server.** Plugin Vite (`vite/projects-plugin.ts`) serve `GET /api/projects`, `GET /api/projects/<nome>`
  (JSON cru; a página valida) e `GET /projects/<nome>/assets/<arquivo>` (bloqueia `..`). Observa `projects/` e
  envia `vibe:project-changed` pelo WebSocket do Vite; a página recarrega o projeto (debounce de 80 ms, só o
  reload mais recente vale). Projeto inválido: a versão anterior continua rodando e os erros vão para o console
  e para `window.__vibeError`. Arquivos em `.vibe/` são ignorados.

## ProjectStore e tools (`packages/server`)

```
ToolRegistry.call(name, input, {store, author})
  └─ zod valida input ─▶ tool.run ─▶ store.edit(meta, tx => ...)
                                        │ Transaction: leituras veem escritas pendentes
                                        ▼
                                  commit: descarta no-ops
                                        → valida o projeto com as mudanças aplicadas
                                        → recusa se surgir erro novo (nada é gravado)
                                        → grava cada arquivo (tmp + rename; rollback se falhar)
                                        → acrescenta entrada em .vibe/history.jsonl
                                        → { seq, diff, warnings, remainingErrors }
```

- **Edita o JSON cru**, não o normalizado: arquivos continuam mínimos (sem defaults). A resposta das tools pode
  mostrar a versão efetiva (`get_game_object.effective`).
- **Relê o disco a cada operação**, então edições feitas fora (editor de texto) são sempre vistas — só não
  entram no histórico. Undo/redo verificam que os arquivos estão como a entrada deixou; se não, recusam.
- **Histórico só-acréscimo** (`.vibe/history.jsonl`, fora do git): cada entrada guarda autor (`user`/`agent`),
  tool, motivo, e o conteúdo completo antes/depois de cada arquivo. Undo e redo também são entradas; as pilhas
  são derivadas relendo o log (sobrevive a reinícios; linha final corrompida é ignorada).
- **Validação incremental:** só bloqueia erros *introduzidos* pela mudança, para o agente poder consertar um
  projeto quebrado aos poucos.
- **Formato canônico** (`formatJson`): containers que cabem em 110 colunas ficam numa linha.
- **Escrita atômica** com retry em `EPERM/EBUSY` (Windows: watchers e antivírus seguram arquivos).
- O runtime (`npm run dev`) observa `projects/` e recarrega a cada commit — o agente vê o efeito na hora.

## Comunicação agente ↔ runtime (`packages/server/src/runtime`)

```
Agent ─tool call─▶ ToolRegistry ─▶ RuntimeHost
                                     ├─ GameSession: Game headless + log de GameOp ─▶ estado, eventos, console
                                     └─ Screenshotter: Vite dev server + Chromium (Playwright)
                                          página ?paused=1 ◀─ projeto da run (route interception)
                                          __vibe.apply(ops novas) → canvas.screenshot() → PNG
```

- **GameOp** (`keyDown/keyUp/mouseMove/mouseDown/mouseUp/step/restart/loadScene`) é a unidade de controle.
  `Game.perform(steps)` expande os passos em ops (`expandInputSteps`) e aplica com `Game.apply(op)`; a run
  grava cada op aplicada. Reaplicar o log num jogo novo (mesmo projeto e seed) reproduz o estado exatamente.
- **Run headless** = fonte da verdade (estado, eventos, console). **Chromium** só para ver: a página recebe o
  JSON exato da run (não o disco, que pode ter mudado), reaplica as ops novas e fotografa o canvas. O host
  compara o estado do browser com o headless depois de cada foto.
- **Run desatualizada:** a run guarda o hash do projeto; se os arquivos mudam, as respostas trazem
  `projectChanged` até `restart_game`.
- **Observação incremental:** cada ação devolve os eventos e avisos novos desde a anterior (rastreados pelo
  último evento visto, não por frame — eventos do frame 0 surgem antes e depois do primeiro passo).
- **Avisos visuais:** problemas de asset só aparecem ao desenhar; o screenshot devolve `renderWarnings`, e o
  `ProjectStore` já avisa na validação quando o arquivo de um asset não existe.
- **Sandbox:** o agente só alcança o que as tools expõem — arquivos dentro do projeto, a run e a página do
  runtime. O Chromium só navega para o dev server local; nenhum input chega ao sistema operacional.
- O dev server é carregado com `configLoader: 'runner'` (a config importa `@vibe/server`, que é TypeScript sem
  build).

## Servidor MCP (`packages/server/src/mcp`)

```
Claude Code ──stdio──▶ main.ts ─▶ createVibeMcpServer(workspace)
                                   tools/list  → 3 tools de workspace + 38 do ToolRegistry (com annotations)
                                   tools/call  → workspace.require() → ToolRegistry.call(..., author: 'agent')
                                                 → texto (JSON compacto; diff em texto puro) + imagens (PNG)
```

- **Registro:** `.mcp.json` na raiz do repositório (servidor `vibe`, iniciado com `node --import tsx`; o caminho
  absoluto do `node.exe` evita depender do PATH do VS Code). `.claude/settings.json` habilita o servidor e libera
  as tools `mcp__vibe` sem pedir permissão a cada chamada (tudo é restrito a `projects/` e desfazível).
- **Instruções do agente:** o campo `instructions` do MCP (`mcp/guide.ts`) — o Claude Code o coloca no contexto
  do modelo: modelo de dados, geometria/física, como rodar/testar/fotografar, fluxo planejar → implementar →
  rodar → observar → testar → corrigir, e só declarar pronto o que foi verificado.
- **Workspace:** um projeto aberto por vez (`open_project`; com um único projeto ele abre sozinho;
  `create_project` cria `projects/<nome>` com uma cena `main` vazia). O processo vive a sessão inteira do Claude
  Code, então a run e o Chromium persistem entre chamadas; ao fechar, Chromium e Vite são encerrados.
- **Annotations:** `readOnlyHint` (consulta), `destructiveHint` (`delete_*`, `write_file`).
- **stdout é o protocolo:** logs vão para stderr. `VIBE_PROJECTS_DIR` troca a pasta de projetos (testes).

## Jogo dentro do VS Code

```
VS Code ── Simple Browser ── http://localhost:5173/?project=<p>[&live=1]
              ▲                       (dev server: `npm run dev`, a task "Vibe: abrir jogo"
              │ vibe:project-changed   ou o DevServer do processo MCP, via open_game_view)
              │ vibe:live-changed
Vite plugin ──┴── observa projects/   ◀── ProjectStore grava cenas
                                     ◀── RuntimeHost grava .vibe/live.json após cada ação da run
```

- **Sem extensão.** `.vscode/tasks.json` sobe o dev server (task em background) e abre o Simple Browser por um
  `input` do tipo `command` (`simpleBrowser.show`). `.vscode/settings.json` mapeia `localhost:5173` para o opener do
  Simple Browser, então o link devolvido por `open_game_view` abre no painel.
- **DevServer** (`server/src/runtime/dev-server.ts`): um Vite por processo, sob demanda, de preferência na 5173,
  compartilhado pelos screenshots e pela visualização. `open_game_view` reaproveita um dev server que já esteja
  respondendo `/api/projects` na 5173.
- **Modo seguir (`?live=1`).** Depois de toda tool com `changesRun` (no `finally`: um `wait_until` que estourou
  também andou), o `ToolRegistry` chama `RuntimeHost.publishLive()`, que grava `LiveRun` (`shared/src/live.ts`): id da
  run, seed, cena, frame, projeto cru e log de `GameOp`. O plugin serve `GET /api/projects/<p>/live` e emite
  `vibe:live-changed`. A página fica pausada e o `LivePlayer` (`runtime/src/live.ts`) reaplica as ops no ritmo do
  relógio (`FixedLoop`), quebrando `step`s longos em vários ticks. Se o atraso passa de 180 frames, adianta o excesso.
  Run nova (id diferente) → `Runtime.setProject(raw da run, {seed, scene})` e replay do zero. Como na foto, a
  reprodução é exata (mesmo projeto, seed e ops). O teclado da página vai para um `Input` descartável.
