# CLAUDE.md

Plataforma de jogos 2D guiada por agente de IA. Leia ARCHITECTURE.md antes de mudanças estruturais.

## Comandos
- `npm test` — Vitest em todos os pacotes (`packages/*/test/**/*.test.ts`)
- `npm run typecheck` — tsc sem emitir
- `npm run dev` — runtime no browser (Vite, porta 5173)
- `npm run vibe -- <cmd>` — CLI das tools de edição (`tools`, `call <projeto> <tool> <json|@arquivo>`, `history`, `undo`)
- `npm run test:e2e` — Chromium headless via Playwright (`packages/*/e2e/**/*.e2e.test.ts`); screenshots em
  `projects/demo-platformer/.vibe/runs/`

## Convenções
- Monorepo npm workspaces; pacotes exportam `src/index.ts` diretamente (sem build). Aliases `@vibe/*`
  estão em `tsconfig.json`, `vitest.config.ts` e `packages/runtime/vite.config.ts` — ao criar um pacote, adicione nos três.
- Código e comentários em inglês; documentação (README/ARCHITECTURE/AGENT_TOOLS/TODO) em português.
- Todo dado de projeto passa por schemas zod em `packages/shared`. Novo componente: schema em
  `components.ts` (registro `ComponentSchemas` + `ComponentsSchema`), sistema na engine, teste, doc.
- A engine não pode depender de DOM nem de relógio real; tudo avança por `Game.step()`.
- Renderização só lê o `World` (`buildDrawList` é puro; `paint` desenha). Nada no runtime altera a simulação.
- Toda escrita em projeto passa pelo `ProjectStore` (valida, grava atômico, registra histórico). Nova tool:
  `defineTool` em `packages/server/src/tools/`, registrar em `createEditingTools`, teste, AGENT_TOOLS.md.
- Escopo e prioridades do projeto: `docs/PROMPT_ORIGINAL.md`.
- Cada etapa só avança com testes passando; atualize TODO.md ao concluir itens.
