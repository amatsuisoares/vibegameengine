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
- [ ] Teste real: recarregar o VS Code com a pasta do repositório aberta e usar as tools pelo chat

## Etapa 7 — Jogo dentro do VS Code
- [ ] Abrir o runtime num painel do VS Code (Simple Browser) com hot reload enquanto o agente edita
- [ ] Tool/atalho para abrir a visualização no projeto/cena certos
- [ ] Avaliar uma extensão leve (hierarquia da cena, inspector) se o Simple Browser não bastar
- [ ] Opcional: espelhar no painel a run do agente (ver ao vivo o que ele está jogando)

## Etapa 8 — Memória + extensões do MVP
- [ ] Memória do projeto (`.vibe/memory.json`: features, TODOs, erros conhecidos) + tools
- [ ] Componente `Script` (hooks onStart/onUpdate/onCollision) com API restrita e erros com arquivo:linha
- [ ] Importação de imagens/spritesheets/áudio; `AudioSource` + eventos de som
- [ ] Sistema de eventos/condições data-driven (Trigger → ações)
- [ ] Prefabs
- [ ] Plataformas móveis (kinematic carregando entidades)

## Etapa 9 — Teste final
- [ ] O Claude Code cria, pelo chat, o jogo de plataforma do enunciado, testa e corrige

## Limitações conhecidas
- Áudio é declarado mas não carregado (Etapa 8).
- Hot reload reinicia o jogo do começo (não preserva estado).
- O servidor de projetos existe só no dev server do Vite; build de produção do runtime ainda não existe.
- `.mcp.json` usa o caminho absoluto `C:/Program Files/nodejs/node.exe` (ajustar em outra máquina).
- Uma run por projeto/host. O screenshot sobe Vite + Chromium na primeira foto (~1-2 s).
- Sem áudio nas runs (Etapa 8); screenshots mostram um frame (sem vídeo/GIF).
- Ids de entidade não são renomeáveis (duplicar + apagar). Edições feitas fora do store não entram no histórico.
- Sem trava entre processos: dois processos escrevendo no mesmo projeto ao mesmo tempo podem conflitar.
- Física sem colisão contínua: sólidos finos (< 16 px) podem ser atravessados em queda rápida.
- Corpos dinâmicos não colidem entre si (inimigos se sobrepõem).
- Kinematic não carrega entidades em cima (plataforma móvel).
- Contatos O(n²) — suficiente para cenas de centenas de entidades.
