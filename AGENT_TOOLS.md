# Ferramentas do agente

Especificação das tools que o agente usa. Status: **planejado** (implementação nas etapas 3–6).
A base de engine que cada tool usa já existe e está testada (Etapa 1).

Convenções:
- Todas as tools operam **somente** dentro do projeto aberto (caminhos fora de `projects/<nome>/` são rejeitados).
- Parâmetros validados por zod; erros retornam mensagens legíveis com o caminho do campo.
- Toda tool que modifica o projeto gera uma entrada no histórico (diff + autor + motivo) e pode ser desfeita.
- Tools destrutivas (`delete_*`, `write_file` sobrescrevendo) podem exigir confirmação do usuário.

## Projeto e cenas

| Tool | Parâmetros | Retorno |
|---|---|---|
| `get_project_summary` | — | cenas, entidades por cena, assets, scripts, memória do projeto |
| `create_scene` | `id, width?, height?, background?, ...` | cena criada |
| `modify_scene` | `id, patch` | cena após alteração |
| `delete_scene` | `id` | ok |
| `create_game_object` | `scene, entity` (JSON parcial; defaults preenchidos) | entidade normalizada + warnings |
| `modify_game_object` | `scene, id, patch` (name, tags, enabled, transform) | entidade |
| `delete_game_object` | `scene, id` | ok |
| `create_component` / `modify_component` / `remove_component` | `scene, id, type, data?` | componente normalizado |
| `list_component_types` | — | tipos + JSON Schema com descrições |

## Código e arquivos

| Tool | Parâmetros | Retorno |
|---|---|---|
| `list_files` | `dir?` | árvore do projeto |
| `read_file` | `path, startLine?, endLine?` | conteúdo numerado |
| `write_file` | `path, content` | diff |
| `edit_file` | `path, oldText, newText` | diff |
| `create_script` / `modify_script` / `delete_script` | `path, content` | diff |

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

## Memória

| Tool | Parâmetros |
|---|---|
| `read_memory` | — |
| `update_memory` | `features?, todos?, knownIssues?, notes?` |

## Nomes de teclas

Normalizados por `normalizeKey`: `"d"`, `"D"`, `"KeyD"` → `D`; `"SPACE"`, `" "` → `Space`;
`"left"` → `ArrowLeft`; `"esc"` → `Escape`; `"Digit1"` → `1`.
Controllers usam **actions** (`left`, `right`, `jump`, …) mapeadas em `config.actions`.
