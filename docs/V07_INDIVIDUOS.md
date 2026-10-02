# V0.7 — Indivíduos (análise e arquitetura)

Objetivo: o jogador deixa de "encher barras" e passa a **conhecer um indivíduo**. O ciclo é: o pet age → o jogador
observa → formula uma hipótese → experimenta → o pet reage → o sistema registra evidência → o jogador aprende → o
comportamento futuro muda.

Este documento é a Fase 1 (análise). Ele diz o que existe, o que é reaproveitado, o que entra na engine, o que fica
no jogo e em que ordem.

## 1. O que existe hoje

### Engine (genérico, testado: 406 testes unitários + 26 e2e)

| Sistema | Onde | Serve para a V0.7? |
|---|---|---|
| Entidades + componentes com schema zod | `shared/components.ts`, `engine/entity.ts` | sim: os sistemas novos são componentes |
| `Script` (onStart/onUpdate/onClick/onEvent/onInteract, `self.props`, `self.state`) | `engine/scripts.ts` | sim, mas **scripts não importam outros scripts**: lógica reutilizável precisa estar na engine |
| `UtilityAI` (opções com nota por expressão, `best`/`weighted`, cooldown, inércia, ruído) | `engine/utility.ts` | sim; falta escolher **alvos** (qual brinquedo, qual cama) |
| `StateMachine`, `Animator`, timers, tweens, partículas | `engine/fsm.ts`... | sim, sem mudanças (reação visual) |
| `Interactable` (clique/tecla/entrada, condição, cooldown) | `engine/interact.ts` | sim: objetos do quarto; falta "usar um item em alguém" |
| Expressões seguras (`self`, `vars`, `clock`, funções) | `engine/expr.ts` | sim; ganham funções novas (`trait`, `likes`, `env`...) |
| Relógio do calendário + velocidade | `engine/clock.ts` | sim: memória, rotina e sono contam tempo de calendário |
| `game.storage` (JSON, 512 KB, disco em `.vibe/save.json`) | `engine/storage.ts` | sim: toda persistência nova passa por ele |
| Save slots / hot state | `engine/saves.ts`, `hot-state.ts` | sim: o que for estado de entidade precisa ser capturável |
| Eventos (`game.emit`, `onEvent`, regras, asserções, `verify_game`, playbooks) | vários | sim: reações e descobertas viram eventos verificáveis |

**Não existe:** itens/tags, inventário, moeda, loja, personalidade numérica, preferências, memória, conhecimento do
jogador, diário estruturado, ambiente, rotina, minigames, quebra de linha no `Text`.

### Jogo `meu-pet` (dados + scripts)

Toda a vida do pet está em **um script de 778 linhas** (`scripts/pet.js`) que guarda o pet inteiro em
`storage.pet` (`version: 1`):

- **Necessidades** (fome, energia, diversão, higiene, saúde, afeto), decaimento por hora do relógio, simulação do
  tempo fora em passos de 15 min. Funciona bem — **fica no jogo e não é reescrito**.
- **Personalidade**: 1–2 traços booleanos de 5 (`brincalhao`, `preguicoso`, `carinhoso`, `curioso`, `irritavel`),
  com multiplicadores espalhados em `if (has(...))`. Revelação: 3 "sinais" → o diário diz "Parece ser: …".
- **Decisão**: prioridades fixas no script (sono → fome) e depois a `UtilityAI` `weighted` com 6 opções fixas.
- **Interações**: tigela (porções), petisco (botão), bola, carinho, limpar, remédio, luz. Itens são implícitos (não
  há "maçã"; o petisco é um só).
- **Observações**: `observe(kind, texto, cooldown)` com cooldown em minutos de jogo + 25 s reais; faixa no topo.
- **Diário**: um `Text` com idade, traços revelados e as 6 últimas observações.
- **Evolução**: idade (12 h / 36 h) + estilo de cuidado (contadores) + bem-estar médio → 9 formas; coleção.

## 2. Diagnóstico

- O comportamento já é observacional e sem falas: **o tom está certo, falta profundidade**. Dois pets com o mesmo
  traço são idênticos; o mundo não tem objetos diferentes para reagir; nada do que acontece é lembrado (só 30 notas
  de texto); o diário não organiza descobertas.
- A personalidade é **booleana e espalhada** (multiplicadores em 8 lugares). Para ter efeito real e combinatório ela
  precisa ser **contínua** (eixos 0..1) e lida pelos sistemas, não por `if`s.
- `pet.js` não pode crescer mais: itens, memória, diário e loja no mesmo arquivo virariam um monólito impossível de
  testar. Como scripts não compartilham código, **o que é genérico vai para a engine**, com API para scripts,
  expressões, estado observável (`inspect_game_state`) e eventos (asserções/playbooks).

## 3. Divisão engine × jogo

Regra: se um RPG, um sim ou um jogo de fazenda também usaria, é engine. Nada da engine sabe o que é "pet", "fome" ou
"maçã".

| Engine (genérico) | Jogo `meu-pet` (dados + scripts) |
|---|---|
| **Itens**: catálogo `items/<id>.json` (nome, categoria, tags, propriedades numéricas, preço, ícone, consumível) | as comidas, brinquedos, camas, lâmpadas, decorações e suas tags |
| **Inventário + moeda**: contas persistentes em storage, eventos `item_added/removed`, `currency_changed`; ações de regra e funções de expressão | quanto custa, quanto se ganha e por quê |
| **Loja**: `buy(item)` valida preço/moeda, debita, entrega, evento `purchase` | a tela da loja (prefabs + script) |
| **Uso de item em entidade**: `game.useItem(item, alvo)` → hook `onItem(self, item, by)` e evento `item_used` | o que o pet faz ao receber cada coisa |
| **Traits** (personalidade): eixos contínuos 0..1 gerados pela seed dentro de faixas; estáveis | os eixos do pet (atividade, sociabilidade...) e seus efeitos nas necessidades |
| **Preferences** (afinidades): por assunto (id de item, tag, contexto) = inato + aprendido; inato pode depender dos traits; avaliação de um item pela combinação id + tags; aprendizado lento e limitado; níveis (ama…odeia) | as tags que importam e quanto pesam na reação |
| **Memory** (episódica): registros {tipo, assunto, tags, valência, importância}, força = importância × decaimento pela idade no relógio, fusão de repetidos, capacidade fixa, consulta e "sentimento" sobre um assunto | o que vale lembrar |
| **Knowledge** (o que o *jogador* sabe da entidade): evidências por chave → confiança (possível / observada / confirmada), evento `discovery` | quais chaves existem e como cada uma vira frase |
| **Journal** (crônica por entidade): entradas com categoria, importância, chave de deduplicação ("primeira vez que…"), limite com descarte das menos importantes | as seções do diário e os textos |
| **Routine** (hábitos): histograma de atividades por faixa do dia com decaimento; viés para a decisão e detecção de padrões estáveis | quais atividades contam |
| **Ambient** (ambiente): entidades emitem propriedades (luz, ruído, conforto, estímulo) com alcance; `env(x, y)` soma/limita; expressão `env.noise` | o que cada objeto emite e como o pet sente |
| **UtilityAI com alvos** ("smart objects"): uma opção pode avaliar cada candidato de uma tag (`target` na expressão) e entregar o vencedor | as opções do pet e suas notas |
| **Persistência de entidade**: componente `Persist {key}` carrega os componentes acima do storage antes do `onStart` e grava quando mudam | a chave do pet atual |
| **Notifier** (observações): `game.notify(tipo, texto, {cooldown})` com cooldown de relógio + tempo real, prioridade, evento `notification` | as frases ("{n} parece…") |
| **Minigame**: cena chamada com parâmetros e retorno de resultado (`startMinigame` / `endMinigame`), evento `minigame_end` | os minigames, os prêmios e as pequenas vantagens por personalidade |
| `Text.maxWidth` (quebra de linha) | layout do diário, da loja, do inventário |

Tudo isso aparece no snapshot da entidade, então o agente vê e testa com `inspect_game_state`, `verify_game` e
playbooks, sem acessar o storage na mão.

### Modelo numérico (interno; o jogador nunca vê)

- Traço: `0..1` (0,5 = médio). Gerado como `faixa + seed`, nunca muda sozinho.
- Afinidade: `-1..1` = `inato + aprendido`; `aprendido` anda no máximo `rate × resultado` por experiência
  (ex.: 0,05) e é limitado (ex.: ±0,5) — uma experiência não muda o pet, dez mudam um pouco.
- Item × pet: `score = afinidade(id) × 0,6 + média(afinidade(tags)) × 0,4` (pesos configuráveis), com o ruído do
  humor do momento somado pelo jogo.
- Níveis para texto: `≥ 0,6` ama · `≥ 0,2` gosta · `> -0,2` neutro · `> -0,6` não gosta · resto odeia.
- Confiança do conhecimento: evidência acumulada com peso pela intensidade da reação; limiares
  possível (1) / observada (3) / confirmada (6) — ajustáveis por chave.
- Memória: meia-vida em horas de calendário por tipo; capacidade ~40; abaixo de uma força mínima é esquecida;
  memórias marcantes (importância alta) viram entrada no Journal antes de sumir.

## 4. Riscos

- **Acoplamento**: a engine não pode conhecer necessidades do pet. Mitigação: a engine só fornece afinidade, memória,
  confiança, histogramas e ambiente; quem converte em "fome +10" é o script. Testes da engine usam fixtures neutras
  (um NPC, um baú), nunca o meu-pet.
- **Monólito `pet.js`**: a cada fase, lógica sai do script para componentes/dados. Meta: o script fica com
  necessidades, tempo fora, animação procedural e as frases.
- **Expressões ficando ilegíveis**: notas com 6 fatores numa linha são difíceis de ler. Mitigação: `trait()`,
  `likes()`, `env()`, `memory()` nas expressões e notas compostas por fatores nomeados no componente.
- **Determinismo**: geração de traços/preferências e ruído usam a RNG da seed; memória e rotina usam o relógio do
  jogo. Replays e screenshots continuam exatos.
- **Spam de notificações** com mais sistemas falando: tudo passa pelo `Notifier` com prioridade e cooldown global.
- **Gamificação**: nenhum número chega à tela; o diário traduz em frases e níveis de confiança.

## 5. Desempenho

Cenas pequenas (≈ 40 entidades). Custos novos: avaliação de alvos só quando a IA decide (opções × candidatos, dezenas);
`env()` O(emissores) sob demanda; memória e conhecimento com tamanho fixo (decaimento calculado na consulta, não por
frame); persistência gravada quando algo muda (marcação de sujo), não a cada frame. Orçamento do save: pet + memória +
diário + inventário < 60 KB (limite do storage: 512 KB).

## 6. Saves existentes

O save atual é `storage.pet` com `version: 1` e o `pet.js` **descarta** saves de outra versão (cria um pet novo).
Por isso a Fase 2 inclui uma **migração v1 → v2** no jogo, testada com um save v1 real:

- traços antigos viram eixos (ex.: `brincalhao` → brincadeira e atividade altas; `preguicoso` → atividade baixa;
  os eixos não citados são sorteados perto do meio);
- preferências inatas são geradas na migração (o jogador ainda não descobriu nada, então nada se perde);
- necessidades, idade, forma, coleção, notas e velocidade continuam iguais;
- as notas antigas viram as primeiras entradas do diário.

A coleção (`storage.colecao`) não muda. Componentes novos são opcionais: jogos sem eles não mudam.

## 7. Fases

Cada fase: componentes/APIs da engine com testes unitários → uso no meu-pet → regressão (`meu-pet.test.ts` +
playbooks) → **playtest pelas tools** (`run_game`, `click_mouse`, `observe`, `advance_clock`, screenshots, salvar e
reabrir) → docs (ARCHITECTURE, AGENT_TOOLS, FEATURES do jogo) → TODO → commit depois da sua verificação.

| Fase | Engine | meu-pet |
|---|---|---|
| 1 ✅ | análise e arquitetura (este documento) | — |
| 2 ✅ | `Traits`, `Preferences` (inato, avaliação, níveis), `Persist`, funções `trait()`/`likes()` | 8 eixos de personalidade; migração do save v1; os multiplicadores viram leitura dos eixos |
| 3 ✅ | catálogo de itens, `useItem` + `onItem` + `item_used` | comidas e brinquedos com tags; reação por preferência (aproximar/afastar, emote, animação); fim do petisco único |
| 4 ✅ | inventário, moeda, loja (`buy`), ações/expressões | tela de inventário e loja; renda pequena (cuidado diário) |
| 5 ✅ | `UtilityAI` com alvos, `Routine` | decisão sem prioridades fixas; conflito de necessidades decidido pela personalidade; rotina individual |
| 6 | `Memory`, `Notifier` | lembra experiências boas/ruins e procura de novo; observações migram para o Notifier |
| 7 | `Knowledge`, `Journal`, `Text.maxWidth` | diário em seções (básico, personalidade descoberta, gostos, memórias, descobertas, hábitos, evolução) |
| 8 | `Ambient`, `env()` | luz, música, silêncio, conforto; qualidade do sono pela cama/luz/ruído/preferências |
| 9 | aprendizado de afinidade ligado à memória | preferências que mudam devagar; hábitos no diário |
| 10 | — | evolução por histórico (rotina, relação, alimentação, exploração), registrada no diário |
| 11 | `startMinigame`/`endMinigame` | 1–2 minigames (moeda, vínculo, memória, revelar preferência; vantagem pequena por traço) |
| 12 | — | balanceamento; avaliação das 10 perguntas de qualidade com dois pets de personalidades opostas |

## 8. Decisões de design propostas

- **Eixos de personalidade (8)**: atividade, sociabilidade, curiosidade, independência, sensibilidade, apetite,
  paciência, brincadeira. "Rotina" e "afetividade" ficam de fora como eixos: rotina emerge do sistema `Routine`, e
  afetividade se sobrepõe a sociabilidade (menos eixos = diferenças mais legíveis).
- **Preferências por tag e por item**: um pet pode "gostar de frutas" (tag) e "não gostar de maçã" (item) — a
  combinação cria surpresas que valem ser descobertas.
- **Nada é revelado de graça**: o diário só mostra uma preferência quando houve evidência; personalidade aparece como
  frases ("Parece ser bastante ativo."), nunca como número.
- **Sem punição severa por item odiado**: reação negativa (afasta, emburra, perde interesse), sem dano.
- **Moeda modesta**: cuidado diário + minigames; preços pensados para comprar algo novo a cada 1–2 dias de jogo.
