# V0.8 — App (análise e arquitetura)

Objetivo: um jogo feito na engine vira **app instalável** — `.exe` no Windows (Electron) e `.apk` no Android
(Capacitor) — que roda sem o servidor de desenvolvimento, sem o editor e sem internet. O primeiro alvo é o `meu-pet`,
mas tudo é genérico: qualquer projeto em `projects/` pode ser exportado.

Este documento é a Fase 1 (análise). Ele diz o que existe, o que falta, o que entra na engine/plataforma e em que
ordem.

## 1. O que existe hoje

| Peça | Onde | Serve para o app? |
|---|---|---|
| `Game` (engine headless, sem DOM nem relógio real) | `packages/engine` | sim, sem mudanças |
| `Runtime` (loop, render em canvas, input DOM por pointer events, som Web Audio) | `packages/runtime/src` | sim: é o player; pointer events já cobrem toque |
| Página do editor (`app/main.ts`: hierarquia, inspector, asset browser, console, follow, edição de viewport) | `packages/runtime/app` | **não**: o app precisa de uma página só de jogo |
| Projeto e assets servidos pelo dev server (`GET /api/projects/<p>`, `/projects/<p>/assets/...`) | `packages/runtime/vite` | **não existe fora do `npm run dev`** |
| Save (`game.storage`) em `.vibe/save.json` via `PUT /api/.../save`, cópia em `localStorage`; slots em `.vibe/slots.json` | `app/main.ts` | **precisa de outro destino** (o aparelho) |
| Relógio real (`clock.start = Date.now()`) + "tempo fora" simulado pelo jogo (pet.js) | `app/main.ts`, jogo | sim: fechar e abrir o app no dia seguinte já funciona como recarregar a página |
| Texto digitado (`game.input.text`, ex.: nome do pet) | `engine/input.ts` | sim no PC; **no Android o teclado virtual não abre** sobre um canvas |
| Scripts do jogo (`new Function`) | `engine/scripts.ts` | sim: Chromium (Electron) e WebView do Android permitem (sem CSP restritiva) |

Ferramentas na máquina: Node 24 e npm. **Não há** Java nem Android SDK (necessários para o APK).

## 2. Divisão plataforma × jogo

| Plataforma (genérico) | Jogo (`meu-pet`) |
|---|---|
| **Player**: página só de jogo (canvas em tela cheia, escala com letterbox, sem editor) | — |
| **Export**: `npm run vibe -- export <projeto>` → pasta estática (`index.html` + JS + projeto embutido + assets) | nome do app, ícone (sprite do pet), cor de fundo |
| **SaveStore**: interface de onde o `game.storage` e os slots são guardados — `localStorage` (padrão), arquivo (Electron), Preferences (Capacitor); gravação adiada e garantida ao ir para o fundo | — |
| **Celular**: teclado virtual para `game.input.text`, som liberado no primeiro toque, paisagem, sem zoom/seleção/menu de toque longo, botão voltar | o que a tela de nome pede |
| **Desktop**: `vibe package desktop <projeto>` → Electron + electron-builder (`.exe` instalador e portátil) | — |
| **Android**: `vibe package android <projeto>` → Capacitor + Gradle (`.apk`) | — |

O `app/main.ts` do editor continua igual (dev server, save em `.vibe/`); o player é uma entrada nova que reaproveita
o `Runtime` e os módulos de `packages/runtime/src`. Nada no app fala com o dev server.

## 3. Decisões

- **Player separado do editor**: `packages/runtime/player/` (HTML + `player.ts`), construído pelo Vite em modo
  build. O projeto entra no bundle como JSON já validado (`parseProject` no export, não no aparelho), os assets são
  copiados com os mesmos caminhos.
- **Save no aparelho**: `localStorage` funciona no Electron e no WebView, mas o Android pode limpá-lo; no APK o save
  vai para o Capacitor Preferences (persistente). Um `SaveStore` pequeno (`load/save/clear`) esconde a diferença.
  Gravar ao mudar (adiado 0,5 s) e em `visibilitychange` (o Android suspende o app sem `pagehide`).
- **Seed**: cada sessão jogada tem a sua (como hoje na página jogada).
- **Saída**: `build/<projeto>/web`, `build/<projeto>/desktop`, `build/<projeto>/android` — fora do git
  (`.gitignore`), regeneráveis.
- **Assinatura**: APK de debug para instalar direto no celular; APK/AAB assinado para a Play Store fica para
  depois (precisa de uma keystore sua).

## 4. Riscos

- **Teclado no Android**: o canvas não abre teclado. Mitigação: o player cria um `<input>` invisível e o foca quando
  o jogo pede texto (sinal genérico da engine, ex.: `game.input.wantText`), repassando o que for digitado para
  `game.input.text`.
- **Tamanho de tela**: 960×540 fixo. Mitigação: escala inteira da viewport com letterbox; o input já converte
  coordenadas pela caixa do canvas.
- **App suspenso**: o loop para com o app em segundo plano; ao voltar, o relógio real pulou. O jogo já trata pulos
  grandes como "tempo fora"; precisa ser verificado no aparelho.
- **Toolchain Android pesada**: Android Studio (~3–5 GB). Só é necessária na Fase 5; as Fases 2–4 não dependem dela.
- **Electron grande** (~100 MB por levar o Chromium): aceito pela simplicidade (sem Rust).

## 5. Fases

| Fase | Plataforma | Verificação |
|---|---|---|
| 1 ✅ | análise e arquitetura (este documento) | — |
| 2 | player standalone + `vibe export` + `SaveStore` (localStorage) + escala/letterbox | e2e: abre a pasta exportada num servidor estático qualquer, joga, recarrega e o save continua; nenhuma chamada a `/api` |
| 3 | celular no navegador: teclado virtual para texto, som no primeiro toque, paisagem, gestos desligados, salvar ao ir para o fundo | e2e com emulação de toque (Playwright mobile) digitando o nome; screenshot em tela de celular |
| 4 | desktop: Electron + electron-builder, `vibe package desktop` | `.exe` gerado, abre o jogo, save sobrevive a fechar e abrir |
| 5 | Android: Capacitor + Preferences + Gradle, `vibe package android` (precisa do Android Studio instalado) | `.apk` instalado no celular (ou emulador), nome, jogar, fechar, voltar outro dia |
| 6 | polimento: ícones e nome do app a partir do projeto, tela de carregamento, docs (README de como gerar), playtest nos dois aparelhos | — |
