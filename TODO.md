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

## Etapa 3 — ProjectStore + tools de edição
- [ ] Leitura/gravação de projeto em disco, com escrita atômica
- [ ] Histórico: cada alteração com diff, autor (user/agent), motivo; undo/redo
- [ ] Tools de cena/entidade/componente/arquivo + JSON Schema para o LLM

## Etapa 4 — RuntimeHost
- [ ] Sessões de jogo headless (run/stop/restart/input/wait/state/console/events)
- [ ] `run_test` com asserções
- [ ] Screenshots via Playwright (Chromium headless), opção anotada

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
- Física sem colisão contínua: sólidos finos (< 16 px) podem ser atravessados em queda rápida.
- Corpos dinâmicos não colidem entre si (inimigos se sobrepõem).
- Kinematic não carrega entidades em cima (plataforma móvel).
- Contatos O(n²) — suficiente para cenas de centenas de entidades.
