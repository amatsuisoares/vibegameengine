# projects/

Pasta dos jogos feitos com a engine. Cada jogo é **um repositório próprio**, clonado aqui dentro; o repositório da
engine ignora tudo nesta pasta (menos este arquivo).

```bash
cd projects
git clone <url do repositório do jogo> meu-pet
```

Com o jogo aqui, tudo funciona como antes: o servidor MCP `vibe` (Claude Code), `npm run dev`, as tasks do VS Code
e `npm run vibe -- <comando> <jogo>`. Se o jogo tiver `tests/*.test.ts`, eles rodam junto com o `npm test` da engine.

Commits e pushes do jogo são feitos dentro da pasta dele (`cd projects/meu-pet && git commit ...`).
