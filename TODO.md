# Roadmap

## ✅ Etapa 1 — Fundação (concluída)
- [x] Monorepo npm workspaces + TypeScript + Vitest
- [x] Schemas zod: projeto, cena, entidade, 14 componentes built-in, assets
- [x] Validação semântica com mensagens legíveis para o agente
- [x] Engine headless: passo fixo, física AABB, one-way, input virtual com latch, câmera
- [x] Gameplay: controle de plataforma, patrulha, perseguição, vida, dano, pisão, coleta, checkpoint, goal, troca de cena
- [x] Estado estruturado, eventos, console, determinismo (seed)
- [x] Projeto demo `projects/demo-platformer`
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
