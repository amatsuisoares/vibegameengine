# Arquitetura

## Visão geral

```
┌──────────── Editor (React) ──────────────┐
│ Hierarchy | Viewport | Inspector | Chat  │
└──────────────┬───────────────────────────┘
               │ WebSocket + REST
┌──────────────▼──────────── Server (Node) ┐
│ ProjectStore ─ histórico/diff             │
│ ToolRegistry ─ tools do agente            │
│ AgentLoop ──── LLM + orçamento + logs     │
│ ProjectMemory ─ features/TODO/erros       │
│ RuntimeHost ─┬─ headless (Node)           │
│              └─ visual (Chromium/Playwright) │
└──────────────┬───────────────────────────┘
               │ mesma engine nos dois modos
┌──────────────▼──────────── Engine (TS) ──┐
│ World · Entities · Systems · Input virtual│
└───────────────────────────────────────────┘
```

Implementado até agora: `shared` e `engine` (Etapa 1), `runtime` no browser (Etapa 2), `server` com
ProjectStore + tools de edição (Etapa 3).

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
       Scene: id, background, width/height (mundo), killY, fallDamage, camera, vars, entities[]
          Entity: id, name, tags[], enabled, transform{x,y,rotation,scaleX,scaleY},
                  components: { Sprite?, Body?, Collider?, PlatformerController?, ... }
```

Em disco: `projects/<nome>/project.json` (config) + `scenes/<id>.json`.

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
| `Text` | texto/HUD com placeholders `{coins}`, `{player.health}` |
| `Animator` | clipes de spritesheet; seleção automática idle/run/jump/fall |

## Engine (`packages/engine`)

```
Game ── API pública: step/advance/perform/waitUntil/getState/events/console/restart/loadScene
 └── World ── entidades, vars, status (running|won|lost|crashed), eventos, câmera, checkpoints
      Passo fixo (1/60 s), nesta ordem:
        1. Input.beginFrame()        latch de teclas pressionadas entre frames
        2. controllerSystem           PlatformerController, Patrol, FollowTarget
        3. physicsSystem              gravidade; move X e resolve; move Y e resolve (grounded)
        4. findContacts + interactionSystem   coleta, pisão, dano, checkpoint, goal
        5. healthSystem               timers, queda no abismo (killY), morte
        6. animationSystem            flip e frames de animação
        7. flushDestroyed, cameraSystem
```

- **Física:** arcade, AABB, resolução por eixo contra sólidos (colliders não-trigger sem Body dinâmico).
  Corpos dinâmicos não bloqueiam uns aos outros — sobreposição vira contato (dano, pisão).
  Sem colisão contínua: sólidos devem ter ≥ 16 px de espessura (queda máx. 15 px/frame).
- **Contatos:** pares sobrepostos (tolerância 0,5 px, então “encostar” conta). Goal/Checkpoint usam
  semântica de *enter* (só no primeiro frame de contato).
- **Eventos:** `jump, collect, damage, stomp, death, fell, respawn, checkpoint, goal, goal_blocked, win,
  lose, scene_loaded, crash` — registrados com o frame, consultáveis por `game.events()`.
- **Erros:** exceções dentro de um passo são capturadas, vão para o console com stack e o status vira
  `crashed` (o agente lê e corrige).
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
  ├─ render()       buildDrawList(world) → paint(ctx) → paintDebug? → paintStatusOverlay
  └─ window.__vibe  controle externo (pause/step/perform/getState/...)
```

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

## Comunicação agente ↔ runtime (planejada, etapas 4–6)

```
Agent ──tool call──▶ Server/ToolRegistry ──▶ RuntimeHost ──▶ Game (headless)  → estado, eventos, console
                                                        └─▶ Chromium (Playwright) → screenshot PNG
```

- Modo **headless**: a instância `Game` roda no próprio servidor; input do agente = `game.perform()`.
- Modo **visual**: página `runtime` (`?paused=1`) carrega o mesmo projeto em Chromium headless; o servidor
  envia input e lê estado por `page.evaluate(window.__vibe...)`, captura PNG por `locator('canvas').screenshot()`.
  Esse caminho já é exercitado pelos testes e2e (`packages/runtime/e2e`). Como a simulação
  é determinística e o tempo é controlado pelo host, os dois modos produzem o mesmo estado.
- O agente só alcança o que as tools expõem: arquivos dentro do diretório do projeto e o runtime.
