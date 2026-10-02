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
| Memória: `read_memory`, `update_memory` | **implementado** (Etapa 8) |

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
| `modify_scene` | `scene, patch` | configurações (não `id`/`entities`; para `rules` prefira `set_rule`) |
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

## Prefabs

Implementado na Etapa 8 (`shared/src/prefabs.ts`, `tools/prefab-tools.ts`). Um prefab é uma entidade sem `id` em
`prefabs/<id>.json`. Uma entidade da cena com `"prefab": "<id>"` é o prefab + os campos dela (JSON Merge Patch):
`{ "id": "enemy3", "prefab": "goomba", "transform": { "x": 900, "y": 406 } }`. Mudar o prefab muda todas as instâncias
(menos o que a instância sobrescreve; `null` remove um campo herdado).

| Tool | Parâmetros | Observação |
|---|---|---|
| `create_prefab` | `id, entity? \| from: {scene, id}, link?` | de dados ou copiando uma entidade (sem a posição); `link` transforma a entidade em instância |
| `modify_prefab` | `id, patch` | validado contra todas as instâncias |
| `delete_prefab` | `id` | recusado enquanto houver instâncias ou regras `spawn` usando |

Em execução: ação de regra `spawn {prefab, x?, y?, at?, id?}` (`at`: id ou `"$by"`, e x/y viram deslocamento) e
`game.spawn(prefab, x, y, id?)` nos scripts. Ids gerados: `<prefab><n>`. Cada criação emite `spawn`. Entidades criadas
somem no restart (não fazem parte da cena). `get_game_object.effective` já mostra o prefab aplicado;
`get_project_summary` lista prefabs e scripts.

## Regras da cena (eventos e condições)

Implementado na Etapa 8 (`shared/src/rules.ts`, `engine/src/rules.ts`, `tools/rule-tools.ts`). Lógica comum sem
script: `quando → se → faça`, guardada em `rules` da cena e avaliada todo frame depois dos sistemas.

| Tool | Parâmetros | Observação |
|---|---|---|
| `set_rule` | `scene, rule` | cria ou substitui (pelo `id`); defaults não são gravados |
| `delete_rule` | `scene, id` | |

```json
{ "id": "abre-porta", "when": { "expr": "vars.coins >= 3" }, "if": "exists('door')",
  "do": [{ "action": "setEnabled", "target": "door", "enabled": false }, { "action": "emit", "event": "door_opened" }],
  "once": true }
```

| `when` | Dispara |
|---|---|
| `{ "start": true }` | uma vez, no início da cena |
| `{ "event": "collect", "match": { "entity": "coin1" } }` | a cada evento do tipo (de sistemas, scripts ou outras regras) |
| `{ "enter": "zona", "tag": "player" }` | quando uma entidade com a tag começa a tocar a zona (`tag` padrão: `player`) |
| `{ "expr": "vars.coins >= 3" }` | quando a expressão passa de falsa para verdadeira |
| `{ "every": 1000 }` | a cada N ms de tempo de jogo |

Ações: `setVar {var, value}`, `addVar {var, amount}`, `emit {event, data?}`, `win`, `lose`, `loadScene {scene}`,
`destroy {target}`, `setEnabled {target, enabled}`, `setText {target, text}`, `damage {target, amount}`,
`heal {target, amount}`, `move {target, x?, y?}`, `modify {target, component, set}`, `log {message}`,
`playSound {asset, volume?}`, `spawn {prefab, x?, y?, at?, id?}`, `after {ms, do: [ações], id?}` (roda as ações
depois de um tempo; ver [Timers](#timers)), `cancelTimer {id}`, `tween {target, prop, to, ms, from?, ease?, yoyo?,
repeat?}` (ver [Tweens](#tweens)), `burst {target, count?}` (rajada de partículas; ver [Partículas](#partículas-particleemitter)).
`target` é um id, `"$by"` (quem entrou na zona, ou o `by`/`entity` do evento) ou `"$entity"` (a zona, ou o `entity`
do evento — por exemplo o objeto de um `interact`). `if` e `when.expr` usam as mesmas
expressões do `wait_until`. Cada disparo gera o evento `rule`. Referências (ids, cenas, componentes) e expressões são
validadas ao gravar; uma regra que falha em execução gera `rule_error`, vai para o console e fica desligada até a
cena recarregar. Eventos emitidos por uma regra são vistos pelas outras no frame seguinte (sem laços infinitos).

## Interações (`Interactable`)

Implementado na V0.2 (`packages/engine/src/interact.ts`). Um componente genérico para tudo que se *usa*: abrir porta,
conversar, pegar item, alimentar, ativar máquina, entrar numa área, clicar num objeto. A engine decide **se** a interação
acontece e avisa; **o que** ela faz fica com regras ou scripts do jogo.

```json
"door": { "components": { "Sprite": {}, "Interactable": { "action": "open", "label": "Abrir", "condition": "vars.keys >= 1", "once": true } } }
```

| Campo | Padrão | Significado |
|---|---|---|
| `action` | `"use"` | verbo que vai no evento (`open`, `talk`, `feed`, `pickup`...) |
| `label` | — | rótulo para o jogador: com interação por tecla em alcance, o jogo desenha `[E] Abrir` acima do objeto |
| `via` | `["click", "key"]` | `click`: clique esquerdo no objeto. `key`: um ator em alcance aperta `key`. `enter`: dispara quando um ator entra no alcance. Scripts sempre podem chamar `game.interact()` |
| `key` | `"interact"` | ação de `config.actions` (padrão `interact: ["E"]`) ou nome de tecla |
| `actorTags` | `["player"]` | quem interage por tecla, por entrada ou como ator de `game.interact` |
| `range` | `32` | distância máxima em px entre a caixa do ator e a do objeto (0 = encostando); não vale para clique |
| `condition` | — | expressão (mesma linguagem do `wait_until`) que precisa ser verdadeira |
| `cooldownMs` | `0` | tempo depois de um sucesso até poder de novo |
| `once` | `false` | desliga (`enabled: false`) depois do primeiro sucesso |
| `enabled` | `true` | `false`: ignorado por clique, tecla e entrada (regras `modify` e scripts podem alternar) |
| `sound` | — | asset de áudio tocado no sucesso |

- **Eventos:** `interact {entity, action, via, by?, label?}` no sucesso; `interact_blocked {entity, action, via, by?,
  reason}` quando uma tentativa falha — `reason`: `disabled`, `actor` (ator sem a tag), `range`, `cooldown` (com
  `cooldownMs` restante), `condition` (falsa) ou `error` (expressão com erro, também vai para o console).
- **Tecla:** usa o objeto mais próximo em alcance (empate: ordem da cena). **Clique:** o objeto de cima sob o mouse
  (como `onClick`); um `Interactable` desligado deixa o clique passar. **Entrada:** uma vez por aproximação (sair do
  alcance e voltar dispara de novo).
- **Regras:** `{"when": {"event": "interact", "match": {"action": "pickup"}}, "do": [{"action": "addVar", "var": "itens",
  "amount": 1}, {"action": "destroy", "target": "$entity"}]}` — `$by` é o ator, `$entity` o objeto.
- **Scripts:** hook `onInteract(self, by, game, info)` no objeto (`by` = ator ou `null` no clique; `info = {action, via}`);
  `game.interact(alvo, ator?)` tenta interagir (via `script`, com as mesmas checagens; devolve `{ok, reason?}`) — é o
  caminho para NPCs/pets usarem objetos; `game.nearbyInteractables(ator)` lista o que o ator alcança, do mais perto.
- **Estado:** `inspect_game_state` mostra em cada entidade com o componente `interactable: {action, label?, via,
  enabled, uses, cooldownMs?, inRange}` (`inRange` = atores em alcance); expressões leem
  `entity('door').interactable.uses`.
- **Agente:** joga como um jogador — `press_key E` perto do objeto, ou `click_mouse {entity: "door"}` (clica no centro
  do objeto na tela, onde quer que a câmera esteja). Não há tool própria de interação: tudo passa pelo input virtual
  e o replay continua exato.
- **Limites:** um `Interactable` por entidade (uma ação; para várias, o script decide por `via`/`by`); a condição não
  enxerga o ator (use `game.interact` num script quando precisar).

## Máquinas de estado (`StateMachine`)

Implementado na V0.2 (`packages/engine/src/fsm.ts`). Para NPCs, inimigos, pets, objetos e chefes simples: a entidade
está sempre em um estado nomeado, e a engine troca de estado sozinha pelas transições. Sem scripts cheios de `if`.

```json
"StateMachine": {
  "initial": "patrol",
  "transitions": [{ "to": "dead", "when": "self.health <= 0" }],
  "states": {
    "patrol": { "transitions": [{ "to": "chase", "when": "distance(self, 'player') < 120" }] },
    "chase":  { "enter": [{ "action": "modify", "target": "$self", "component": "FollowTarget", "set": { "speed": 120 } }],
                "exit":  [{ "action": "modify", "target": "$self", "component": "FollowTarget", "set": { "speed": 0 } }],
                "transitions": [{ "to": "patrol", "when": "distance(self, 'player') > 200", "after": 1000 }] },
    "dead":   { "enter": [{ "action": "destroy", "target": "$self" }] }
  }
}
```

- **Transição** `{to, when?, after?, event?, match?}`: todas as condições dadas precisam valer — `when` (expressão; `self`
  é a própria entidade), `after` (ms mínimos no estado atual), `event` (evento desse tipo no frame; `match` compara
  campos, `"$self"` = id da entidade, ex. `{"event": "interact", "match": {"entity": "$self"}}`). Sem condições = troca
  imediata.
- **Ordem:** a cada frame (depois das regras), primeiro `transitions` do topo (de qualquer estado), depois as do estado
  atual; a primeira que vale é tomada. No máximo uma troca por frame; ir para o estado atual é ignorado.
- **Entrada/saída:** `enter`/`exit` usam as mesmas ações das regras, com `target: "$self"` (ou um id). O estado inicial
  também roda `enter` (no primeiro frame).
- **Eventos:** `state_change {entity, from, to}` (o primeiro tem `from: null`); `state_error {entity, state, message}`
  quando uma expressão/ação falha — a máquina daquela entidade para até recarregar a cena (as outras seguem).
- **Estado observado:** `inspect_game_state` traz `state`, `stateMs` (tempo no estado) e `prevState`; expressões leem
  `entity('guard').state == 'chase'` (bom para `wait_until` e `run_test`).
- **Scripts:** `self.fsm.state`, `.previous`, `.time` (s no estado), `.is('a', 'b')`, `.go('estado')` (troca agora,
  com exit/enter; devolve `false` se já está nele; estado inexistente é erro). Hook `onStateChange(self, {from, to}, game)`.
  O efeito contínuo de um estado (andar, perseguir) fica no `onUpdate`, lendo `self.fsm.state`.
- **Validação ao gravar:** `initial` e cada `to` precisam existir; alvos de ações são `"$self"` ou ids da cena; `when`
  com erro de sintaxe é recusado.
- **Limites:** uma máquina por entidade; sem estados hierárquicos; `"$by"`/`"$entity"` não existem nas ações de estado.

## Utility AI (`UtilityAI`)

Implementado na V0.2 (`packages/engine/src/utility.ts`). A entidade escolhe **o que fazer** dando nota a cada opção com
expressões sobre o estado do jogo. A engine não impõe fatores: necessidades e personalidade (`self.props`), distância,
horário (`clock.hour`), variáveis, estado, cooldown... quem define é o jogo.

```json
"UtilityAI": {
  "intervalMs": 500,
  "options": {
    "eat":   { "score": "1 - self.props.hunger / 100", "when": "exists('food')" },
    "sleep": { "score": "1 - self.props.energy / 100 + (clock.hour >= 22) * 0.3" },
    "play":  { "score": "self.props.playful * 0.6", "cooldownMs": 30000 },
    "flee":  { "score": "clamp(150 - distance(self, 'wolf'), 0, 150) / 100", "state": "running" }
  }
}
```

| Campo | Padrão | Significado |
|---|---|---|
| `options.<nome>.score` | — | número ou expressão; ≤ 0 = não escolhida |
| `options.<nome>.when` | — | só concorre se a expressão for verdadeira |
| `options.<nome>.cooldownMs` | `0` | depois de deixar de ser a escolha, espera isso antes de voltar |
| `options.<nome>.state` | — | estado da `StateMachine` a entrar (padrão: um estado com o nome da opção, se existir) |
| `select` | `"best"` | `best`: maior nota (empate: primeira opção). `weighted`: sorteio proporcional às notas (seed do jogo) |
| `intervalMs` | `500` | intervalo entre decisões; `0` = só quando um script chama `self.ai.decide()` |
| `decideWhen` | — | só decide enquanto a expressão vale (ex. `"self.state == 'idle'"`) |
| `inertia` | `0.1` | somado à escolha atual no `best`, para notas próximas não ficarem trocando |
| `noise` | `0` | soma um aleatório em [0, noise) a cada nota (seed: variado e reproduzível) |

- **Escolha nova:** evento `ai_choice {entity, choice, from, score}`, entra no estado correspondente e chama o hook
  `onDecision(self, {choice, from, scores}, game)`. Sem opção disponível, a escolha fica como está.
- **Ver o porquê:** `inspect_game_state` traz `ai: {choice, scores}` (nota de cada opção na última decisão; `null` =
  indisponível por `when` ou cooldown) e `props` (os `Script.props` da entidade, que scripts podem atualizar — ex.
  necessidades). Expressões: `entity('npc').ai.choice`, `entity('npc').ai.scores.eat`.
- **Scripts:** `self.ai.choice`, `self.ai.scores`, `self.ai.decide()` (decide agora e devolve a escolha).
- **Erro** numa expressão: `ai_error {entity, message}` e a IA daquela entidade para até recarregar a cena.
- **Validação ao gravar:** `state` precisa existir na `StateMachine` da entidade; expressões com erro de sintaxe são
  recusadas.

## Animação (`Animator`)

Atualizado na V0.2 (`packages/engine/src/systems/animation.ts`). Basta o estado do jogo mudar (`state = "walk"`) para o
clipe certo tocar — sem `if (state == ...)` em script para trocar sprite.

```json
"Animator": {
  "initial": "idle",
  "states": { "sleeping": "sleep" },
  "animations": {
    "idle":   { "frames": ["cat_idle1", "cat_idle2"], "fps": 2 },
    "walk":   { "frames": [0, 1, 2, 3], "fps": 10, "asset": "cat_walk", "events": { "1": "footstep", "3": "footstep" } },
    "sleep":  { "frames": ["cat_sleep"] },
    "attack": { "frames": [4, 5, 6], "fps": 12, "loop": false, "next": "idle" }
  }
}
```

| Campo | Padrão | Significado |
|---|---|---|
| `animations.<clipe>.frames` | — | índices da spritesheet ou ids de imagens (um asset por quadro) |
| `.fps` / `.loop` | `8` / `true` | `loop: false` toca uma vez, segura o último quadro e emite `anim_end` |
| `.asset` | — | spritesheet do clipe (padrão: a do `Sprite`) |
| `.next` | — | clipe seguinte quando um clipe sem loop termina |
| `.events` | — | quadro → tipo de evento emitido quando ele aparece (`{entity, anim, frame}`); com `config.sounds` vira som |
| `initial` | `"idle"` | clipe base |
| `auto` | `true` | com `Body`: escolhe `jump`/`fall`/`run`/`idle` pelo movimento |
| `states` | — | estado da `StateMachine` → clipe (sem entrada: clipe com o nome do estado, se existir) |
| `speed` | `1` | multiplicador de velocidade (0 = pausado) |

- **Qual clipe toca:** o tocado por script > o do estado da `StateMachine` > o automático (`auto` com `Body`) > o clipe
  base (`initial`, seguindo `next`).
- **Scripts:** `self.anim.name`, `self.anim.frame`, `self.anim.play('attack')` (por cima do estado; um clipe sem loop
  termina sozinho e segue o `next`; tocar de novo reinicia), `self.anim.stop()`, `self.anim.speed`.
- **Estado:** `inspect_game_state` mostra `anim: {clip, frame}`; expressões leem `entity('cat').anim.clip`.
- **Validação ao gravar:** `next`, `states` e índices de `events` precisam existir; quadros de imagem precisam ser
  assets de imagem/spritesheet; `asset` do clipe precisa ser spritesheet; `states` só com estados da `StateMachine`.

## Timers

Implementado na V0.2 (`packages/engine/src/timers.ts`). Tempo de jogo contado em frames (nunca o relógio real): mesma
seed e mesmo input ⇒ os timers disparam nos mesmos frames.

- **Scripts** (timers da entidade; somem se ela for destruída e esperam enquanto ela estiver desligada):
  `self.after(ms, fn, id?)` (uma vez), `self.every(ms, fn, id?)` (repete), `self.cancel(id)`, `self.timers` (lista) e
  `self.cooldown(nome, ms)` (devolve `true` e inicia o cooldown se ele não estiver correndo; `false` se estiver —
  ex. `if (self.cooldown('latir', 2000)) game.playSound('latido')`). Agendar o mesmo `id` de novo reinicia o timer.
  Erro dentro do `fn` é erro de script daquela entidade (`script_error`).
- **Regras e estados:** ação `after {ms, do, id?}` adia uma lista de ações (sem outro `after` dentro); `cancelTimer {id}`
  cancela. Numa regra o timer é global e o `$by` do disparo vale no `do`; num estado da `StateMachine` o timer é da
  entidade (`$self`). Erro numa ação adiada: `timer_error` + console.
- **Estado:** `inspect_game_state` mostra `timers: [{id, ms, every?}]` (tempo que falta, do mais próximo) e
  `cooldowns: {nome: ms}` por entidade; expressões leem `entity('lamp').cooldowns.x`.
- **Ordem no frame:** timers vencidos disparam depois das regras e das máquinas de estado, antes da animação.
- O mesmo para "depois de X segundos" sem código: `after` numa regra, `every` como gatilho de regra, `after` numa
  transição da `StateMachine`, `cooldownMs` do `Interactable` e da `UtilityAI`.

## Tweens

Implementado na V0.2 (`packages/engine/src/tweens.ts`). Mudança suave de um número ao longo do tempo — botão que pulsa,
item que flutua, dano que pisca, entrada/saída de UI, efeito que some. Em frames (reproduzível).

- **Propriedades:** `x`, `y`, `rotation`, `scaleX`, `scaleY`, `scale` (as duas), `opacity` (do `Sprite` e do `Text`) ou
  qualquer campo numérico `Componente.campo` (`Text.fontSize`, `Sprite.width`...).
- **Curvas:** `linear`, `easeIn`, `easeOut`, `easeInOut` (padrão). `yoyo: true` vai e volta; `repeat` = passadas extras
  (`-1` = para sempre); `from` define o valor inicial (padrão: o atual).
- **Scripts:** `self.tween(prop, para, ms, {from, ease, yoyo, repeat, id, onDone})` → id; `self.stopTween(id ou prop)`
  (o valor fica onde está); `self.tweens`. Ex.: `self.tween('opacity', 0, 800, { ease: 'easeIn', onDone: () =>
  self.destroy() })`.
- **Sem código:** ação `tween {target, prop, to, ms, ...}` em regras e estados, ex. pulsar o objeto usado:
  `{"when": {"event": "interact"}, "do": [{"action": "tween", "target": "$entity", "prop": "scale", "to": 1.2, "ms": 100,
  "yoyo": true}]}`; flutuar para sempre: `yoyo: true, repeat: -1` numa regra `start`.
- **Regras:** um tween novo na mesma propriedade da mesma entidade substitui o anterior; tweens são da entidade (somem se
  ela for destruída, esperam se estiver desligada); ao terminar: evento `tween_end {entity, prop, id}`.
- **Estado:** `inspect_game_state` mostra `tweens: [{id, prop, to, ms?}]` por entidade (`ms` ausente = para sempre).
- **Cuidado:** tween de `x`/`y` em corpo dinâmico briga com a física; e um script que escreve a mesma propriedade todo
  frame sobrescreve o tween.

## Pathfinding (`NavAgent`, `findPath`)

Implementado na V0.2 (`packages/engine/src/nav.ts`). Navegação em grade para jogos vistos de cima (NPCs, pets, inimigos
indo até objetos). Não resolve plataforma com pulo.

- **Grade e A\*:** a cena vira uma grade de `cell` px; células onde o agente (com o tamanho da caixa dele) encostaria em
  um obstáculo ficam bloqueadas. Obstáculos: colliders sólidos (não-trigger, sem corpo dinâmico) e entidades com uma das
  `avoidTags`. 8 direções sem cortar quinas (ou 4 com `diagonal: false`); desempate fixo — mesma cena, mesmo caminho.
  O caminho volta como pontos (só onde ele faz curva) terminando no alvo; se o alvo estiver dentro de um obstáculo, para
  na célula livre mais próxima.
- **`NavAgent`** `{target, speed, cell, diagonal, arriveDistance, repathMs, avoidTags}`: `target` é um id de entidade
  (seguida se ela se mover) ou um ponto `{x, y}`; `null` = parado. Anda pelo caminho e replaneja a cada `repathMs`
  (inclusive depois de falhar, então anda quando uma porta abre). Com `Body` não estático, dirige pela velocidade (a
  física continua bloqueando); sem `Body`, move a posição. Eventos `nav_arrived` e `nav_failed` `{entity, target}`.
- **Sem código:** um estado manda andar com `{"action": "modify", "target": "$self", "component": "NavAgent", "set":
  {"target": "cama"}}` e sai do estado com a transição `{"event": "nav_arrived", "match": {"entity": "$self"}}`.
- **Scripts:** `self.nav.goTo(id | entidade | {x, y})`, `self.nav.stop()`, `self.nav.status`
  (`idle|moving|arrived|failed`), `self.nav.path`, `self.nav.target`; `game.findPath(de, para, {cell, diagonal,
  avoidTags})` → `{points, length}` ou `null` (de/para: entidade, id ou ponto; se `de` é entidade, a caixa dela é a folga).
- **Para o agente:** `inspect_game_state` mostra `nav: {target, status, next?, waypoints?}`; expressões têm
  `pathDistance(a, b)` (comprimento do caminho, `null` se inalcançável — ex. `run_test` com
  `"pathDistance('player', 'chave') != null"`); o screenshot com `annotate` desenha o caminho restante (laranja
  tracejado).
- **Limites:** grade fixa por cena (sem navmesh); a posição do agente é o centro da entidade (offset do collider é
  ignorado na folga); sem desvio entre agentes (eles se atravessam).

## Partículas (`ParticleEmitter`)

Implementado na V0.2 (`packages/engine/src/particles.ts`). Efeitos leves: fumaça, poeira, corações, estrelas, confete,
impacto, faíscas. Partículas não são entidades (não aparecem em `entities`): ficam numa lista da cena, simulada na
engine. A aleatoriedade vem de uma RNG separada derivada da seed: reproduzível (igual no headless e no screenshot) e sem
mudar os sorteios do jogo.

```json
"ParticleEmitter": { "rate": 0, "burst": 0, "colors": ["#8b6b4a", "#a8865f"], "speed": 130, "angle": -90, "spread": 150,
                     "gravity": 260, "lifeMs": 700, "size": 9, "sizeEnd": 3 }
```

| Campo | Padrão | Significado |
|---|---|---|
| `emitting` / `rate` | `true` / `10` | emissão contínua em partículas/s (`rate: 0` = só rajadas) |
| `burst` | `0` | rajada quando a entidade começa (e quantidade padrão de uma rajada) |
| `max` | `100` | máximo vivo deste emissor (e 2000 por cena) |
| `lifeMs`, `speed`, `size`, `sizeEnd` | 1000, 60, 6, = size | vida, velocidade (px/s), tamanho inicial e final |
| `angle`, `spread` | `-90`, `360` | direção em graus (0 = direita, -90 = cima) e abertura |
| `gravity`, `drag` | `0`, `0` | px/s² (positivo = para baixo) e perda de velocidade por segundo |
| `colors`, `shape`, `text` | branco, `circle` | cores (sorteia uma), `circle`/`rect`, ou um caractere (`"♥"`, `"★"`) |
| `fade`, `jitter` | `true`, `0.3` | some ao longo da vida; variação aleatória de vida/velocidade/tamanho |
| `offsetX/Y`, `layer` | 0, `50` | ponto de emissão e camada de desenho |

- **Sem código:** ação `burst {target, count?}` em regras e estados (ex. no `interact`, no `collect`, ao entrar num
  estado); liga/desliga emissão contínua com `modify {component: "ParticleEmitter", set: {emitting: false}}`.
- **Scripts:** `self.particles.burst(n?)`, `self.particles.emitting`, `self.particles.alive`;
  `game.emitParticles(x, y, n, opções)` solta partículas em qualquer ponto sem precisar de entidade (opções = campos do
  `ParticleEmitter`; inválidas dão erro).
- **Para o agente:** cada rajada gera o evento `particles {entity | x, y, count}` (verificável em `read_events` /
  `events('particles')`); a entidade emissora mostra `particles: {alive, emitting}` no estado; o visual aparece no
  screenshot. As partículas continuam depois que o emissor é destruído.

## Assets e som

Implementado na Etapa 8 (`tools/asset-tools.ts`, `sfx.ts`, `engine/src/sound.ts`, `runtime/src/audio.ts`).

| Tool | Parâmetros | Observação |
|---|---|---|
| `import_asset` | `source, id, type?, path?, frameWidth?, frameHeight?, replace?` | copia de um caminho absoluto (png/jpg/gif/webp/svg, wav/mp3/ogg; máx. 20 MB) para `assets/` e declara em `project.json` |
| `create_sound` | `id, preset, pitch?, duration?, volume?, seed?, replace?` | gera um efeito retrô em `assets/sfx/<id>.wav` (presets: coin, jump, hit, powerup, explosion, blip, laser, win, lose) |

- O arquivo binário não entra no histórico; a declaração em `project.json` sim (e é validada: se for recusada, o
  arquivo copiado é removido).
- **Som é evento.** `config.sounds` mapeia tipos de evento para assets de áudio
  (`{"jump": "sfx_jump", "collect": {"asset": "sfx_coin", "volume": 0.5}}`); `scene.music` toca em loop enquanto a cena
  roda; regras têm a ação `playSound` e scripts `game.playSound(id, volume?)`. A run emite `sound`
  (`{asset, volume, cause}`) e `music` (`{asset | null}`): o agente verifica pelos eventos, sem ouvir; o browser toca
  com Web Audio (depois do primeiro clique/tecla, regra dos navegadores) e a barra do jogo tem a caixa **Som**.

## Código e arquivos

| Tool | Parâmetros | Retorno |
|---|---|---|
| `list_files` | `dir?` | arquivos com tamanho (sem `.vibe/`) |
| `read_file` | `path, startLine?, endLine?` | texto numerado, máx. 2000 linhas por chamada; binário → só o tamanho |
| `write_file` | `path, content` | cria/sobrescreve; JSON do projeto e scripts são validados |
| `edit_file` | `path, oldText, newText, replaceAll?` | `oldText` precisa ser único (ou `replaceAll`) |
| `delete_file` | `path` | `project.json` não pode ser apagado |

### Scripts

Implementado na Etapa 8. Comportamento que os componentes prontos não cobrem vai em `scripts/<nome>.js`
(subpastas valem), ligado a uma entidade pelo componente `Script` (`{ "src": "scripts/x.js", "props": {...} }`).
Os papéis de `create_script` / `modify_script` / `delete_script` ficam com `write_file` / `edit_file` / `delete_file`:
script é um arquivo do projeto como os outros (validado, no histórico, desfazível).

```js
// scripts/bobbing.js — uma cópia por entidade (variáveis de topo não são compartilhadas)
let base;
function onStart(self, game) { base = self.y; }
function onUpdate(self, game, dt) { self.y = base + Math.sin(game.time * self.props.speed) * 6; }
function onCollision(self, other, game) {
  if (other.hasTag('player')) { game.vars.bonus = (game.vars.bonus || 0) + 1; game.emit('bonus'); self.destroy(); }
}
```

| Hook | Quando |
|---|---|
| `onStart(self, game)` | primeiro frame da entidade |
| `onUpdate(self, game, dt)` | todo frame, depois dos controllers e antes da física |
| `onCollision(self, other, game)` | quando um contato começa (dos dois lados) |
| `onClick(self, game, pos)` | clique esquerdo na entidade (a de cima, por `Sprite.layer`, cuja caixa Collider/Sprite contém o ponto) |
| `onEvent(self, event, game)` | cada evento do jogo (fim do frame), inclusive os emitidos por scripts e regras |
| `onInteract(self, by, game, info)` | o `Interactable` da entidade foi usado (ver [Interações](#interações-interactable)) |
| `onStateChange(self, change, game)` | a `StateMachine` da entidade trocou de estado: `change = {from, to}` (ver [Máquinas de estado](#máquinas-de-estado-statemachine)) |
| `onDecision(self, decision, game)` | a `UtilityAI` da entidade escolheu algo novo: `{choice, from, scores}` (ver [Utility AI](#utility-ai-utilityai)) |

- `self`: `id, name, tags, hasTag(t), x, y, vx, vy` (velocidade exige `Body`), `grounded, enabled, destroyed, health,
  props, state` (armazenamento livre), `get(tipo)` (dados vivos do componente), `damage(n)`, `destroy()`.
- `game`: `frame, time, dt, scene, status, vars` (vivas), `entity(id)`, `find(tag)`,
  `input.isDown/pressed/released(ação ou tecla)`, `input.mouse`, `emit(tipo, dados)` (evento visível em
  `read_events`/`events('tipo')`), `random()`, `randomInt(a, b)`, `win()`, `lose()`, `loadScene(id)`.
- `self` também tem `scaleX, scaleY, rotation` (visuais); `game` tem `entityAt(x, y)`, `input.mouseWorld`,
  `input.mouseDown/mousePressed(botão)`, `input.hovered` (o que um clique no mouse atingiria agora, ou `null` — para
  efeitos de hover) e `input.text` (texto digitado no frame, em ordem; `\b` = Backspace, `\n` = Enter).
- **Relógio** `game.clock`: `now` (epoch ms), `hour` (0..24, local), `iso`, `speed` (alterável: 60 = 1 minuto de jogo por
  segundo). É a data/hora do calendário do jogo — no browser começa na data real; nas runs, em `clock.start` (padrão
  2026-01-01 09:00 UTC). Expressões leem `clock.hour`, `clock.now`.
- **Dados salvos** `game.storage`: `get/set/remove/keys`, valores JSON, até 512 KB. No browser jogado ficam em disco,
  em `projects/<nome>/.vibe/save.json` (pelo dev server; o Simple Browser do VS Code não guarda `localStorage` entre
  sessões), com cópia no `localStorage`; sobrevivem a fechar o jogo e o VS Code; botão **Apagar save** na barra. Nas
  runs começam de `run_game.storage`. Para tempo
  offline: salve `clock.now` e, no `onStart`, compare com o relógio atual.
- Entidades com a tag `clickable` (sem script) também recebem clique: gera o evento `click {entity}` para regras.
- `game.interact(alvo, ator?)` e `game.nearbyInteractables(ator)`: ver [Interações](#interações-interactable).
- `self.fsm` (`state, previous, time, is(...), go(estado)`): ver [Máquinas de estado](#máquinas-de-estado-statemachine).
- `self.ai` (`choice, scores, decide()`): ver [Utility AI](#utility-ai-utilityai).
- `self.tween/stopTween/tweens`: ver [Tweens](#tweens).
- `self.nav` e `game.findPath`: ver [Pathfinding](#pathfinding-navagent-findpath).
- `self.particles` e `game.emitParticles`: ver [Partículas](#partículas-particleemitter).
- `self.after/every/cancel/timers/cooldown`: ver [Timers](#timers). Não há `setTimeout` (tempo real quebraria o replay).
- Também `console.log/warn/error` (vão para o console do jogo) e `Math` com `Math.random` usando a seed da run.
- **Determinismo:** `Date`, timers, rede, `process`, `window` e `globalThis` não existem para o script. É uma API
  restrita para lógica de jogo, não uma sandbox de segurança.
- **Erros:** sintaxe quebrada é recusada na gravação com `scripts/x.js:linha` (checada com `node:vm`). Erro em
  execução vai para o console como `scripts/x.js:linha:coluna in onUpdate of "id": TypeError...`, gera o evento
  `script_error` e desliga o script daquela entidade até reiniciar — o jogo continua rodando.

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
| `run_game` | `scene?, seed?, clock?, storage?` | nova run com o projeto atual (substitui a anterior); `clock` = `{start, utcOffsetMinutes, speed}`, `storage` = dados salvos iniciais |
| `restart_game` | — | recomeça com os **arquivos atuais** (mesma cena/seed) — use depois de editar |
| `stop_game` | — | encerra a run |
| `press_key` / `release_key` | `key` | tecla fica pressionada até soltar; não avança o tempo |
| `move_mouse` / `click_mouse` | `x?, y?, entity?` / `x?, y?, entity?, button?, double?` | coordenadas do viewport, ou `entity`: mira o centro da entidade na tela (erro se não existe ou está fora da tela); o clique avança 1 frame; `double` = duplo clique |
| `press_mouse` / `release_mouse` | `x?, y?, entity?, button?` | aperta / solta um botão (movendo antes, se dado); não avança o tempo |
| `drag_mouse` | `from, to` (`{x, y}` ou `{entity}`), `ms?` (300), `button?` | arrasta: aperta em `from`, anda quadro a quadro até `to`, solta (ver [Controle do mouse](#controle-do-mouse)) |
| `wait` | `ms` (máx. 60000) | avança o tempo simulado |
| `wait_until` | `expr, maxMs?` | avança até a expressão valer (ou timeout / fim de jogo); `ok`, `waitedMs` |
| `advance_clock` | `hours?, minutes?, ms?` | pula o relógio do calendário (sem simular os frames) e avança 1 frame — como fechar o jogo por um tempo |
| `perform_inputs` | `steps` | sequência `keyDown/keyUp/tap/hold/wait/mouseMove/mouseDown/mouseUp/click/doubleClick/drag/type` (`type`: texto digitado; `\b` = Backspace, `\n` = Enter; `mouseMove`, `click` e `doubleClick` aceitam `entity`) |
| `observe` | `screenshot?, annotate?, entities?, components?` | tudo do momento numa chamada (ver [Observação](#observação-unificada-observe)) |
| `get_mouse_target` | — | o que está sob o mouse e o que um clique ali atingiria (ver [Percepção do mouse](#percepção-do-mouse-get_mouse_target)) |
| `inspect_game_state` | `ids?, tags?, components?, storage?, onScreen?` | estado completo (vars, câmera, relógio, entidades com posição, velocidade, vida, `interactable`...); `storage` inclui os dados salvos |
| `read_events` | `sinceFrame?, type?, limit?` | eventos de gameplay com frame |
| `read_console` | `since?, level?` | logs, avisos, erros com stack |
| `take_screenshot` | `annotate?` | PNG (imagem anexada ao resultado), `path`, `frame`, `camera`; `renderWarnings` se algum sprite não pôde ser desenhado |
| `run_test` | `steps, assertions, scene?, seed?, clock?, storage?` | roda num jogo novo (não mexe na run atual) e relata cada checagem; passo `advanceClock` |
| `verify_game` | `scenario, steps, assertions, tags?, screenshot?, annotate?, allowErrors?, scene?, seed?, clock?, storage?, saveAs?` | verificação completa numa chamada: joga o cenário num jogo novo, checa, fotografa e devolve relatório PASS/FAIL (ver [Verificação](#verificação-verify_game)); `saveAs` guarda como playbook se passar |
| `save_playbook` | `id` + campos do `verify_game` | grava `playbooks/<id>.json` (validado, no histórico; substitui o mesmo id) |
| `list_playbooks` | — | playbooks salvos (id, cenário, tags, passos, checagens) e arquivos inválidos |
| `run_playbooks` | `ids?, tags?, screenshots?` | roda os playbooks (todos ou filtrados) e devolve o placar com as linhas que falharam |
| `delete_playbook` | `id` | apaga um playbook (desfazível) |
| `open_game_view` | `follow?, scene?, debug?` | URL da página do jogo para o usuário abrir no VS Code (ver abaixo) |

**Observação após cada ação.** `run_game`, `restart_game`, `wait`, `wait_until`, `perform_inputs` e `click_mouse`
devolvem o que aconteceu desde a ação anterior: `frame`, `status`, `scene`, `keysDown`, `players` (entidades com
tag `player`), `events` novos (máx. 30) e avisos/erros novos do console. Se os arquivos do projeto mudaram depois
do início da run, vem `projectChanged` pedindo `restart_game`.

### Observação unificada (`observe`)

Implementado na V0.4. Uma chamada devolve o momento atual da run, sem avançar o tempo. O estado responde "o que
aconteceu?" e o screenshot responde "como isso está aparecendo?"; os dois vêm juntos.

| Campo | Conteúdo |
|---|---|
| `game` | `frame`, `time`, `status`, `scene`, `clock`, `vars` |
| `players` | entidades com tag `player` (onde estiverem) |
| `entities` | entidades **na tela** (padrão), cada uma com `screen: {x, y, w, h}` em pixels do viewport; `entities: "all"` lista todas, `"none"` nenhuma; máx. 60 (`entitiesTruncated`); `entityCount` = total na cena |
| `input` | `keysDown`; `mouse: {x, y, world: {x, y}, buttons, hovered, target}` (ids; ver `get_mouse_target`) |
| `camera` | `x`, `y`, `zoom`, `width`, `height` |
| `events`, `console` | eventos e avisos/erros novos desde a ação anterior (incremental, como em `wait`) |
| `screenshot` | `path`, `frame` (+ imagem anexada); `screenshot: false` desliga; uma foto que falha vira `{error}` |

"Na tela" = entidade ativa cuja caixa (Collider ou Sprite; um ponto para Text) cruza o viewport **e** que é desenhada
(Sprite visível com opacidade > 0, ou Text não vazio) ou tem Collider (paredes e gatilhos invisíveis contam).
`inspect_game_state {onScreen: true}` usa o mesmo filtro.

### Percepção do mouse (`get_mouse_target`)

Implementado na V0.4 (`engine/src/mouse.ts`, `Game.mouseTarget()`). Diz, sem disparar nada, o que está sob o mouse
virtual e o que um clique esquerdo ali faria — com a **mesma regra do clique real** (entidade mais alta que aceita
clique: `Interactable` com `click`, script com `onClick` ou tag `clickable`).

```json
{ "screen": {"x": 430, "y": 470}, "world": {"x": 430, "y": 470}, "buttons": [], "insideViewport": true,
  "target":  { "id": "tigela", "distance": 0, "clickable": true, "handlers": ["interactable"], "screen": {...}, "layer": 6,
               "interactable": { "action": "encher", "enabled": true, "uses": 0, "ready": true } },
  "hovered": { "id": "tigela", ... },
  "under":   ["tigela", "pet", "chao"],
  "lastClick": { "frame": 1, "x": 480, "y": 465, "world": {...}, "entity": "botaoComecar" } }
```

- `target`: o que o clique atingiria (`null` = nada clicável). Para um `Interactable`: `ready` e, se não, `blocked`
  (`disabled`, `cooldown` com `cooldownMs`, `condition`...), o mesmo motivo que daria `interact_blocked`.
- `hovered`: a entidade desenhada no topo sob o mouse (pode não ser clicável — um tapete sobre a cama). `under`: a pilha
  inteira, do topo para baixo.
- `nearest`: quando nada clicável está sob o mouse, o alvo clicável mais próximo na tela, com `distance` em px ("errou a
  cama por 23 px").
- `lastClick`: o último clique esquerdo (também em espaço vazio: `entity: null`), mesmo depois de trocar de cena.
- `drag`: o arrasto em andamento (`entity`, `startX/Y`, `x/y` no mundo).
- Em expressões/asserções: `mouse` (`x`, `y`, `worldX`, `worldY`, `target`, `hovered`, `buttons`), ex.
  `mouse.target == 'cama'`. Em scripts: `game.input.hovered`.

### Controle do mouse

Implementado na V0.4. Tudo passa pelo input virtual: os gestos viram as mesmas `GameOp` primitivas (`mouseMove`,
`mouseDown`, `mouseUp`, `step`), então replay, screenshot e modo seguir reproduzem tudo exatamente. Nada chega ao
mouse do sistema operacional.

- **Passos** (em `perform_inputs`, `run_test`, `verify_game` e playbooks): `mouseMove {x, y | entity}`,
  `mouseDown`/`mouseUp`, `click {x, y | entity}`, `doubleClick {x, y | entity}` (dois cliques com 1 frame entre eles) e
  `drag {from, to, ms?}` (aperta, move a cada frame em linha reta, solta).
- **O que a engine percebe** (`InteractionRunner`):
  - **Duplo clique:** segundo clique em até 300 ms e 6 px do anterior; o evento `click` vem com `clicks: 2`
    (`lastClick.clicks` também). Scripts: `game.input.doubleClicked` (verdadeiro no frame do segundo clique).
  - **Arrasto:** botão esquerdo segurado e o mouse andou mais de 4 px. Eventos `drag_start {entity, x, y}` e
    `drag_end {entity, x, y, drop}` (`entity` = o que foi pego: um alvo de clique ou uma entidade com tag `draggable`;
    `drop` = a entidade desenhada sob o mouse ao soltar). Scripts: `game.input.drag` (`entity`, `startX/Y`, `x/y`).
  - **Tag `draggable`:** a entidade segue o mouse enquanto é arrastada (mantendo o ponto onde foi pega) — sem código.
- **O clique acontece ao apertar**, não ao soltar: começar um arrasto sobre uma entidade clicável também a clica (no
  meu-pet, arrastar a bola a joga). Para algo só arrastável, use a tag `draggable` sem `Interactable`/`onClick`.

### Expressões

Usadas por `wait_until`, passos `waitUntil`/`assert` e `assertions` do `run_test`. São interpretadas por um
parser próprio (`packages/engine/src/expr.ts`), sem `eval`.

- Nomes: `status`, `frame`, `time`, `scene`, `vars`, `camera`, `clock`, `mouse` (`x`, `y`, `worldX`, `worldY`, `target`,
  `hovered`); `self` só em expressões de `StateMachine`,
  `UtilityAI` e `Interactable` (a própria entidade)
- Funções: `entity(id)` (snapshot ou `null`; inclui `state`/`stateMs`/`prevState`, `ai`, `props` e `interactable` quando
  há), `exists(id)`, `count(tag)`, `events(type)`, `distance(a, b)` (entre centros; ids ou entidades; `null` se faltar
  uma), `pathDistance(a, b)` (comprimento do caminho de `a` até `b` desviando de obstáculos; `null` se não há),
  `abs`, `min`, `max`, `clamp(x, min, max)`
- Booleanos viram 0/1 em contas: `(self.props.fome < 30) * 2`
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

### Verificação (`verify_game`)

Implementado na V0.3. Executa → interage → observa → verifica → reporta numa chamada só, num jogo novo (a run atual
não muda). Os passos são os do `run_test` (input, `waitUntil`, `assert`, `advanceClock`) mais
`{"type": "screenshot", "label"?, "annotate"?}`; `waitUntil`/`assert` e as `assertions` aceitam `name` para o relatório
ficar legível.

```json
{
  "scenario": "limpar a sujeira solta poeira e some",
  "clock": { "speed": 3600 },
  "steps": [
    { "type": "type", "text": "Bolinha" },
    { "type": "click", "entity": "botaoComecar" },
    { "type": "assert", "name": "entrou no quarto", "expr": "scene == 'quarto'" },
    { "type": "waitUntil", "name": "apareceu sujeira", "expr": "count('sujeira') > 0", "maxMs": 30000 },
    { "type": "click", "entity": "sujeira1" },
    { "type": "wait", "ms": 150 },
    { "type": "screenshot", "label": "poeira" }
  ],
  "assertions": [{ "name": "sujeira limpa", "expr": "!exists('sujeira1')" }, "events('particles') >= 1"]
}
```

Retorno:

```json
{
  "scenario": "...", "passed": false, "summary": "FAIL: 3/4 checks passed",
  "report": ["PASS entrou no quarto", "PASS apareceu sujeira",
             "FAIL sujeira limpa — !exists('sujeira1'); observed exists(\"sujeira1\") = true (frame 414)",
             "PASS events('particles') >= 1"],
  "checks": [...], "screenshots": [{ "step": 6, "label": "poeira", "frame": 414, "path": ".vibe/runs/..." }, { "label": "final", ... }],
  "final": { "frame", "simulatedMs", "status", "scene", "vars", "clock" }, "eventCounts": {...}, "errors": [], "warnings"?: [...]
}
```

- `passed` exige todas as checagens verdadeiras **e nenhum erro de runtime** (crash de script, regra quebrada...);
  `allowErrors: true` só anota os erros. Sem checagens, o relatório avisa (`NOTE no checks`).
- `screenshot` (padrão `true`) fotografa o frame final; as imagens vêm anexadas (máx. 6 por verificação). Uma foto
  que falha (sem Chromium, por exemplo) vira `NOTE` no relatório, sem derrubar a verificação.
- Use `run_test` para checagens rápidas só numéricas; `verify_game` para verificar uma feature com relatório e imagem.

#### Asserções estruturadas

Implementadas na V0.3 (`shared/src/assertions.ts` + `engine/src/assertions.ts`). Checagens sem código nem expressão,
lidas direto do estado estruturado da engine. Cada uma devolve `expected`, `actual` e, quando falha, `evidence`.
Entram em `assertions` do `verify_game` (`{"assert": ..., "name"?}`) e nos passos `{"type": "assert" | "waitUntil",
"check": {...}}`, no lugar de `expr`. Expressões continuam valendo; as duas formas se misturam.

| `assert` | Campos | Evidência quando falha |
|---|---|---|
| `entityExists` | `id, exists?` (padrão `true`) | posição se existe; ids parecidos se não |
| `entityAt` | `id, x?, y?, tolerance?` (4 px) | posição real e quanto está fora (`off: {dx, dy}`) |
| `entityNear` | `id, target, within` | posições das duas |
| `entity` | `id, field` (caminho no estado: `health`, `interactable.uses`, `ai.choice`, `props.fome`) + comparação | campos que existem |
| `component` | `id, component, field?` + comparação | componentes / campos que existem |
| `state` | `id, is` (estado da `StateMachine`) | `stateMs`, `prevState`, últimas trocas (`idle->alert @120`) |
| `variable` | `var` + comparação | variáveis que existem |
| `count` | `tag` + comparação (sem comparação = pelo menos 1) | — |
| `eventOccurred` | `event, match?` + comparação sobre a quantidade (sem = pelo menos 1; `equals: 0` = nunca) | últimos eventos que casaram, eventos do tipo que não casaram, tipos vistos |
| `scene` | `is` | — |
| `gameWon` / `gameLost` / `status` | — / — / `is` | eventos de fim (`win`, `lose`, `death`, `crash`) |

Comparação: `equals`, `notEquals`, `gt`, `gte`, `lt`, `lte` (combináveis: `{"gte": 2, "lt": 5}`); sem nenhuma = o
valor precisa existir. Linha do relatório:

```
FAIL entity "player" at x 2000 (±10) — expected x 2000, y any (±10), got {"x":317.5,"y":402}; evidence {"off":{"dx":-1682.5,"dy":0}} (frame 120)
```

#### Relatório de diagnóstico

Implementado na V0.3 (`server/src/runtime/diagnosis.ts`). Quando a verificação falha, o resultado traz `diagnosis` e o
relatório ganha uma linha `LIKELY` com os 3 sistemas mais prováveis, cada um com o motivo mais forte. É heurístico e
genérico: usa só componentes, eventos, regras, scripts e o estado da engine, nunca regras de um jogo.

```
FAIL coin collected — event "collect" {"entity":"coin1"} occurred; expected >= 1, got 0; ... (frame 150)
LIKELY scene setup (entity "coin1" never existed (...)); collectible (no "collect" event happened); collision (...)
```

- `diagnosis.failures[]`: para cada checagem que falhou, evidências do que ela cita.
  - **Entidades** (achadas em `entity('id')`/`exists`/`distance` das expressões ou em `id`/`target`/`match` das
    asserções): posição, velocidade, `grounded`, componentes, estado, escolha da IA, `nav`, `interactable`, vida e
    últimos eventos que a citam. Se não existe: `wasInStartScene`, `spawnedAt` ou `neverSeen`.
  - **Variáveis**: valor e quem escreve (regras com `setVar`/`addVar`, scripts que citam `vars.x`, `Collectible`), ou
    `"nobody"`.
  - **Eventos contados**: quantos houve e os últimos.
- `diagnosis.likelySystems[]`: `{system, score, why[]}` ordenados. Sinais, do mais forte ao mais fraco: entidade que
  nunca existiu, erro de runtime (pela origem: `script <arquivo>`, `rules`, `state machine`...), interação bloqueada
  (com o motivo), evento esperado que não aconteceu, quem escreve a variável, o tipo de checagem (posição → movimento
  e física; estado → máquina de estados e Utility AI; status → goal e regras) e os componentes das entidades citadas.
- `diagnosis.errors` (erros de runtime) e `diagnosis.timeline` (eventos relevantes dos últimos 3 s, sem
  `sound`/`tween_end`/`anim_end`/`rule`).
- `run_playbooks` mostra `likelySystems` (nomes) em cada playbook que falhou.

#### Playbooks (regressão)

Implementados na V0.3. Um playbook é um `verify_game` guardado no projeto, em `playbooks/<id>.json` (mesmos campos,
mais `tags`). O agente cria um depois de implementar uma feature e roda todos depois de mudanças, para pegar regressões.

- **Criar:** `verify_game {..., "saveAs": "limpar_sujeira"}` grava o cenário **só se ele passou**; `save_playbook`
  grava direto. Toda escrita (inclusive `write_file`) valida o arquivo pelo `PlaybookSchema`, entra no histórico e é
  desfazível.
- **Rodar:** `run_playbooks` (todos, ou `ids` / `tags`), cada um num jogo novo, sem screenshots por padrão:

```json
{ "passed": false, "summary": "3/4 playbooks passed",
  "results": [
    { "id": "bola", "scenario": "...", "passed": true, "summary": "PASS: 3/3 checks passed" },
    { "id": "encher_tigela", "passed": false, "summary": "FAIL: 2/3 checks passed",
      "failures": ["FAIL tigela cheia — vars.tigela == 3; expected == 3, got 0 (frame 15)"] } ] }
```

- **Pela CLI** (sem MCP): `npm run vibe -- call <projeto> run_playbooks {}`.
- O meu-pet tem 4 playbooks (`limpar_sujeira`, `encher_tigela`, `carinho`, `bola`); o teste de regressão do repositório
  roda todos os playbooks dele.

### Screenshots

`take_screenshot` sobe (uma vez, sob demanda) o dev server do runtime e um Chromium headless. A página abre
pausada e recebe **exatamente o projeto da run** por interceptação de requisições (assets lidos da pasta do
projeto); as `GameOp` da run são reaplicadas por `window.__vibe.apply()` — só as novas, nas fotos seguintes da
mesma run. O PNG é salvo em `.vibe/runs/<runId>/NNN-f<frame>[-debug].png`. Depois da foto, o estado do browser é
comparado com o da run headless; divergência viraria `warning` (nunca deve acontecer — testado).

O dev server sobe de preferência na porta 5173 e é compartilhado com `open_game_view`.

### Jogo no VS Code (`open_game_view`)

Devolve `{ url, server, howToOpen }`. Se já há um dev server do VibeGameEngine na porta 5173 (`npm run dev` ou a
task do VS Code), usa ele; senão sobe um dentro do servidor MCP, que vive enquanto durar a sessão do Claude Code.
O agente mostra a URL como link: com `.vscode/settings.json` (`workbench.externalUriOpeners`), o VS Code abre
links para `localhost:5173` no **Simple Browser**.

- `follow: false` (padrão): o usuário joga; a página recarrega a cada edição do projeto (hot reload).
- `follow: true` (`?live=1`): a página **segue a run do agente**. Depois de cada ação que muda a run
  (`run_game`, `perform_inputs`, `wait`...), o host grava a run em `.vibe/live.json` (projeto exato, seed, cena
  e log de `GameOp`); o dev server avisa a página, que reaplica as ops novas em tempo real. Se a página fica mais de
  3 s atrás (o agente simula mais rápido que o relógio), ela adianta o excesso. O teclado do usuário não chega ao jogo
  espelhado. `stop_game` marca a run como encerrada; um `restart_game` vira uma run nova.

### Editor: hierarquia e seleção (`get_selection`)

Implementado na V0.5. A página do jogo tem um painel **Hierarquia** (botão na barra; lembra se está aberto): as cenas
do projeto e suas entidades, ao vivo para a cena atual — entidades criadas durante o jogo aparecem em itálico com
"criada", destruídas riscadas, desativadas apagadas. Um ícone diz o que cada uma é (jogador, inimigo, coletável, zona,
sólido, visual, texto, lógica); o filtro busca por id, nome, tag, componente ou prefab.

Clicar numa entidade a **seleciona**: ela ganha um contorno ciano no jogo (tracejado se desativada) e a seleção é
gravada em `.vibe/selection.json`. Clicar de novo (ou Esc) limpa. É estado do editor: não entra no histórico nem
dispara hot reload, e sobrevive a recarregar a página.

| Tool | Entrada | O que faz |
|------|---------|-----------|
| `get_selection` | — | o que o usuário selecionou: `selection {scene, entity, selectedAt}`, os dados da entidade (`raw` + `effective`, como `get_game_object`) e, se a run do agente está nessa cena, `inYourRun` (snapshot ao vivo); `note` quando não há seleção ou ela está desatualizada |

Use quando o usuário disser "isso", "esse", "o selecionado": selecionar no painel + "deixa maior" basta.

### Editor: inspector

Implementado na V0.5. Painel **Inspector** (botão na barra), à direita: a entidade selecionada na hierarquia, com
seções *Entidade* (`name`, `tags`, `enabled`), *Transform* e uma por componente. Os campos saem do schema de cada
componente: número (com mínimo/máximo), checkbox, lista de opções (enums, como `Sprite.shape`), asset (os do projeto),
cor (seletor + texto), caixas para listas de opções (`Interactable.via`), texto separado por vírgulas para listas
(`tags`) e JSON para estruturas (`StateMachine.states`, `Animator.animations`, `Script.props`).

- **Edição segura:** cada mudança vira um `modify_game_object` feito **pelo usuário** (autor `user` no histórico, com
  motivo `Inspector: Sprite.width of coin1 = 40`). Passa pela validação do `ProjectStore`: valor inválido não grava
  nada e o painel mostra o erro. Depois o jogo recarrega (hot reload), como em qualquer edição.
- **Padrões e prefabs:** rótulo apagado = valor padrão; em itálico = vem do prefab. `↺` remove o valor do arquivo
  (volta ao padrão ou ao valor do prefab). Componentes que só o prefab tem não podem ser removidos da instância.
- **Adicionar / remover componente:** seletor no fim do painel e `✕` no título da seção.
- **Ao vivo:** se a entidade está na cena que roda, valores do jogo (`x`, `y`, `vx`, `vy`, `state`, `health`, `props`...).
  Entidades criadas durante o jogo só têm essa parte (não estão no arquivo da cena).
- Edições do agente aparecem no inspector aberto. O agente vê as do usuário em `get_history` e pode desfazê-las com
  `undo` (o histórico é compartilhado entre o servidor MCP e o dev server).

### Editor: viewport

Implementado na V0.5. Botão **Editar** na barra (só na página jogada, não em "Seguir agente" nem nas de host):

- **Modo edição:** o jogo reinicia na cena atual como está no arquivo e fica pausado. Mouse e teclado não vão para o
  jogo. O canvas mostra a cena por uma **câmera de edição** própria: a roda do mouse dá zoom no ponto do cursor
  (10%–800%), arrastar o fundo (ou com o botão do meio ou o direito) move a vista, `F` centraliza a seleção e `0`
  volta à câmera do jogo. Sair do modo edição retoma o jogo. A câmera do jogo não muda.
- **Seleção:** clicar seleciona a entidade de cima sob o cursor; é a mesma seleção da hierarquia, do inspector e de
  `get_selection`. Clicar no vazio ou `Esc` limpa a seleção. Uma entidade desativada (não desenhada) selecionada na
  hierarquia ainda pode ser agarrada pelo contorno.
- **Mover:** arrastar a entidade mostra uma prévia (sem mexer na simulação). Ao soltar, grava a nova posição como
  edição **do usuário**, um `modify_game_object` com motivo `Viewport: move coin1 by (60, -20) to (460, 370)`. É uma
  só entrada no histórico, com x e y, e pode ser desfeita. O deslocamento é em pixels inteiros, somado à posição
  guardada (ou à do prefab). As setas movem 1 px (`Shift` = 10 px) e gravam juntas quando param. Entidades criadas
  durante o jogo não estão no arquivo e não podem ser movidas.
- **Gizmos:** limites da cena (`cena <id> L×A`), o quadro da câmera do jogo, o contorno da seleção, a cruz da posição
  (`x`, `y`) com as coordenadas e, ao arrastar, o deslocamento `Δ`, e o zoom atual.

## Runtime no browser (`window.__vibe`)

Implementado na Etapa 2. É a superfície que o RuntimeHost (Etapa 4) vai usar via Playwright
(`page.evaluate`). Tudo que retorna é JSON puro (cópias; alterar o retorno não altera o jogo).
Para execuções determinísticas, abra a página com `?paused=1`.

| Método | Retorno | Observação |
|---|---|---|
| `info()` | `{project, scenes, scene, width, height, paused, debug}` | |
| `pause()` / `resume()` | — | pausa só o loop de tempo real |
| `step(frames=1)` / `advance(ms)` / `perform(steps)` / `apply(ops)` | `{frame, status, scene}` | redesenha em seguida; `apply` reaplica `GameOp`s; `perform` aceita `{type: "click", entity}` |
| `keyDown(key)` / `keyUp(key)` | — | mesmo `normalizeKey` da engine |
| `mouseMove(x, y)` / `mouseDown(btn)` / `mouseUp(btn)` | — | coordenadas do viewport |
| `getState(query?)` | `GameState` | igual a `game.getState` |
| `events(sinceFrame?, type?)` / `console(since?, level?)` | listas | |
| `restart()` / `loadScene(id)` | `{frame, status, scene}` | |
| `setDebug(on)` / `render()` | — | debug desenha colliders e ids (útil antes de screenshot) |

`window.__vibeError` (lista de mensagens) é definido quando o projeto não carrega ou uma edição o deixa inválido.
`take_screenshot` = `apply(ops novas)` + `setDebug(annotate)` + `render()` + screenshot do elemento `canvas`.

## Memória do projeto

Implementado na Etapa 8 (`tools/memory-tools.ts`, schema em `shared/src/memory.ts`). Guarda o que o agente sabe do
projeto além dos arquivos de dados, para uma conversa nova continuar de onde a anterior parou. Fica em
`.vibe/memory.json` (versionado no git; fora do histórico de undo).

| Tool | Parâmetros | Retorno |
|---|---|---|
| `read_memory` | — | `summary`, `features`, `todos`, `issues`, `notes` + cenas (nº de entidades), assets e as 5 últimas mudanças |
| `update_memory` | `summary?, upsert?, remove?` | ids criados e contagem `open/done/verified` |

Itens: `{ id, kind: feature|todo|issue|note, text, status: open|done|verified, evidence? }`. Sem `id`, o `upsert`
cria o item (ids `f1`, `t1`, `i1`, `n1`...); com `id`, altera só os campos passados. `verified` = feito e checado
por teste ou jogando; `evidence` diz como. `get_project_summary` traz os itens em aberto (`memory`).

## Nomes de teclas

Normalizados por `normalizeKey`: `"d"`, `"D"`, `"KeyD"` → `D`; `"SPACE"`, `" "` → `Space`;
`"left"` → `ArrowLeft`; `"esc"` → `Escape`; `"Digit1"` → `1`.
Controllers usam **actions** (`left`, `right`, `jump`, …) mapeadas em `config.actions`.
