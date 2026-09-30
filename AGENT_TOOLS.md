# Ferramentas do agente

Especificação das tools que o agente usa.

| Grupo | Status |
|---|---|
| Projeto, cenas, entidades, componentes, arquivos, histórico | **implementado** (Etapa 3, `packages/server/src/tools`) |
| Runtime no browser (`window.__vibe`) | **implementado** (Etapa 2) |
| Tools de runtime (`run_game`, `press_key`, `take_screenshot`...) | planejado (Etapa 4) |
| Memória | planejado (Etapa 6) |

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

| Tool | Parâmetros | Engine |
|---|---|---|
| `run_game` | `scene?, seed?` | `new Game(project)` |
| `stop_game` / `restart_game` / `pause_game` | — | `game.restart()` |
| `press_key` / `release_key` | `key` | `input.keyDown/keyUp` |
| `move_mouse` / `click_mouse` | `x, y` / `button` | `input.mouseMove/mouseDown` |
| `wait` | `ms` (tempo simulado) | `game.advance(ms)` |
| `perform_inputs` | `steps: InputStep[]` | `game.perform()` |
| `inspect_game_state` | `ids?, tags?, components?` | `game.getState()` |
| `read_events` | `sinceFrame?, type?` | `game.events()` |
| `read_console` | `since?, level?` | `game.console.read()` |
| `take_screenshot` | `annotate?` (desenha ids/caixas) | PNG via Chromium |
| `run_test` | `steps, assertions[]` | executa em instância nova e relata cada asserção |

Exemplo de `run_test`:

```json
{
  "steps": [{ "type": "hold", "key": "D", "ms": 1500 }, { "type": "tap", "key": "Space" }, { "type": "wait", "ms": 800 }],
  "assertions": [
    { "expr": "entity('player').x > 300" },
    { "expr": "vars.coins >= 1" },
    { "expr": "status == 'running'" }
  ]
}
```

## Runtime no browser (`window.__vibe`)

Implementado na Etapa 2. É a superfície que o RuntimeHost (Etapa 4) vai usar via Playwright
(`page.evaluate`). Tudo que retorna é JSON puro (cópias; alterar o retorno não altera o jogo).
Para execuções determinísticas, abra a página com `?paused=1`.

| Método | Retorno | Observação |
|---|---|---|
| `info()` | `{project, scenes, scene, width, height, paused, debug}` | |
| `pause()` / `resume()` | — | pausa só o loop de tempo real |
| `step(frames=1)` / `advance(ms)` / `perform(steps)` | `{frame, status, scene}` | redesenha em seguida |
| `keyDown(key)` / `keyUp(key)` | — | mesmo `normalizeKey` da engine |
| `mouseMove(x, y)` / `mouseDown(btn)` / `mouseUp(btn)` | — | coordenadas do viewport |
| `getState(query?)` | `GameState` | igual a `game.getState` |
| `events(sinceFrame?, type?)` / `console(since?, level?)` | listas | |
| `restart()` / `loadScene(id)` | `{frame, status, scene}` | |
| `setDebug(on)` / `render()` | — | debug desenha colliders e ids (útil antes de screenshot) |

`window.__vibeError` (lista de mensagens) é definido quando o projeto não carrega ou uma edição o deixa inválido.
`take_screenshot` = `setDebug(annotate)` + `render()` + screenshot do elemento `canvas`.

## Memória

| Tool | Parâmetros |
|---|---|
| `read_memory` | — |
| `update_memory` | `features?, todos?, knownIssues?, notes?` |

## Nomes de teclas

Normalizados por `normalizeKey`: `"d"`, `"D"`, `"KeyD"` → `D`; `"SPACE"`, `" "` → `Space`;
`"left"` → `ArrowLeft`; `"esc"` → `Escape`; `"Digit1"` → `1`.
Controllers usam **actions** (`left`, `right`, `jump`, …) mapeadas em `config.actions`.
