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
+ `items/<id>.json` (catálogo de itens, V0.7) (+ `playbooks/<id>.json`: cenários de verificação, fora do jogo em si).
Memória do agente em `.vibe/memory.json`: itens (features, todos, issues, notas) e **planos** (V0.6, `update_plan`).
Um plano tem objetivo, tarefas em ordem com status, nota e evidência, e `verifyWith`, os playbooks que o provam. O
`verify` reusa `runPlaybooks`, o mesmo de `run_playbooks`, e só marca `verified` com todas as tarefas feitas e os
playbooks passando. É memória operacional: a engine não planeja.

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
| `AudioSource` | som da entidade: `clip`, `volume`, `loop`, `playing`, `spatial`, `falloff` (loop contínuo ou som único repetível; posicional) |
| `Traits` | personalidade: eixos 0..1 fixos ou sorteados pela seed; estáveis |
| `Preferences` | gostos por assunto (item, tag, contexto): inato (pode depender dos traços) + aprendido devagar; níveis love..hate |
| `Routine` | hábitos por hora do dia aprendidos do que a entidade faz (com esquecimento); `habit()` e `patterns()` |
| `Persist` | guarda `Traits`/`Preferences`/`Routine` no `game.storage` entre sessões e cenas |
| `Script` | comportamento em JavaScript (`scripts/*.js`): `onStart/onUpdate/onCollision` com API restrita |
| `Mover` | segue waypoints (vaivém ou loop, pausa); com Body kinematic vira plataforma móvel/elevador |

## Engine (`packages/engine`)

```
Game ── API pública: step/advance/perform/waitUntil/getState/events/console/restart/loadScene
 └── World ── entidades, vars, status (running|won|lost|crashed), eventos, câmera, checkpoints
      Passo fixo (1/60 s), nesta ordem:
        1. Input.beginFrame()        latch de teclas pressionadas entre frames
        2. IndividualRunner.init      Traits/Preferences: carrega o que está salvo (Persist) e sorteia o que falta
           ScriptRunner.start         onStart dos scripts que ainda não começaram (antes de qualquer outro hook)
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
           IndividualRunner.flush     grava no storage os indivíduos que mudaram
        7. flushDestroyed, cameraSystem
```

- **Física:** arcade, AABB, resolução por eixo contra sólidos (colliders não-trigger sem Body dinâmico).
  Kinematic se move primeiro; um corpo que estava apoiado nele (`groundId`) é levado junto (fica no topo e segue o
  deslocamento lateral). One-way compara com a posição anterior da plataforma, então plataforma subindo não é atravessada.
  Corpos dinâmicos não bloqueiam uns aos outros — sobreposição vira contato (dano, pisão).
  **Colisão contínua (V0.6):** cada eixo é varrido antes de mover (`sweep`). O corpo para na primeira face sólida que
  o caminho cruza, por mais fino o sólido e por mais rápido o corpo. Depois a resolução de sobreposição antiga trata o
  resto: corpos empurrados por plataformas e one-way subindo. One-way só segura quem cai sobre o topo.
- **Contatos:** pares sobrepostos (tolerância 0,5 px, então “encostar” conta). Goal/Checkpoint usam
  semântica de *enter* (só no primeiro frame de contato). Quem a física moveu mais de meio collider no frame (corpo
  rápido, projétil kinematic) usa a caixa varrida do movimento (`contactBox`, de `Entity.sweptFrom`). Assim não pula
  moeda, gatilho, dano ou objetivo entre dois frames. Teleporte (script ou regra mudando a posição) não é caminho.
  Dois corpos rápidos se cruzando no mesmo frame não são varridos um contra o outro.
- **Eventos:** `jump, collect, damage, stomp, death, fell, respawn, checkpoint, goal, goal_blocked, win,
  lose, scene_loaded, crash, script_error, click, interact, interact_blocked, state_change, state_error, ai_choice, ai_error, anim_end, timer_error, tween_end, nav_arrived, nav_failed, particles, individual, persist_error, item_used, inventory_change, currency_change, purchase, purchase_failed` (e os eventos de quadro do `Animator`) e os que scripts emitem — registrados com o frame, consultáveis por
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
- **AudioSource** (V0.6, `engine/src/audio-source.ts`): som por entidade, também fora da simulação.
  - Som único: `audioSourceSystem` emite `sound` com `entity`, volume e pan já mixados quando `playing` fica `true`,
    e volta a `playing` para `false`.
  - Loop: é estado, não evento. `audioVoices(world)` é pura (como `buildDrawList`) e lista o que deve soar agora.
    A cada quadro, o `Runtime.onFrame` passa essa lista ao `SoundPlayer.updateVoices`, que inicia, para e ajusta
    volume e pan (`StereoPanner`, com rampa curta).
  - Espacial: o ouvinte é o centro da câmera (`listenerOf`); o volume cai linearmente até `falloff` e o pan segue o
    deslocamento horizontal.
  - O snapshot da entidade mostra `audio {clip, loop, playing, volume, pan}`.
- **Relógio e dados salvos** (`engine/src/clock.ts`, `storage.ts`): `GameClock` é a data/hora do calendário, separada do
  tempo de simulação: avança `speed` ms por ms simulado (âncora + frames inteiros, sem erro acumulado) e pula com a op
  `advanceClock`. `GameStorage` guarda JSON. Ambos voltam ao início no `restart`. Runs headless começam numa data fixa
  e com os dados passados ao `run_game`; o screenshot e o modo seguir recebem os mesmos valores (determinismo). A
  página jogada usa a data real, uma seed aleatória por sessão e grava os dados em disco
  (`GET/PUT/DELETE /api/projects/<p>/save` → `.vibe/save.json`, gravação adiada 0,5 s e garantida no `pagehide`), com
  cópia no `localStorage`; se frames forem pulados (aba em segundo plano), soma o tempo perdido com `advanceClock`
  (`realtimeClock`).
- **Save slots** (V0.6, `engine/src/saves.ts`):
  - Formato: `GameSaves` guarda `SaveSlot { version, label?, savedAt, scene, storage, state }`, onde `state` é o
    `captureHotState` só com os prefabs das entidades criadas em jogo.
  - Carregar: `Game.loadSlot` só marca o pedido; no fim do frame, `applySlot` substitui o storage
    (`GameStorage.replace`), refaz a cena e chama `restoreHotState(..., { keepTime })`. O frame continua avançando, e
    os tempos medidos em frames (entrada na FSM, início das regras) são deslocados.
  - Hosts: como o `storage`, vem de `GameOptions.slots` e as mudanças saem por `onSlotsChange`. A página grava em
    `.vibe/slots.json` (`/api/projects/<p>/slots`). As runs do agente, o screenshot e o modo seguir recebem os mesmos
    slots (determinismo). `restart` volta aos slots iniciais.
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
- **Indivíduos** (V0.7, `engine/src/individual.ts`): `Traits` (eixos 0..1), `Preferences` (afinidade -1..1 por assunto =
  inato + aprendido) e `Persist` (chave do storage). `IndividualRunner` por mundo: no começo do frame, antes de qualquer
  `onStart`, carrega os valores salvos e sorteia o que falta (`ensure`, também chamado sob demanda por scripts e
  expressões, para entidades que surgem no meio do frame); no fim do frame grava as entidades marcadas. Os valores
  sorteados vão para os próprios dados do componente, então snapshot, hot reload e save slots os veem como qualquer
  campo. O sorteio usa um `Rng` próprio (hash de seed + id + `clock.now`): reproduzível, diferente para um indivíduo
  criado mais tarde na mesma sessão (o `Rng` do mundo recomeça a cada cena) e sem mexer em `game.random()`.
  `evaluate(assunto, tags)` combina a afinidade do assunto com a média das tags; `learn` move só a parte aprendida,
  com limite. Expressões: `trait()` e `likes()`.
- **Alvos na Utility AI** (V0.7): uma opção com `targets {tag, when?}` é avaliada uma vez por candidato (entidades ativas com a
  tag, menos a própria), com `target` no escopo da expressão (`ExprScope.target`); o melhor candidato dá a nota da opção.
  `AiState` guarda `target` e `targets`; uma decisão nova é escolha **ou** alvo diferente. `weighted` usa
  nota^`sharpness` nas opções e também no alvo da opção escolhida (o melhor candidato ganha quase sempre, não sempre;
  `targets` continua mostrando o melhor). Custo: opções × candidatos por decisão (dezenas).
- **Rotina** (V0.7, `engine/src/routine.ts`): pesos por atividade × faixa do dia em `Routine.values`, com decaimento
  exponencial aplicado no próximo `record` (`updatedAt`); `habit`/`peak`/`patterns` só leem. Persistida pelo
  `IndividualRunner` junto com traços e gostos.
- **Itens** (V0.7, `engine/src/items.ts`): `Project.items` (de `items/<id>.json`) vira um `ItemCatalog` só de leitura no
  `Game`. `Game.useItem(item, alvo, por?)` emite `item_used` e chama `ScriptRunner.itemUsed` → hook `onItem` do alvo,
  devolvendo o retorno do hook (clonado como JSON). A engine não interpreta o item: o alvo decide, normalmente pelo
  `evaluateItem` das suas `Preferences` (id + categoria + tags, combinadas por `subjectWeight` e `tagBlend`).
- **Economia** (V0.7, `engine/src/economy.ts`): `Economy` no `Game` (não por cena), sobre o `GameStorage` e o
  `ItemCatalog`: inventários (`vibe.inventory`), carteiras (`vibe.wallet`) e `buy` (preço do catálogo → `spend` →
  `add`). Cada operação lê e grava o storage (dados pequenos), então save slots, hot reload e `restart` valem sem código
  extra. `World.economy` aponta para ela para as ações de regra (`giveItem`, `takeItem`, `addCurrency`); os eventos vão
  para o mundo atual. `getState` traz `inventories` e `wallet`.
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
  ├─ render()       buildDrawList(world) → paint(ctx) → paintDebug? → paintSelection? → paintStatusOverlay
  └─ window.__vibe  controle externo (pause/step/perform/getState/...)
app/hierarchy-panel.ts ── buildHierarchy(game, project) a cada 250 ms ─▶ seleção ─▶ PUT /api/projects/<p>/selection
```

- **Hierarquia** (V0.5, `runtime/src/hierarchy.ts` + `app/hierarchy-panel.ts`): `buildHierarchy` é puro e só lê —
  cena atual a partir do `World` (entidades criadas, destruídas e desativadas aparecem marcadas), demais cenas a partir
  do projeto; `entityKind` classifica cada entidade (jogador, inimigo, coletável, zona, sólido...) por tags e
  componentes. O painel redesenha só quando `hierarchyKey` muda. A seleção vira `Runtime.selected`, desenhada por
  `paintSelection` por cima do jogo (nunca entra na simulação), e é gravada em `.vibe/selection.json`
  (`EditorSelectionSchema`, `shared/src/editor.ts`) para o agente (`get_selection`). Páginas de host (`?paused=1`,
  screenshots) não têm painéis.
- **Inspector** (V0.5, `server/src/inspector.ts` + `app/inspector-panel.ts`): o lado Node (plugin do Vite,
  `GET/POST /api/projects/<p>/inspect`) descreve a entidade em campos tipados — `z.toJSONSchema` de cada componente
  (enum, número com limites, boolean, asset, cor, listas, JSON) + dados efetivos (prefab + padrões), marcando o que
  está no arquivo (`set`) e o que vem do prefab. Edições viram um merge patch (`inspectorPatch`; objetos são
  substituídos com `replacePatch`) aplicado pela tool `modify_game_object` com autor `user`: mesma validação,
  gravação atômica, histórico e undo do agente. A página só renderiza e mostra os valores ao vivo
  (`game.getState`). O `History` relê `.vibe/history.jsonl` quando o tamanho muda, então o servidor MCP e o dev
  server compartilham o log (seqs não colidem; o agente desfaz edições do usuário).
- **Viewport** (V0.5, `runtime/src/viewport.ts` + `app/viewport-controller.ts`): modo edição da página jogada. O
  `Runtime.editor` (`{ view, drag }`) troca a câmera do desenho: `buildDrawList`, `paintDebug` e `paintSelection`
  recebem a câmera como parâmetro (padrão: a do jogo). A prévia do arrasto desloca só os comandos de desenho da
  entidade (`offsetDrawList`). Nada disso toca o `World`. Seleção por `pickAt` (o `stackAt` da engine, por cima a
  selecionada). O movimento é a edição `move { dx, dy }` do inspector (mesma rota, `modify_game_object` como `user`),
  e o hot reload mostra a posição nova. No modo edição o jogo fica pausado, sem input (como em "Seguir agente"), e
  reinicia na cena editada.
- **Hot reload com estado** (V0.6, `engine/src/hot-state.ts`):
  - `captureHotState(game)` gera JSON puro com cena, frame/tempo, variáveis, câmera, posição do `Rng`, memória do
    `RuleRunner` (`saveState`/`loadState`), as entidades destruídas da cena e, para cada entidade, o que o arquivo
    antigo dizia (`authored`), o estado em jogo (`live`) e o estado da FSM. Também guarda os prefabs antigos.
  - `restoreHotState(game, state)` roda num `Game` recém-criado com os arquivos novos, antes do primeiro passo. Cada
    valor sai de `merge3(antigo, novo, live)`: se o arquivo não mudou o valor, vale o live; se mudou, vale o novo.
    Objetos são fundidos chave a chave, e chaves criadas em jogo são mantidas.
  - Entidades criadas em jogo são refeitas com o mesmo merge sobre o prefab (prefab apagado: a entidade é
    descartada).
  - Timers, tweens, partículas e `self.state` não são serializáveis. O `onStart` dos scripts roda de novo e os
    reconstrói.
  - Só a página jogada usa isso. As runs do agente continuam sendo replay determinístico (projeto + seed + ops).
- **Asset browser** (V0.5, `server/src/asset-catalog.ts` + `app/asset-panel.ts`): `buildAssetCatalog(store)` lê os
  assets declarados e os arquivos. As dimensões saem do cabeçalho (`imageSize`: PNG, GIF, JPEG, WebP, SVG), e a
  duração do WAV de `wavSeconds`. O catálogo aponta arquivos ausentes, quadros que não fecham e arquivos não
  declarados, e diz onde cada item é usado. Para isso percorre as strings do JSON de config, cenas e prefabs (ignorando
  `id`, `name`, `tags`; prefabs só na chave `prefab`, scripts na `src`) e procura o id entre aspas nos scripts. O mesmo
  catálogo vai ao agente (`list_assets`) e à página (`GET /api/projects/<p>/assets`). A página só mostra e chama
  edições do usuário: `Sprite.asset` pela rota do inspector e `placePrefab` (`POST .../assets`,
  `create_game_object` como `user`).

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
- **Observação unificada** (V0.4): `observe` junta `GameSession.observe()` (eventos/console incrementais, players),
  `Game.getState({onScreen})` e `RuntimeHost.screenshot()`. `Game.screenBoxOf(e)` dá a caixa de uma entidade no
  viewport (ou null se fora da tela ou não desenhada) — base também para percepção do mouse.
- **Percepção do mouse** (V0.4, `engine/src/mouse.ts`): `Game.mouseTarget()` calcula sob demanda a pilha sob o mouse
  (`stackAt`, mesma ordem do clique), o alvo do clique (`InteractionRunner.clickTargetAt`, a regra do clique real) e,
  sem efeitos, se um `Interactable` aceitaria (`clickInfo`, que reusa o `check` das tentativas). O último clique fica em
  `Game.lastClick` (sobrevive a trocas de cena). Expressões ganham `mouse`; scripts, `game.input.hovered`.
- **Controle do mouse** (V0.4): passos `doubleClick` e `drag` (e `mouseMove {entity}`) expandem para as ops
  primitivas de sempre (`expandInputSteps`; `Game.expand` resolve entidades em pontos da tela). Os gestos são
  percebidos no início do frame por `InteractionRunner.gestures()`: duplo clique (≤ 18 frames, ≤ 6 px), arrasto
  (> 4 px com o botão segurado) → `drag_start`/`drag_end`, e entidades com tag `draggable` seguem o mouse.
- **Diagnóstico** (V0.3, `server/src/runtime/diagnosis.ts`): `diagnose(game, project, scripts, falhas, erros)` extrai
  das checagens que falharam as entidades, variáveis e eventos citados (parse leve das expressões ou campos das
  asserções), junta evidências do `World`, dos eventos, das regras/scripts/`Collectible` que escrevem as variáveis e da
  linha do tempo, e pontua sistemas por sinais (tabelas componente → sistema, evento → sistemas, origem do console →
  sistema). Nada específico de jogo.
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
                                   tools/list  → 3 tools de workspace + 66 do ToolRegistry (com annotations)
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
