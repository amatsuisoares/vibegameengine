# CLAUDE.md

Plataforma de jogos 2D guiada por agente de IA. Leia ARCHITECTURE.md antes de mudanças estruturais.

## Comandos
- `npm test` — Vitest em todos os pacotes (`packages/*/test/**/*.test.ts`)
- `npm run typecheck` — tsc sem emitir

## Convenções
- Monorepo npm workspaces; pacotes exportam `src/index.ts` diretamente (sem build). Aliases `@vibe/*`
  estão em `tsconfig.json` e `vitest.config.ts` — ao criar um pacote, adicione nos dois.
- Código e comentários em inglês; documentação (README/ARCHITECTURE/AGENT_TOOLS/TODO) em português.
- Todo dado de projeto passa por schemas zod em `packages/shared`. Novo componente: schema em
  `components.ts` (registro `ComponentSchemas` + `ComponentsSchema`), sistema na engine, teste, doc.
- A engine não pode depender de DOM nem de relógio real; tudo avança por `Game.step()`.
- Cada etapa só avança com testes passando; atualize TODO.md ao concluir itens.
