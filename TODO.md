# Roadmap

## ✅ Etapa 1 — Fundação (concluída)
- [x] Monorepo npm workspaces + TypeScript + Vitest
- [x] Schemas zod: projeto, cena, entidade, 14 componentes built-in, assets
- [x] Validação semântica com mensagens legíveis para o agente
- [x] Engine headless: passo fixo, física AABB, one-way, input virtual com latch, câmera
- [x] Gameplay: controle de plataforma, patrulha, perseguição, vida, dano, pisão, coleta, checkpoint, goal, troca de cena
- [x] Estado estruturado, eventos, console, determinismo (seed)
- [x] Projeto demo (hoje fixture dos testes em `test-fixtures/demo-platformer`)
- [x] 45 testes

## ✅ Etapa 2 — Renderer + runtime no browser (concluída)
- [x] Renderer Canvas2D (formas, sprites, spritesheets, texto/HUD, camadas, câmera, rotação/escala, pixel art)
- [x] Loader de assets (imagens, spritesheets; SVG suportado) + validação de assets
- [x] Página runtime (Vite) que carrega um projeto e roda em tempo real com teclado/mouse
- [x] API `window.__vibe` (step, input, getState, events, console) para controle externo
- [x] Overlay de vitória/derrota/crash; modo debug (colliders, ids, status)
- [x] Hot reload ao editar arquivos do projeto; erros de validação no console
- [x] Demo com sprites animados (herói e moedas) e teste "o demo é vencível"
- [x] 92 testes unitários + 4 testes e2e no Chromium (pixels, API, teclado real, hot reload)

## ✅ Etapa 3 — ProjectStore + tools de edição (concluída)
- [x] Leitura/gravação de projeto em disco, com escrita atômica e rollback
- [x] Histórico: cada alteração com diff, autor (user/agent), tool, motivo; undo/redo com detecção de conflito
- [x] 23 tools de projeto/cena/entidade/componente/arquivo/histórico + JSON Schema no formato de tool use
- [x] Validação do projeto inteiro a cada alteração (só bloqueia erros novos)
- [x] JSON canônico (diffs mínimos); CLI `npm run vibe`
- [x] 122 testes unitários + e2e: edição por tool aparece ao vivo no browser e é desfeita

## ✅ Etapa 4 — RuntimeHost (concluída)
- [x] Sessões de jogo headless (run/stop/restart/input/wait/wait_until/state/console/events), 14 tools de runtime
- [x] Observação incremental após cada ação; aviso de run desatualizada (`projectChanged`)
- [x] Linguagem de expressões segura (sem eval) com valores observados nas falhas
- [x] `run_test` com passos `waitUntil`/`assert` e asserções finais
- [x] Screenshots via Playwright (Chromium headless) por replay de `GameOp`, opção anotada, checagem de divergência
- [x] Avisos de asset ausente na validação e no screenshot; CLI `script` para várias tools numa run
- [x] Leitura de projeto unificada (dev server usa o `ProjectStore`)
- [x] 137 testes unitários + 7 e2e no Chromium

## ~~Etapa 5 — Agente embutido (API)~~ — removida
O agente via API da Anthropic foi implementado e depois removido: o agente passou a ser o Claude Code (Etapa 6).

## ✅ Etapa 6 — Claude Code como agente (MCP) (concluída)
- [x] Servidor MCP `vibe` (stdio) expondo as 38 tools + `list_projects`/`open_project`/`create_project`
- [x] `.mcp.json` + `.claude/settings.json` (servidor habilitado, tools liberadas)
- [x] Instruções do agente no `instructions` do MCP; screenshots como imagem; diffs em texto
- [x] Run e Chromium persistem durante a sessão; encerrados ao fechar
- [x] Testes: cliente MCP em memória + servidor lançado com o comando do `.mcp.json` (141 unitários, 8 e2e)
- [x] Teste real: tools usadas pelo chat (quarta moeda no demo, coletada pulando, HUD ajustado)

## ✅ Etapa 7 — Jogo dentro do VS Code (concluída)
- [x] Runtime num painel do VS Code (Simple Browser) com hot reload: tasks "Vibe: abrir jogo" / "Vibe: seguir agente"
- [x] Tool `open_game_view` (URL do projeto/cena; sobe o dev server se preciso) + links `localhost:5173` no Simple Browser
- [x] Espelhar no painel a run do agente em tempo real (`.vibe/live.json` + `LivePlayer`, modo `?live=1`)
- [x] Testes: `LivePlayer`, publicação da run, rota `/live`, `open_game_view`, e2e do modo seguir no Chromium
- [x] Teste real no VS Code: task "Vibe: abrir jogo" (com o caminho absoluto do node, como no `.mcp.json`)
- [x] Extensão leve (hierarquia/inspector): adiada — o Simple Browser bastou; reavaliar se fizer falta

## ✅ Etapa 8 — Memória + extensões do MVP (concluída)
- [x] Memória do projeto (`.vibe/memory.json`: resumo, features, todos, issues, notas) + `read_memory`/`update_memory`
- [x] Componente `Script` (hooks onStart/onUpdate/onCollision) com API restrita, determinístico, erros com arquivo:linha
- [x] Áudio e assets: `import_asset` (imagens/spritesheets/áudio do disco), `create_sound` (efeitos gerados em WAV),
  `config.sounds` (evento → som), `scene.music`, `playSound` em regras e scripts; o browser toca (Web Audio)
- [x] Eventos/condições data-driven: regras da cena (`start/event/enter/expr/every` → `if` → ações) + `set_rule`/`delete_rule`
- [x] Prefabs (`prefabs/<id>.json`): instâncias por merge patch, `spawn` em regras e scripts, `create/modify/delete_prefab`
- [x] Plataformas móveis: componente `Mover` (waypoints, vaivém/loop, pausa); física carrega quem está em cima
  (inclusive one-way subindo)
- [x] Demo com sons gerados (`create_sound`) mapeados em `config.sounds`
- [x] 191 testes unitários + 11 e2e no Chromium (scripts e sons no browser, modo seguir)

## Etapa 10 — Jogo de pet virtual (em andamento)
Jogo da usuária: pet virtual observacional (só os sprites de `mypetgame/assets` são reaproveitados). Desenho aprovado:
o pet não fala (notificações observacionais com cooldown), necessidades escondidas, personalidade inferida pelo
comportamento, um quarto, interações com o mouse, evolução bebê → juvenil → adulto, tempo real + velocidade, sem morte.
- [x] Engine: `onClick`/`onEvent`, texto digitado, mouse no mundo, `entityAt`, escala/rotação em scripts
- [x] Engine: relógio do calendário (`game.clock`, velocidade, `advance_clock`) e dados salvos (`game.storage`, em disco
  em `.vibe/save.json` pelo dev server + cópia no localStorage); seed aleatória por sessão no jogo jogado
- [x] 198 testes unitários + 13 e2e (teclado, clique, save após reload, replay com relógio e dados)
- [x] Jogo `projects/meu-pet` construído pelas tools do `vibe`: telas início/quarto/coleção, cérebro do pet
  (`scripts/pet.js`), observações com cooldown, interações, evolução em 9 formas, tempo real + velocidade, save
  em disco, coleção de pets anteriores ("pokédex")
- [ ] Ajustes a partir do teste da usuária (balanceamento, visual, arte de dormir/comer)

## ✅ V0.2 — Engine orientada a comportamento (concluída)
Roadmap de evolução: cada sistema só avança com testes passando. Sistemas genéricos na engine; regras de cada jogo
ficam no projeto. O `meu-pet` valida os sistemas (sem nada específico dele na engine).
- [x] **Interaction System**: componente `Interactable` (ação, rótulo, via click/key/enter, alcance, condição,
  cooldown, once, som), eventos `interact`/`interact_blocked`, hook `onInteract`, `game.interact`/
  `game.nearbyInteractables`, alvo `$entity` nas regras, ação `interact: ["E"]` no padrão, prompt `[E] rótulo` no
  render, `interactable` no estado, clique por `entity` (`click_mouse`, `perform_inputs`, `run_test`, `__vibe.perform`)
- [x] meu-pet: tigela, bola, lâmpada, sujeira e pet viraram `Interactable` (onInteract); teste de regressão do jogo
- [x] 223 testes unitários + 15 e2e (antes: 199 + 13)
- [x] **State Machine**: componente `StateMachine` (estados com `enter`/`exit`, transições por `when`/`after`/`event`,
  transições de qualquer estado), evento `state_change`/`state_error`, `self.fsm` e `onStateChange` nos scripts,
  `state`/`stateMs`/`prevState` no estado, `self` e `distance()` nas expressões; ações de regras e estados num executor
  comum (`actions.ts`)
- [x] meu-pet: as 14 atividades do pet são estados da `StateMachine` (sincronizadas pelo `pet.js`); regressão cobre
- [x] 240 testes unitários + 15 e2e
- [x] **Utility AI**: componente `UtilityAI` (opções com `score`/`when`/`cooldownMs`/`state`, `best` com inércia ou
  `weighted`, `intervalMs`/`decideWhen` ou sob demanda, `noise` com seed), evento `ai_choice`/`ai_error`, `self.ai` e
  `onDecision`, `ai` e `props` no estado, `clamp()` nas expressões
- [x] meu-pet: o sorteio ponderado de atividades do pet virou `UtilityAI` (mesmos pesos, como expressões sobre
  `self.props`); prioridades de sono/fome continuam no script
- [x] 253 testes unitários + 15 e2e
- [x] **Animation Controller**: `Animator` escolhe o clipe pelo estado da `StateMachine` (`states` ou mesmo nome), quadros
  de imagem ou spritesheet por clipe, `speed`, eventos de quadro, `anim_end` e `next` em one-shots, `self.anim`
  (`play/stop/speed`), `anim` no estado; validação das referências; animação passou a rodar depois das máquinas de estado
- [x] meu-pet: a alternância dos quadros de idle do pet virou um clipe do `Animator` (quadros da forma atual)
- [x] 262 testes unitários + 15 e2e
- [x] **Timer / Scheduler**: `Scheduler` por cena em frames; scripts com `self.after/every/cancel/timers/cooldown`
  (timers da entidade); ações `after {ms, do, id?}` e `cancelTimer` em regras e estados; `timers`/`cooldowns` no
  estado; evento `timer_error`
- [x] meu-pet: observações (1 s) e save (3 s) do pet viraram `self.every` em vez de contadores manuais
- [x] 272 testes unitários + 15 e2e
- [x] **Tween**: `self.tween/stopTween/tweens`, ação `tween` em regras e estados; x, y, rotation, scale, opacity e
  `Componente.campo`; linear/easeIn/easeOut/easeInOut, yoyo, repeat; `tween_end`; `tweens` no estado; `Text.opacity`
- [x] meu-pet: o emote (♥, z, ♪...) sobe, balança e some com tweens (sem `onUpdate` nem `rgba` manual)
- [x] 282 testes unitários + 15 e2e
- [x] **Pathfinding**: grade + A* (8 direções sem cortar quinas, folga do tamanho do agente, determinístico),
  `game.findPath`, componente `NavAgent` (alvo entidade/ponto, replanejamento, `Body` por velocidade), `nav_arrived`/
  `nav_failed`, `self.nav`, `nav` no estado, `pathDistance()` nas expressões, caminho no screenshot anotado
- [x] meu-pet não usa (o pet anda em 1D no chão sem obstáculos); validado com um labirinto nos testes e no Chromium
- [x] 295 testes unitários + 15 e2e
- [x] **Particles / VFX**: `ParticleEmitter` (taxa, rajada, max, vida, velocidade, ângulo/abertura, gravidade, arrasto,
  tamanho inicial/final, cores, círculo/retângulo/glifo, fade, jitter), RNG própria derivada da seed, `self.particles`,
  `game.emitParticles`, ação `burst`, evento `particles`, render
- [x] meu-pet: limpar a sujeira solta uma nuvem de poeira (emissor no prefab `sujeira` + `self.particles.burst`)
- [x] 303 testes unitários + 15 e2e
- [x] **V0.2 concluída**: os 8 sistemas de comportamento (interação, máquina de estados, Utility AI, animação, timers,
  tweens, pathfinding, partículas)

## ✅ V0.3 — Camada de QA do agente (concluída)
- [x] **`verify_game`**: cenário num jogo novo (passos de input, `waitUntil`/`assert` com nome, `advanceClock`,
  `screenshot` no meio e no fim) → relatório PASS/FAIL por checagem com valores observados, erros de runtime reprovam,
  estado final, contagem de eventos, imagens anexadas; executor compartilhado com `run_test` (`runtime/scenario.ts`);
  `RuntimeHost.newSession`/`screenshotOf` para sessões avulsas; CLI `call` fecha o Chromium no fim
- [x] meu-pet: cenário "limpar a sujeira" verificado (regressão + Chromium)
- [x] Bug achado pelo próprio `verify_game` no meu-pet: um clique no primeiro frame de uma cena chegava antes do
  `onStart` dos scripts. Agora os `onStart` pendentes rodam no começo do frame (`ScriptRunner.start`)
- [x] 309 testes unitários + 16 e2e
- [x] **Asserções estruturadas**: `entityExists`, `entityAt`, `entityNear`, `entity` (campo do estado), `component`,
  `state`, `variable`, `count`, `eventOccurred` (com `match` e contagem), `scene`, `gameWon`, `gameLost`, `status`;
  comparações `equals/notEquals/gt/gte/lt/lte`; `expected`/`actual`/`evidence` por checagem; no `verify_game` em
  `assertions` e em passos `assert`/`waitUntil` (`check`)
- [x] meu-pet: regressão do `verify_game` usando asserções estruturadas
- [x] 313 testes unitários + 16 e2e
- [x] **Playbooks**: `playbooks/<id>.json` (= entrada do `verify_game` + `tags`), validados em toda escrita pelo
  `ProjectStore`, no histórico; `verify_game saveAs` (só se passar), `save_playbook`, `list_playbooks`,
  `run_playbooks` (ids/tags, placar com as falhas), `delete_playbook`; schemas de passos movidos para `shared`
- [x] meu-pet: 4 playbooks (`limpar_sujeira`, `encher_tigela`, `carinho`, `bola`), rodados pela regressão
- [x] 316 testes unitários + 16 e2e
- [x] **Relatório de diagnóstico**: em toda verificação que falha, `diagnosis` com evidências por checagem
  (entidades citadas: estado, componentes, últimos eventos, ou se sumiram/nunca existiram; variáveis e quem as escreve;
  eventos contados), erros de runtime, linha do tempo e `likelySystems` pontuados com motivos; linha `LIKELY` no
  relatório; `run_playbooks` lista os sistemas prováveis por playbook
- [x] meu-pet: diagnóstico de uma falha proposital aponta máquina de estados, `pet.js` e Utility AI
- [x] 321 testes unitários + 16 e2e
- [x] **V0.3 concluída**: `verify_game`, asserções estruturadas, playbooks, relatório de diagnóstico

## ✅ V0.4 — Percepção do agente (concluída)
- [x] **Observação unificada**: tool `observe` (jogo, players, entidades na tela com caixa no viewport, input com mouse
  em tela e mundo, câmera, eventos e console novos, screenshot), `getState({onScreen})` / `Game.screenBoxOf`,
  `inspect_game_state {onScreen}`
- [x] meu-pet: `observe` no quarto lista só o que está desenhado (sem a `noite` transparente nem a ração escondida)
- [x] 324 testes unitários + 17 e2e
- [x] **Percepção do mouse**: `Game.mouseTarget()` / tool `get_mouse_target` (posição na tela e no mundo, `target` =
  o que o clique atingiria com `ready`/`blocked`, `hovered`, pilha `under`, `nearest` com distância, `lastClick`);
  `hovered`/`target` no `observe`; `mouse` nas expressões; `game.input.hovered` nos scripts
- [x] meu-pet: mouse sobre a tigela (com o pet atrás) → clique vai para a tigela; espaço vazio → alvo mais próximo
- [x] 328 testes unitários + 17 e2e
- [x] **Controle do mouse**: passos `doubleClick`, `drag {from, to}` e `mouseMove {entity}` (só ops primitivas: replay
  exato); tools `move_mouse {entity}`, `click_mouse {double}`, `press_mouse`, `release_mouse`, `drag_mouse`; a engine
  percebe duplo clique (`click.clicks: 2`) e arrasto (`drag_start`/`drag_end {entity, drop}`), tag `draggable` segue
  o mouse; scripts `game.input.doubleClicked` / `game.input.drag`
- [x] meu-pet: duplo clique no pet e arrasto da bola verificados (`verify_game`); arrasto replicado no Chromium
- [x] 333 testes unitários + 18 e2e
- [x] **V0.4 concluída**: observação unificada, percepção do mouse, controle do mouse

## V0.5 — Editor amigável (em andamento)
Complementa o Claude Code (fluxo IA-first continua), sem virar um editor tipo Unity.
- [x] **Hierarquia**: painel na página do jogo (cenas → entidades, ao vivo na cena atual: criadas, destruídas e
  desativadas marcadas; ícone por tipo; filtro por id/tag/componente/prefab); seleção com contorno no canvas, gravada
  em `.vibe/selection.json` e lida pelo agente com `get_selection` ("deixa isso maior"); páginas de host sem painel
- [x] **Inspector**: painel com a entidade selecionada (Entidade, Transform, um bloco por componente), campos tipados
  a partir do schema (número com limites, checkbox, enum, asset, cor, listas, JSON), padrão/prefab indicados, `↺`
  volta ao padrão, adicionar/remover componente, valores ao vivo; edições pelo `ProjectStore` como `user`
  (`modify_game_object`, histórico, undo), inválidas rejeitadas sem gravar; histórico compartilhado entre processos
- [x] meu-pet: as 48 entidades abrem no inspector sem erro
- [x] **Viewport**: modo edição (jogo pausado e sem input, reinicia na cena como está no arquivo), câmera de edição
  (zoom na roda, pan, `F` centraliza, `0` volta à câmera do jogo), clique seleciona (mesma seleção da hierarquia e
  de `get_selection`), arrastar/setas movem (prévia sem tocar a simulação; grava `move` como `user`, uma entrada
  no histórico), gizmos: limites da cena, quadro da câmera do jogo, contorno, cruz da posição com coordenadas e Δ
- [x] meu-pet: playbooks passando; entidades da cena inicial selecionáveis pelo clique
- [x] 366 testes unitários + 22 e2e
- [ ] Asset browser (imagens, spritesheets, áudio, prefabs, scripts)

## ~~Etapa 9 — Teste final~~ — descartada
O jogo de plataforma do enunciado não será feito como teste final; o próximo jogo será definido pelo usuário.

## Limitações conhecidas
- Sem `AudioSource` por entidade: sons saem de eventos (`config.sounds`), regras e scripts; sem áudio posicional.
- Hot reload reinicia o jogo do começo (não preserva estado).
- O servidor de projetos existe só no dev server do Vite; build de produção do runtime ainda não existe.
- `.mcp.json` usa o caminho absoluto `C:/Program Files/nodejs/node.exe` (ajustar em outra máquina).
- Uma run por projeto/host. O screenshot sobe Vite + Chromium na primeira foto (~1-2 s).
- Runs headless não tocam som (o agente vê os eventos `sound`/`music`); screenshots mostram um frame (sem vídeo/GIF).
- Arquivos binários de assets não entram no histórico (só a entrada em `project.json`); undo não apaga o arquivo.
- Ids de entidade não são renomeáveis (duplicar + apagar). Edições feitas fora do store não entram no histórico.
- Sem trava entre processos: dois processos escrevendo no mesmo projeto ao mesmo tempo podem conflitar.
- Física sem colisão contínua: sólidos finos (< 16 px) podem ser atravessados em queda rápida.
- Corpos dinâmicos não colidem entre si (inimigos se sobrepõem).
- Plataforma móvel não empurra corpos de lado (só carrega quem está em cima); esmagar contra o teto não é tratado.
- Contatos O(n²) — suficiente para cenas de centenas de entidades.
