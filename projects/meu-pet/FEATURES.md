# Meu Pet — features e regras do jogo

Documento de referência do jogo **Meu Pet** (pasta `projects/meu-pet/` do repositório VibeGameEngine). Descreve tudo o
que existe hoje, com os números reais do código, para quem for analisar o design sem rodar o jogo. Estado em
2026-10-01 (commit `9562b4a` + ajustes posteriores).

## 1. Conceito

Pet virtual "observacional" (estilo tamagotchi). O jogador **observa e cuida** de um ser vivo virtual:

- O pet **nunca fala**. Nada de balões de diálogo nem frases em primeira pessoa ("Estou com fome").
- O estado do pet aparece principalmente pelo **comportamento** (andar até a tigela, bocejar, procurar a cama, empurrar a
  bola, vir até o jogador) e por **notificações observacionais** com o nome dele ("Mimi parece estar com fome.").
- As **necessidades** e a **personalidade** são escondidas: não há barras de status na tela. O jogador infere.
- O pet **não morre**. Abandono deixa ele doente e apático e leva a uma forma adulta "menos cuidada".
- O tempo é **real** (horas de verdade, com save e progresso enquanto o jogo está fechado), com um controle de
  **velocidade** (1×, 60×, 600×) para testar ou jogar rápido.

Arte: só os 12 sprites da autora (1024×1024, 1 ou 2 quadros parados por forma). Cenário, objetos e efeitos são formas
geométricas e texto. Sons: efeitos retrô gerados.

## 2. Como o jogo é feito (para ler o código)

Motor próprio (VibeGameEngine, TypeScript): o projeto é **dados + scripts**.

| Arquivo | O que é |
|---|---|
| `project.json` | config: 960×540, sem gravidade, cena inicial `inicio`, assets (sprites e sons) |
| `scenes/inicio.json` | tela de nomear o pet |
| `scenes/quarto.json` | o quarto (jogo principal) |
| `scenes/colecao.json` | coleção ("pokédex") |
| `scripts/pet.js` | **cérebro do pet** (~790 linhas): necessidades, personalidade, comportamento, observações, evolução, save |
| `scripts/aviso.js` | mostra as observações no topo, uma de cada vez |
| `scripts/botao.js` | botões (petisco, remédio, diário, coleção, velocidade, novo pet, voltar) |
| `scripts/tigela.js`, `bola.js`, `lampada.js`, `sujeira.js` | objetos clicáveis: componente `Interactable` (via clique) + hook `onInteract`; o pet também (carinho) |
| `scripts/ceu.js` | céu da janela pela hora, escuridão da noite, relógio |
| `scripts/diario.js` | painel do diário |
| `scripts/inicio.js`, `comecar.js` | digitação do nome |
| `scripts/colecao.js` | monta a tela da coleção |
| `scripts/emote.js` | efeitos flutuantes (z, ♥, ♪, ?, ~) |
| `prefabs/*.json` | modelos: `emote`, `sujeira`, `botao`, `carta`, `figura`, `rotulo` |
| `.vibe/memory.json` | memória do projeto (features verificadas, notas, pendências) |
| `.vibe/save.json` | save do jogo jogado (não versionado) |

Scripts recebem `self` (a entidade) e `game` (relógio do calendário `game.clock`, dados salvos `game.storage`,
aleatório com seed, eventos). Cada frame é 1/60 s; as necessidades usam o **relógio do calendário**, não os frames.

## 3. Telas

- **Início** (`inicio`): "Um novo pet vai chegar. Como ele vai se chamar?" — digita o nome (até 14 caracteres) e
  Enter ou "Começar". Se já existe um pet salvo, pula direto para o quarto. Botão "Coleção".
- **Quarto** (`quarto`): parede, chão, janela (céu e sol/lua pela hora), planta, lâmpada pendurada, cama, tigela com
  ração, bola, sujeira quando houver. Faixa no topo com as observações. Barra inferior: dicas, relógio
  (hh:mm e velocidade), botões **Petisco, Remédio, Diário, Coleção, Velocidade**.
- **Diário** (painel sobre o quarto): "Diário de {nome} · {Bebê|Jovem|Adulto}", idade (dias e horas),
  personalidade percebida ("Parece ser: brincalhão, curioso" ou "ainda observando..."), as 6 últimas observações,
  aviso de save automático. Na fase adulta: botão "Começar com um novo pet".
- **Coleção** (`colecao`): grade com as 9 formas — descobertas mostram o desenho e o nome do pet que a revelou; não
  descobertas mostram "?" — contador "N de 9 formas descobertas", e a lista "Pets anteriores" (nome, forma final,
  dias de vida, traços percebidos).

## 4. Necessidades (escondidas, 0–100)

Valores iniciais de um pet novo: fome 70, energia 80, diversão 70, higiene 90, saúde 100, afeto 60.
"Fome" alta = satisfeito (100 = cheio).

Variação **por hora de jogo**:

| Necessidade | Acordado | Dormindo | Modificadores |
|---|---|---|---|
| fome | −8 | −4 | |
| energia | −6 | +22 (escuro ou de dia) / +12 (noite com luz acesa) | preguiçoso ×1,4; doente ×1,5 (acordado) |
| diversão | −7 | −1 | brincalhão ×1,5; curioso ×1,2 (acordado) |
| afeto | −5 | −1 | carinhoso ×1,5 (acordado) |
| higiene | −3 | −3 | |
| saúde | −4 se doente; −3 se fome, higiene ou energia < 15; +2 se todas as outras > 40 | | |

- **Doença:** se higiene < 25, fome < 10 ou saúde < 30, chance de adoecer de 15% por hora. Doente: anda na metade da
  velocidade, treme, perde saúde e energia mais rápido. Remédio cura (+25 saúde).
- **Bem-estar:** média móvel das 6 necessidades com meia-vida de 6 h; decide a forma adulta.
- **Sujeira:** aparece conforme a higiene cai — 1 mancha abaixo de 70, 2 abaixo de 45, 3 abaixo de 25. Só some quando
  o jogador limpa. Cada limpeza dá +18 de higiene (e no mínimo o nível que corresponde às manchas restantes).

## 5. Personalidade (escondida)

Ao nascer o pet sorteia 1 traço e, com 60% de chance, um segundo: **brincalhão, preguiçoso, carinhoso, curioso,
irritável**.

| Traço | Efeitos |
|---|---|
| brincalhão | diversão cai 1,5× mais rápido; anda 25% mais rápido e saltitando mais; procura a bola com mais frequência; aceita brincar mesmo satisfeito |
| preguiçoso | energia cai 1,4× mais rápido; anda 30% mais devagar; fica parado mais tempo e com mais frequência |
| carinhoso | afeto cai 1,5× mais rápido; vem até o jogador com frequência; carinho dá +22 de afeto (normal +15) e a mensagem "parece adorar o carinho" |
| curioso | diversão cai 1,2× mais rápido; investiga janela, lâmpada, planta e cama com frequência; às vezes "parece estar procurando alguma coisa" |
| irritável | fica emburrado quando entediado; rejeita carinho com energia < 40 ou carinho repetido em < 6 s (afeto −3, "não parece gostar disso agora"); se acordado com carinho, acorda incomodado |

**Revelação:** cada comportamento típico de um traço que o pet tem conta 1 "sinal". Com 3 sinais o diário passa a
dizer "Parece ser: …". O jogador nunca vê a lista sorteada.

## 6. Comportamento autônomo

O pet escolhe a próxima atividade quando termina a atual. A atividade do momento é também o estado da
`StateMachine` da entidade `pet` (idle, walk, yawn, sleep, eat, lookBowl, play, chase, toy, investigate, greet, sulk,
happy, evolve): dá para ver `state`/`stateMs` no estado do jogo e os eventos `state_change`.

Ordem da escolha:

1. **Sono** se `energia < 25` ou (noite 22h–7h e `energia < 85`): boceja (estica), anda até a cama e dorme.
   À noite só acorda de manhã: depois das 7h, com energia ≥ 95, ou antes das 9h com energia ≥ 60. De dia acorda com
   energia ≥ 95.
2. **Comida** se `fome < 45`: vai até a tigela; com ração, come (3 s, +35 de fome por porção); sem ração, fica
   olhando a tigela vazia ("?"). Para não ficar preso, só volta a olhar a tigela vazia depois de 20 s; no intervalo,
   metade das vezes vem até o jogador.
3. Caso contrário, sorteio ponderado — feito pela `UtilityAI` da entidade `pet` (`select: weighted`; os pesos são
   expressões sobre as necessidades e os traços que o `pet.js` coloca em `self.props`; as notas de cada opção aparecem
   no estado do jogo em `ai.scores`):

| Atividade | Peso |
|---|---|
| passear (anda até um ponto aleatório) | 3 |
| ficar parado (2–5 s; preguiçoso até 8 s) | 2 (preguiçoso 4; doente +6) |
| investigar janela/lâmpada/planta/cama | 0,7 (curioso 3) |
| vir até o jogador (centro do quarto) | 0,8 (carinhoso 2,5) +2 se afeto < 40 |
| ir até a bola e empurrar | 1 (brincalhão 2,5) +1,5 se diversão < 40; só com energia > 30 |
| ficar emburrado | 1,2 se irritável e diversão < 50 |

Velocidade base 90 px/s (brincalhão ×1,25, preguiçoso ×0,7, doente ×0,5, energia < 25 ×0,7).

**Animações** (os sprites só têm a pose parada): a alternância dos 2 quadros de idle é um clipe do `Animator` (quadros
da forma atual, mais lento doente ou dormindo); o resto é procedural: respiração (escala),
pulinhos ao andar, achatar ao dormir, balançar ao comer, pular de alegria, bocejo (estica e encolhe), inclinar a cabeça
ao investigar, postura caída emburrado, tremor doente, pulsar ao evoluir. Vira para o lado em que anda.

**Emotes** (efeitos, não falas; sobem, balançam e somem com tweens da engine): `z` dormindo, `♥` carinho e petisco, `♪` brincadeira e felicidade, `?` tigela vazia,
`~` doente.

## 7. Interações do jogador (mouse)

| Ação | Como | Efeito e reação |
|---|---|---|
| Carinho | clicar no pet | afeto +15 (carinhoso +22), diversão +3, pulinho e ♥; repetido em < 6 s: "não parece muito interessado"; dormindo: "se mexeu um pouco" (irritável acorda incomodado) |
| Encher a tigela | clicar na tigela | 3 porções (som); se o pet está acordado e com fome < 70, vai comer |
| Petisco | botão | fome +10, afeto +8, diversão +5; mais de 4 por dia ou fome > 95: saúde −2 e "não parece muito interessado" |
| Jogar a bola | clicar na bola | a bola voa e rola; o pet corre atrás se tiver energia > 20, não estiver doente e diversão < 85 (brincalhão sempre); brinca 4 s: diversão +30, energia −8, afeto +5, "ficou animado!" |
| Limpar | clicar na sujeira | uma nuvem de poeira (partículas); higiene +18; sem sujeira: "parece mais à vontade com o quarto limpo" |
| Remédio | botão | doente: cura, saúde +25; saudável: "não parece muito interessado" |
| Luz | clicar na lâmpada | acende/apaga; dormir no escuro recupera energia mais rápido; dormindo com luz à noite: "parece incomodado com a luz" |

Os objetos clicáveis ficam numa camada acima do pet, então dá para clicar na tigela mesmo com o pet na frente.

## 8. Sistema de observação

Fluxo: **estado → evento → notificação**. Cada notificação tem um tipo (`kind`) com **cooldown**: o mesmo tipo só
volta depois de N minutos de jogo **e** de pelo menos 25 s reais (para não virar spam em 600×). Entre duas
notificações automáticas há no mínimo 4 s reais. A faixa no topo mostra uma por vez por 5 s (fila de no máximo 3).

Checagem automática a cada segundo (em ordem de prioridade):

| Condição | Mensagem | Cooldown (min de jogo) | Comportamento junto |
|---|---|---|---|
| doente | "{n} não parece estar se sentindo bem." | 90 | emote ~, treme, anda devagar |
| acordado e fome < 30 | "{n} parece estar com fome." | 90 | vai até a tigela |
| acordado e energia < 20 | "{n} está ficando cansado." / < 10: "parece estar muito cansado." | 90 | boceja e vai para a cama |
| acordado e diversão < 30 | "{n} parece entediado." | 120 | |
| acordado e afeto < 30 | "{n} parece estar com saudade de você." | 120 | vem até o jogador |
| higiene < 30 | "{n} parece incomodado com a sujeira." | 120 | |
| dormindo, noite, luz acesa | "{n} parece incomodado com a luz." | 60 | |
| acordado e tudo > 80 | "{n} parece muito feliz!" | 180 | ♪ e pulinhos |

Mensagens de eventos: "{n} chegou! Observe com atenção." · "{n} adormeceu." · "{n} acordou." · "{n} comeu da
tigela." · "{n} está olhando para a tigela vazia." · "{n} está olhando para o brinquedo." · "{n} parece estar
procurando alguma coisa." · "{n} ficou animado!" · "{n} parece gostar do carinho." / "parece adorar o carinho." ·
"{n} não parece gostar disso agora." · "{n} não parece muito interessado." · "{n} parece ter gostado do petisco." ·
"{n} parece estar se sentindo melhor." · "{n} parece mais à vontade com o quarto limpo." · "{n} cresceu!" ·
"{n} chegou à fase adulta! No Diário você pode começar com um novo pet." · "A tigela já está cheia."

## 9. Tempo, save e tempo fora

- **Relógio:** data e hora reais do computador. A janela mostra o céu (dia 7h–18h, entardecer 18h–20h, noite,
  amanhecer 5h–7h) e o quarto escurece à noite (pouco com a luz acesa, bastante apagada).
- **Velocidade:** botão alterna 1× → 60× (1 minuto de jogo por segundo) → 600× (10 minutos por segundo). Fica salva.
- **Save automático:** a cada 3 s (timer `salvar` da engine; as observações usam o timer `observar`, a cada 1 s) e a
  cada ação importante, no arquivo `.vibe/save.json` do projeto (sobrevive a fechar
  o VS Code). Botão "Apagar save" na barra da página recomeça do zero.
- **Tempo fora:** ao reabrir (ou quando o relógio pula mais de 5 min, como uma aba em segundo plano), o jogo simula o
  intervalo em passos de 15 min (até 7 dias): o pet dorme quando precisa, acorda, come da tigela se houver ração, as
  necessidades caem. Depois mostra um resumo: "Você ficou fora por 1 dia e 16 h. Mimi dormiu, comeu da tigela e parece
  ter sentido sua falta."

## 10. Ciclo de vida e evolução

- **Bebê** (0–12 h de vida) → **Jovem** (12–36 h) → **Adulto** (36 h em diante, para sempre).
- **Jovem 1 ou 2** (estilo de cuidado): Jovem 1 se `brincadeiras + petiscos×0,5 ≥ carinhos + sonecas×0,5`; senão Jovem 2.
- **Adulto** (qualidade do cuidado, pelo bem-estar médio): ≥ 70 → **1**, ≥ 45 → **2**, abaixo → **3**. A letra vem da
  linha do jovem: Jovem 1 → **a**, Jovem 2 → **b**. São 6 adultos diferentes (1a, 2a, 3a, 1b, 2b, 3b).
- Ao evoluir: pulsa, som, "{n} cresceu!", a forma entra na coleção.

## 11. Coleção ("pokédex") e novo pet

- Toda forma alcançada fica registrada (com o nome do pet que a revelou), mesmo depois de trocar de pet.
- Na fase adulta, o Diário oferece **"Começar com um novo pet"** (pede um segundo clique para confirmar). O adulto vai
  para "Pets anteriores" (nome, forma final, dias de vida, traços percebidos) e o jogo volta à tela de nomear.
- O objetivo de longo prazo implícito é descobrir as 9 formas.

## 12. O que foi verificado (testes jogando)

Testado em execuções automatizadas do próprio motor (determinísticas, com relógio controlado) e em screenshots:
nomear e começar; pular direto para o quarto com save; céu e escuridão por hora; comportamento autônomo; comer,
dormir e acordar; carinho, tigela, bola, petisco, remédio, limpeza, luz; observações sem spam a 600×; evolução para
Jovem 1 e Jovem 2 conforme o cuidado e para Adulto 3a com abandono; resumo de tempo fora; novo pet na fase adulta e
coleção. A plataforma tem testes que confirmam que o save no disco sobrevive a um navegador novo.

## 13. Limitações e pontos em aberto

- Só existem quadros parados: dormir, comer e brincar são animações improvisadas (o pet dorme de olhos abertos).
- Cenário e objetos são formas simples; não há trilha sonora; os sons são efeitos sintetizados.
- Balanceamento é um primeiro chute: ritmos das necessidades, 12 h / 36 h para evoluir, limites de doença.
- O pet adulto não envelhece nem muda depois de adulto; não há morte (decisão de design).
- Um único quarto; sem objetos novos para desbloquear, sem itens de loja, sem mini-jogos.
- A personalidade só aparece no diário depois de 3 sinais; não há outra pista explícita.
- Sem acessibilidade de teclado para as ações (só mouse, exceto digitar o nome).
