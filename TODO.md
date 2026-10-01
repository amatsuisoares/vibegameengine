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

## Etapa 5 — Agente
- [ ] Interface `LLMProvider` + provider Claude + provider roteirizado (testes sem API)
- [ ] Loop de tool use com limites: iterações, tokens/custo, timeout, abort
- [ ] Confirmação opcional para ações destrutivas; log completo de cada passo
- [ ] CLI `vibe agent "<prompt>"`

## Etapa 6 — Memória + loop autônomo
- [ ] `.vibe/memory.json`: features, TODOs, erros conhecidos, changelog
- [ ] Resumo do projeto injetado a cada turno
- [ ] Ciclo planejar → implementar → executar → testar → corrigir com critério de conclusão

## Etapa 7 — Editor React
- [ ] Layout: hierarquia, viewport, inspector, assets, código (Monaco), console, chat
- [ ] Sincronização em tempo real com o servidor (WebSocket)
- [ ] Botões run/stop/test; gerenciamento de cenas

## Etapa 8 — Extensões do MVP
- [ ] Componente `Script` (hooks onStart/onUpdate/onCollision) com API restrita e erros com arquivo:linha
- [ ] Importação de imagens/spritesheets/áudio; `AudioSource` + eventos de som
- [ ] Sistema de eventos/condições data-driven (Trigger → ações)
- [ ] Prefabs
- [ ] Plataformas móveis (kinematic carregando entidades)

## Etapa 9 — Teste final
- [ ] Agente cria sozinho o jogo de plataforma do enunciado, testa e corrige

## Limitações conhecidas
- Áudio é declarado mas não carregado (Etapa 8).
- Hot reload reinicia o jogo do começo (não preserva estado).
- O servidor de projetos existe só no dev server do Vite; build de produção do runtime ainda não existe.
- Uma run por projeto/host. O screenshot sobe Vite + Chromium na primeira foto (~1-2 s).
- Sem áudio nas runs (Etapa 8); screenshots mostram um frame (sem vídeo/GIF).
- Ids de entidade não são renomeáveis (duplicar + apagar). Edições feitas fora do store não entram no histórico.
- Sem trava entre processos: dois processos escrevendo no mesmo projeto ao mesmo tempo podem conflitar.
- Física sem colisão contínua: sólidos finos (< 16 px) podem ser atravessados em queda rápida.
- Corpos dinâmicos não colidem entre si (inimigos se sobrepõem).
- Kinematic não carrega entidades em cima (plataforma móvel).
- Contatos O(n²) — suficiente para cenas de centenas de entidades.
