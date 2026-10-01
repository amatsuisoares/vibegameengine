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

Em disco: `projects/<nome>/project.json` (config) + `scenes/<id>.json` + `scripts/**/*.js` + `prefabs/<id>.json`
(+ `playbooks/<id>.json`: cenários de verificação, fora do jogo em si).
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
| `Text` | texto/HUD com placeholders `{coins}`, `{player.health}`; `opacity` |
| `Animator` | clipes (quadros de spritesheet ou imagens); clipe pelo estado da `StateMachine` ou idle/run/jump/fall; eventos de quadro, one-shots, velocidade |
| `Interactable` | algo que se usa (porta, NPC, tigela): por clique, tecla em alcance ou entrada; condição, cooldown, once, som |
| `StateMachine` | estados nomeados com transições por condição, tempo no estado ou evento; ações de entrada/saída |
| `UtilityAI` | escolhe o que fazer pela nota de cada opção (expressões); entra no estado correspondente |
| `NavAgent` | anda até um alvo (entidade ou ponto) por um caminho A* em grade, desviando de sólidos (visão de cima) |
| `ParticleEmitter` | partículas visuais (taxa contínua e rajadas, gravidade, arrasto, fade, cores, glifos) |
| `Script` | comportamento em JavaScript (`scripts/*.js`): `onStart/onUpdate/onCollision` com API restrita |
| `Mover` | segue waypoints (vaivém ou loop, pausa); com Body kinematic vira plataforma móvel/elevador |

## Engine (`packages/engine`)

```
Game ── API pública: step/advance/perform/waitUntil/getState/events/console/restart/loadScene
 └── World ── entidades, vars, status (running|won|lost|crashed), eventos, câmera, checkpoints
      Passo fixo (1/60 s), nesta ordem:
        1. Input.beginFrame()        latch de teclas pressionadas entre frames
        2. ScriptRunner.start         onStart dos scripts que ainda não começaram (antes de qualquer outro hook)
           controllerSystem           PlatformerController, Patrol, FollowTarget
           moverSystem                Mover: velocidade dos kinematic rumo ao próximo waypoint
           NavRunner.run              NavAgent: planeja/replaneja (A*) e anda (posição, ou velocidade do Body)
           InteractionRunner.input    clique esquerdo (click, onClick) e tecla de interação → Interactable
           ScriptRunner.update        onUpdate dos scripts (onStart antes, se a entidade surgiu neste frame)
        3. physicsSystem              gravidade; move X e resolve; move Y e resolve (grounded)
        4. findContacts + interactionSystem   coleta, pisão, dano, checkpoint, goal
           ScriptRunner.collisions    onCollision dos contatos que começaram neste frame
           InteractionRunner.proximity  Interactable via "enter" (ator entrou no alcance) + foco da tecla
        5. healthSystem               timers, queda no abismo (killY), morte
        6. RuleRunner.run             regras da cena (start/event/enter/expr/every → if → ações)
           UtilityRunner.run          decisões da UtilityAI que venceram o intervalo (→ StateMachine.go)
           StateMachineRunner.run     estado inicial e transições das StateMachines (exit → state_change → enter)
           Scheduler.run              timers vencidos (self.after/every, ações "after" de regras e estados)
           TweenRunner.run            um passo de cada tween (valor = from + (to - from) × ease(t))
           ParticleSystem.run         emissores (rajada inicial, taxa) e movimento/vida das partículas
           animationSystem            flip; clipe do Animator (script > estado > auto > base), quadro, eventos de quadro
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
  lose, scene_loaded, crash, script_error, click, interact, interact_blocked, state_change, state_error, ai_choice, ai_error, anim_end, timer_error, tween_end, nav_arrived, nav_failed, particles` (e os eventos de quadro do `Animator`) e os que scripts emitem — registrados com o frame, consultáveis por
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
- **Relógio e dados salvos** (`engine/src/clock.ts`, `storage.ts`): `GameClock` é a data/hora do calendário, separada do
  tempo de simulação: avança `speed` ms por ms simulado (âncora + frames inteiros, sem erro acumulado) e pula com a op
  `advanceClock`. `GameStorage` guarda JSON. Ambos voltam ao início no `restart`. Runs headless começam numa data fixa
  e com os dados passados ao `run_game`; o screenshot e o modo seguir recebem os mesmos valores (determinismo). A
  página jogada usa a data real, uma seed aleatória por sessão e grava os dados em disco
  (`GET/PUT/DELETE /api/projects/<p>/save` → `.vibe/save.json`, gravação adiada 0,5 s e garantida no `pagehide`), com
  cópia no `localStorage`; se frames forem pulados (aba em segundo plano), soma o tempo perdido com `advanceClock`
  (`realtimeClock`).
- **Mouse e texto:** o clique esquerdo vai para a entidade de cima sob o ponto onde o botão desceu (posição guardada no
  pressionamento, não a atual) e gera o evento `click`. Texto digitado chega como op `text` (com `\b`/`\n` em ordem).
- **Clique em entidade:** `Game.expand({type: 'click', entity})` mira o centro da caixa da entidade na tela no momento
  do passo e vira `mouseMove` + clique comuns — o agente clica "no objeto" e o log de ops continua reproduzível.
- **Interações** (`engine/src/interact.ts`, V0.2): `InteractionRunner` por mundo, como regras e scripts. A engine só
  decide **se** um `Interactable` é usado — clique (o mesmo roteamento do `onClick`), tecla (`key`, padrão a ação
  `interact` = E) pelo ator mais próximo dentro de `range` (distância entre caixas Collider/Sprite), entrada no alcance
  (borda, uma vez por aproximação) ou `game.interact(alvo, ator?)` num script — checando, nesta ordem, `enabled`,
  `actorTags`, `range`, `cooldownMs` e `condition` (expressão compilada uma vez). Sucesso: evento `interact`, `sound`,
  `once` desliga, hook `onInteract`; falha: `interact_blocked {reason}`. O efeito é do jogo (regras com `$by`/`$entity`,
  scripts). Estado em `Entity.interact` (`readyAt` em frames, `uses`) e no snapshot (`interactable`, com `inRange`).
  `World.interactFocus` guarda o alvo da tecla para o renderer desenhar `[E] rótulo`. Laço `onInteract` →
  `game.interact` é cortado em 8 níveis.
- **Máquinas de estado** (`engine/src/fsm.ts`, V0.2): `StateMachineRunner` por mundo, depois das regras. Estado vivo em
  `Entity.fsm` (`state`, `previous`, `since` = frame de entrada; criado do `initial`, entra no primeiro frame). Por frame
  e entidade: transições "de qualquer estado" e depois as do estado atual; a primeira com `after` (frames no estado),
  `event` (eventos novos do frame, lidos por contagem como nas regras; `"$self"` no `match`) e `when` (expressão com
  `self`) satisfeitos é tomada — no máximo uma por frame, ida ao próprio estado é ignorada. Troca: ações `exit`, evento
  `state_change {entity, from, to}`, ações `enter` (target `"$self"`), hook `onStateChange`. Scripts usam `self.fsm`
  (`state`, `previous`, `time`, `is`, `go`); `go` troca na hora. Erro → `state_error`, máquina daquela entidade
  desligada até recarregar a cena. Trocas aninhadas (onStateChange → go...) param em 8 níveis.
- **Utility AI** (`engine/src/utility.ts`, V0.2): `UtilityRunner` por mundo, entre as regras e as máquinas de estado.
  Cada decisão avalia as opções (`when`, cooldown contado de quando a opção deixou de ser a escolha, `score` compilado
  uma vez), guarda as notas em `Entity.ai.scores` (aparecem no snapshot) e escolhe por `best` (+ `inertia` da escolha
  atual) ou `weighted` (RNG do mundo); `noise` também usa a RNG — tudo reproduzível pela seed. Escolha nova →
  `ai_choice`, `StateMachineRunner.go` (estado com o nome da opção ou `state`) e `onDecision`. Decide a cada
  `intervalMs` (com `decideWhen`) ou sob demanda (`self.ai.decide()`, `intervalMs: 0`). Os `Script.props` entram no
  snapshot, então as notas leem necessidades e personalidade por entidade (`self.props.fome`).
- **Animação** (`engine/src/systems/animation.ts`, V0.2): roda depois das máquinas de estado, então o clipe já reflete o
  estado do frame. Escolha do clipe: o tocado por script (`self.anim.play`, `Entity.animOverride`) > o do estado
  (`states[estado]` ou clipe com o nome do estado) > automático pelo corpo (idle/run/jump/fall) > o clipe base
  (`initial`, que segue `next` quando um one-shot termina). O tempo avança `dt × speed`; `animStep` (passos de quadro
  já mostrados) garante que eventos de quadro não se percam quando o fps passa de 60. Quadro numérico = índice da
  spritesheet (do `Sprite` ou do `asset` do clipe); texto = id de imagem, trocado em `Sprite.asset`. O render não
  mudou: só lê `Sprite.asset`/`frame`.
- **Timers** (`engine/src/timers.ts`, V0.2): um `Scheduler` por `World` (`world.timers`). Cada timer tem id, frame em
  que dispara, período opcional (frames, mínimo 1) e dono opcional (entidade): de dono destruído é descartado; de dono
  desligado espera. Vencidos disparam em ordem (frame, criação); um timer cancelado por outro no mesmo frame não
  dispara. Mesmo id (por dono) substitui. Cooldowns de script ficam em `Entity.cooldowns` (frame em que libera).
  Timers não sobrevivem a troca de cena/restart (o mundo é recriado), como o resto do estado de cena.
- **Tweens** (`engine/src/tweens.ts`, V0.2): `TweenRunner` por `World` (`world.tweens`). Cada tween conta frames
  jogados (o primeiro passo é no frame em que começa); `yoyo` dobra o ciclo, `repeat` multiplica (`-1` sem fim); no fim
  grava o valor exato (`to`, ou `from` com yoyo). `tweenProp` resolve `x/y/rotation/scale*/opacity` e
  `Componente.campo` numérico. O `Text` ganhou `opacity` (o render aplica `globalAlpha`; texto com 0 não é desenhado).
- **Pathfinding** (`engine/src/nav.ts`, V0.2): `findPath(world, de, para, opções)` monta a grade na hora (cena ÷
  `cell`; bloqueia células cujo centro poria a caixa do agente dentro de um sólido ou de uma entidade com `avoidTags`),
  roda A* (heap binário; desempate por f, h e ordem de inserção) e comprime o caminho nos pontos de curva. O
  `NavRunner` (por mundo, antes da física) guarda em `Entity.nav` o alvo planejado, status, pontos e o próximo
  replanejamento; chegar = esgotar o caminho. Sem cache de grade: custo O(entidades + células) por plano, ok para cenas
  pequenas/médias. `paintDebug` desenha o caminho restante.
- **Partículas** (`engine/src/particles.ts`, V0.2): `ParticleSystem` por `World` (`world.particles`), lista plana de
  partículas (posição, velocidade, idade/vida, tamanho, cor, forma/glifo, gravidade, arrasto, camada, emissor). RNG
  própria (`reseed(seed)` a cada cena), então efeitos não mudam a RNG do jogo. `buildDrawList` converte partículas
  visíveis em `SpriteCmd`/`TextCmd` (id `particle`), com tamanho e opacidade interpolados pela idade.
- **Ações data-driven** (`engine/src/actions.ts`): `runAction` executa as ações de regras e de estados (mesmo
  conjunto: setVar, emit, modify, spawn...); a origem (`rule`/`state`) vai nos eventos e logs.
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
- **Cenários** (`server/src/runtime/scenario.ts`, V0.3): `runScenario(session, steps, assertions, shoot?)` executa
  passos de input, `waitUntil`, `assert`, `advanceClock` e `screenshot` numa `GameSession` avulsa
  (`RuntimeHost.newSession`, que não substitui a run atual) e devolve as checagens (`expr`, `pass`, `observed`, `frame`).
  É usado pelo `run_test` e pelo `verify_game`; este ainda fotografa a sessão (`RuntimeHost.screenshotOf`, que serve
  para qualquer sessão) e monta o relatório PASS/FAIL (`tools/verify-tools.ts`). Erros de runtime reprovam por padrão.
- **Asserções estruturadas** (V0.3): schema `AssertionSchema` em `shared/src/assertions.ts` (união discriminada por
  `assert`, validável em arquivos de playbook); `checkAssertion(game, a)` em `engine/src/assertions.ts` lê o `World`
  direto (entidades, componentes, FSM, vars, eventos, cena, status) e devolve `{pass, label, expected, actual,
  evidence}`. Uma checagem de cenário é `{expr}` ou `{check}`.
- **Playbooks** (V0.3): `PlaybookSchema` (`shared/src/playbook.ts`, junto com os schemas de passos) é a entrada do
  `verify_game` e o formato de `playbooks/<id>.json`. O `ProjectStore` valida todo arquivo de playbook em qualquer
  escrita (não entram em `rawProject`, então não deixam a run desatualizada) e os lê com `playbooks()`.
  `verifyScenario` (`tools/verify-tools.ts`) executa um playbook; `run_playbooks` o chama para cada arquivo.
- **Avisos visuais:** problemas de asset só aparecem ao desenhar; o screenshot devolve `renderWarnings`, e o
  `ProjectStore` já avisa na validação quando o arquivo de um asset não existe.
- **Sandbox:** o agente só alcança o que as tools expõem — arquivos dentro do projeto, a run e a página do
  runtime. O Chromium só navega para o dev server local; nenhum input chega ao sistema operacional.
- O dev server é carregado com `configLoader: 'runner'` (a config importa `@vibe/server`, que é TypeScript sem
  build).

## Servidor MCP (`packages/server/src/mcp`)

```
Claude Code ──stdio──▶ main.ts ─▶ createVibeMcpServer(workspace)
                                   tools/list  → 3 tools de workspace + 54 do ToolRegistry (com annotations)
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
