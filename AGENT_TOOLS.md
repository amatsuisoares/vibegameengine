# Ferramentas do agente

Especificação das tools que o agente usa. O agente é o **Claude Code**: as tools chegam a ele pelo servidor MCP
`vibe` (`packages/server/src/mcp`, registrado em `.mcp.json`) com o nome `mcp__vibe__<tool>`. Também dá para
chamá-las pela CLI (`npm run vibe -- call|script ...`).

| Grupo | Status |
|---|---|
| Projeto, cenas, entidades, componentes, arquivos, histórico | **implementado** (Etapa 3, `packages/server/src/tools`) |
| Runtime no browser (`window.__vibe`) | **implementado** (Etapa 2) |
| Tools de runtime (`run_game`, `press_key`, `take_screenshot`, `run_test`...) | **implementado** (Etapa 4) |
| Workspace: `list_projects`, `open_project`, `create_project` | **implementado** (Etapa 6, só via MCP) |
| Memória | planejado (Etapa 8) |

Convenções:
- Todas as tools operam **somente** dentro do projeto aberto (caminhos fora de `projects/<nome>/` são rejeitados;
  `.vibe/` é gerenciado pela plataforma e não pode ser escrito).
- Parâmetros validados por zod; erros voltam como `{ ok: false, error, details? }`, com o caminho do campo e o id
  da entidade (ex. `scenes.level1.entities[3](enemy1).components.Body.type: ...`). O registro nunca lança exceção.
- **Toda alteração valida o projeto inteiro antes de gravar.** Se ela introduz um erro novo, é recusada e nada é
  escrito. Erros que já existiam antes (ex. arquivo quebrado à mão) não bloqueiam outras edições e voltam em
  `preExistingErrors`.
- Toda tool que modifica o projeto aceita `reason` (opcional), gera uma entrada no histórico (autor, tool,
  motivo, arquivos) e retorna `{ changed, historySeq, diff, warnings? }`. Tudo pode ser desfeito.
- **Patches** seguem JSON Merge Patch (RFC 7386): objetos são mesclados, `null` apaga a chave, arrays e demais
  valores substituem. Ex.: `{"transform":{"x":300},"components":{"Stompable":null}}`.
- O JSON é gravado em formato canônico (objetos curtos numa linha), então diffs mostram só o que mudou.
- Definições no formato de tool use da API do Claude: `registry.definitions()` → `{ name, description, input_schema }`
  (JSON Schema gerado dos schemas zod). CLI: `npm run vibe -- schema [tool]`.

## Projeto e cenas

| Tool | Parâmetros | Retorno |
|---|---|---|
| `get_project_summary` | — | config, cenas com resumo de cada entidade, validação, histórico recente |
| `list_component_types` | `types?` | sem args: nomes + descrição; com `types`: JSON Schema completo (defaults, descrições) |
| `modify_project_config` | `patch` | gravity, actions, assets, startScene... |
| `get_scene` | `scene` | configurações da cena + resumo das entidades |
| `create_scene` | `id, settings?, entities?` | cria `scenes/<id>.json` |
| `modify_scene` | `scene, patch` | configurações (não `id`/`entities`) |
| `delete_scene` | `scene` | recusado se ainda referenciada (startScene, Goal.scene) |

## Entidades e componentes

| Tool | Parâmetros | Observação |
|---|---|---|
| `get_game_object` | `scene, id` | `raw` (como está no arquivo) e `effective` (com defaults) |
| `create_game_object` | `scene, entity, index?` | JSON parcial; só o que difere do default |
| `duplicate_game_object` | `scene, id, newId, patch?` | cópia logo após o original |
| `modify_game_object` | `scene, id, patch` | ids não são renomeáveis |
| `delete_game_object` | `scene, id` | recusado se referenciada (camera.follow, FollowTarget.targetId) |
| `create_component` | `scene, id, type, data?` | erro se já existe |
| `modify_component` | `scene, id, type, patch` | erro se não existe |
| `remove_component` | `scene, id, type` | |

Id inexistente sugere ids parecidos (`Did you mean: enemy1, enemy2?`).

## Código e arquivos

| Tool | Parâmetros | Retorno |
|---|---|---|
| `list_files` | `dir?` | arquivos com tamanho (sem `.vibe/`) |
| `read_file` | `path, startLine?, endLine?` | texto numerado, máx. 2000 linhas por chamada; binário → só o tamanho |
| `write_file` | `path, content` | cria/sobrescreve; JSON do projeto é validado |
| `edit_file` | `path, oldText, newText, replaceAll?` | `oldText` precisa ser único (ou `replaceAll`) |
| `delete_file` | `path` | `project.json` não pode ser apagado |

`create_script` / `modify_script` / `delete_script` chegam com o componente `Script` (Etapa 8); até lá
`write_file`/`edit_file` cobrem arquivos de código.

## Histórico

| Tool | Parâmetros | Retorno |
|---|---|---|
| `get_history` | `limit?, seq?` | entradas recentes; com `seq`, o diff completo |
| `undo` | — | desfaz a última alteração não desfeita; recusado se os arquivos mudaram depois |
| `redo` | — | refaz a última desfeita; uma nova edição limpa o redo |

## Runtime

Implementado na Etapa 4 (`packages/server/src/tools/runtime-tools.ts`). As tools usam um `RuntimeHost` no contexto.
Uma run é um `Game` headless no servidor: **o tempo só avança com `wait`/`wait_until`/`perform_inputs`/`click_mouse`**
(mais rápido que tempo real e determinístico). Cada ação é gravada como `GameOp` primitiva, o que permite
reproduzir a run no Chromium para o screenshot.

| Tool | Parâmetros | Retorno / observação |
|---|---|---|
| `run_game` | `scene?, seed?` | nova run com o projeto atual (substitui a anterior) |
| `restart_game` | — | recomeça com os **arquivos atuais** (mesma cena/seed) — use depois de editar |
| `stop_game` | — | encerra a run |
| `press_key` / `release_key` | `key` | tecla fica pressionada até soltar; não avança o tempo |
| `move_mouse` / `click_mouse` | `x, y` / `x?, y?, button?` | coordenadas do viewport; o clique avança 1 frame |
| `wait` | `ms` (máx. 60000) | avança o tempo simulado |
| `wait_until` | `expr, maxMs?` | avança até a expressão valer (ou timeout / fim de jogo); `ok`, `waitedMs` |
| `perform_inputs` | `steps` | sequência `keyDown/keyUp/tap/hold/wait/mouseMove/mouseDown/mouseUp/click` |
| `inspect_game_state` | `ids?, tags?, components?` | estado completo (vars, câmera, entidades com posição, velocidade, vida...) |
| `read_events` | `sinceFrame?, type?, limit?` | eventos de gameplay com frame |
| `read_console` | `since?, level?` | logs, avisos, erros com stack |
| `take_screenshot` | `annotate?` | PNG (imagem anexada ao resultado), `path`, `frame`, `camera`; `renderWarnings` se algum sprite não pôde ser desenhado |
| `run_test` | `steps, assertions, scene?, seed?` | roda num jogo novo (não mexe na run atual) e relata cada checagem |

**Observação após cada ação.** `run_game`, `restart_game`, `wait`, `wait_until`, `perform_inputs` e `click_mouse`
devolvem o que aconteceu desde a ação anterior: `frame`, `status`, `scene`, `keysDown`, `players` (entidades com
tag `player`), `events` novos (máx. 30) e avisos/erros novos do console. Se os arquivos do projeto mudaram depois
do início da run, vem `projectChanged` pedindo `restart_game`.

### Expressões

Usadas por `wait_until`, passos `waitUntil`/`assert` e `assertions` do `run_test`. São interpretadas por um
parser próprio (`packages/engine/src/expr.ts`), sem `eval`.

- Nomes: `status`, `frame`, `time`, `scene`, `vars`, `camera`
- Funções: `entity(id)` (snapshot ou `null`), `exists(id)`, `count(tag)`, `events(type)`, `abs`, `min`, `max`
- Operadores: `.campo`, `['campo']`, `!`, `-`, `* /`, `+ -`, `< <= > >=`, `== !=`, `&&`, `||`
- Campo de `null` dá `null`; comparação com `null` é falsa. `=` sozinho é erro ("use ==").

Cada checagem retorna `observed` com os valores dos dois lados das comparações — o agente vê *por que* falhou:

```json
{ "expr": "entity('player').x > 2000", "pass": false, "observed": { "entity(\"player\").x": 278.4 } }
```

Exemplo de `run_test`:

```json
{
  "steps": [
    { "type": "wait", "ms": 300 },
    { "type": "assert", "expr": "entity('player').grounded" },
    { "type": "keyDown", "key": "D" },
    { "type": "waitUntil", "expr": "vars.coins == 1", "maxMs": 3000 },
    { "type": "keyUp", "key": "D" }
  ],
  "assertions": ["status == 'running'", "events('collect') == 1"]
}
```

Retorno: `passed`, `checks[]`, `final` (status, vars, players), `eventCounts`, `errors`. Limite de 300 s simulados.

### Screenshots

`take_screenshot` sobe (uma vez, sob demanda) o dev server do runtime e um Chromium headless. A página abre
pausada e recebe **exatamente o projeto da run** por interceptação de requisições (assets lidos da pasta do
projeto); as `GameOp` da run são reaplicadas por `window.__vibe.apply()` — só as novas, nas fotos seguintes da
mesma run. O PNG é salvo em `.vibe/runs/<runId>/NNN-f<frame>[-debug].png`. Depois da foto, o estado do browser é
comparado com o da run headless; divergência viraria `warning` (nunca deve acontecer — testado).

## Runtime no browser (`window.__vibe`)

Implementado na Etapa 2. É a superfície que o RuntimeHost (Etapa 4) vai usar via Playwright
(`page.evaluate`). Tudo que retorna é JSON puro (cópias; alterar o retorno não altera o jogo).
Para execuções determinísticas, abra a página com `?paused=1`.

| Método | Retorno | Observação |
|---|---|---|
| `info()` | `{project, scenes, scene, width, height, paused, debug}` | |
| `pause()` / `resume()` | — | pausa só o loop de tempo real |
| `step(frames=1)` / `advance(ms)` / `perform(steps)` / `apply(ops)` | `{frame, status, scene}` | redesenha em seguida; `apply` reaplica `GameOp`s |
| `keyDown(key)` / `keyUp(key)` | — | mesmo `normalizeKey` da engine |
| `mouseMove(x, y)` / `mouseDown(btn)` / `mouseUp(btn)` | — | coordenadas do viewport |
| `getState(query?)` | `GameState` | igual a `game.getState` |
| `events(sinceFrame?, type?)` / `console(since?, level?)` | listas | |
| `restart()` / `loadScene(id)` | `{frame, status, scene}` | |
| `setDebug(on)` / `render()` | — | debug desenha colliders e ids (útil antes de screenshot) |

`window.__vibeError` (lista de mensagens) é definido quando o projeto não carrega ou uma edição o deixa inválido.
`take_screenshot` = `apply(ops novas)` + `setDebug(annotate)` + `render()` + screenshot do elemento `canvas`.

## Memória

| Tool | Parâmetros |
|---|---|
| `read_memory` | — |
| `update_memory` | `features?, todos?, knownIssues?, notes?` |

## Nomes de teclas

Normalizados por `normalizeKey`: `"d"`, `"D"`, `"KeyD"` → `D`; `"SPACE"`, `" "` → `Space`;
`"left"` → `ArrowLeft`; `"esc"` → `Escape`; `"Digit1"` → `1`.
Controllers usam **actions** (`left`, `right`, `jump`, …) mapeadas em `config.actions`.
