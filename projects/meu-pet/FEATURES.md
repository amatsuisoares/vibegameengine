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
  (hh:mm e velocidade), botões **Comida, Remédio, Diário, Coleção, Velocidade**.
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

## 5. Quem o pet é: personalidade e gostos (escondidos)

Desde a V0.7 cada pet é um **indivíduo**: componentes `Traits`, `Preferences` e `Persist` da engine na entidade `pet`
(`scenes/quarto.json`). Os valores ficam em `storage.petIndividuo` e voltam em toda sessão; um pet novo é sorteado de novo.
O jogador nunca vê números: só comportamento, reações e observações.

**Personalidade** — 8 eixos de 0 a 1, sorteados ao nascer (entre 0,05 e 0,95) e estáveis:

| Eixo | Efeito no jogo |
|---|---|
| atividade | energia cai mais rápido acordado (×0,8–1,3) mas recupera mais rápido dormindo (dorme menos); anda mais rápido (×0,7–1,3) e saltita mais; passeia mais e fica parado menos (e por menos tempo) |
| sociabilidade | afeto cai mais rápido sozinho (×0,4–1,6); vem até você com mais frequência (e quando tem fome e a tigela está vazia); brincar com você rende mais afeto |
| curiosidade | investiga janela/lâmpada/planta/cama com mais frequência e por mais tempo; "parece estar procurando alguma coisa" |
| independência | afeto cai mais devagar (×1,25–0,65); brincar sozinho com a bola diverte mais; pesa contra gostar de carinho |
| sensibilidade | mais propenso a gostar de escuro; muito sensível se incomoda com a luz acesa ao dormir |
| apetite | fome cai mais rápido (×0,75–1,3); vai comer mais cedo; mais propenso a gostar de doce |
| paciência | baixa (< 0,35): emburra quando entediado, rejeita carinho cansado ou repetido, acorda irritado com carinho |
| brincadeira | diversão cai mais rápido; procura a bola; aceita brincar mesmo satisfeito (> 0,65) |

**Gostos** (afinidade −1..1 → adora / gosta / neutro / não gosta / odeia), inatos e puxados pelos traços:
carinho (sociabilidade +, independência −), bola e `ativo` (brincadeira, atividade), petisco e `doce` (apetite), ração e
`crocante`, escuro (sensibilidade). Calibrados para ~60–70% dos pets gostarem de carinho, petisco e bola e ~10% não
gostarem (a surpresa a descobrir); a ração é quase sempre neutra.

| Interação | Adora / gosta | Neutro | Não gosta / odeia |
|---|---|---|---|
| carinho | ♥, pulinho, afeto +22/+15, "parece adorar/gostar do carinho" | afeto +8, "aceitou o carinho, sem muita empolgação" | se afasta, afeto +2, "se afastou um pouco. Parece preferir o próprio espaço." |
| petisco | ♥, afeto +12/+8, "parece ter adorado/gostado" | "comeu o petisco sem muito entusiasmo" | "não parece ter gostado muito" (emburra); odeia: cheira, recusa e se afasta (não conta no limite diário) |
| ração | come mais rápido, ♥ se adora, "comeu a ração com muita vontade" | "comeu da tigela" | come devagar e só com mais fome, "comeu a ração, mas sem muita vontade" |
| bola jogada | corre atrás; brincar rende diversão ×1,5 ("ficou animado!") | corre e "brincou um pouco com a bola" | afinidade ≤ −0,3: só olha a bola passar, "não parece muito interessado nela" |
| luz à noite | quem gosta de escuro dorme pior com a luz acesa e melhor no escuro ("parece incomodado com a luz") | | quem não gosta de escuro dorme pior no escuro e não se incomoda com a luz |

**Revelação:** cada comportamento típico de um traço **forte** (> 0,65 ou < 0,35) conta um sinal ("atividade:alto",
"paciencia:baixo"...). Com 3 sinais o diário diz "Parece ser: bastante ativo, impaciente…" (16 descrições possíveis).

**Save antigo (v1):** traços sim/não viram eixos (brincalhão → brincadeira 0,85 e atividade 0,7; preguiçoso → atividade
0,15; carinhoso → sociabilidade 0,85 e independência 0,2; curioso → curiosidade 0,85; irritável → paciência 0,15 e
sensibilidade 0,7); o resto é sorteado e os gostos seguem esses eixos. Sinais já vistos, necessidades, idade e notas são
mantidos.

## 6. Comportamento autônomo (V0.7: Utility AI com alvos + rotina)

O pet escolhe a próxima atividade quando termina a atual. **Todas** as opções concorrem na `UtilityAI` da entidade
`pet` (`select: weighted`, `sharpness: 2`): a chance de cada uma é proporcional à nota², e cada nota é
**necessidade × personalidade × gosto + hábito**. Não há prioridade fixa — com fome, cansado e entediado ao mesmo tempo,
quem decide é o jeito do pet. A atividade do momento é também o estado da `StateMachine` (idle, walk, yawn, sleep, eat,
lookBowl, play, chase, toy, investigate, greet, sulk, happy, evolve).

| Opção | O que faz | Nota (resumo) |
|---|---|---|
| dormir | boceja, vai para a cama, dorme | cansaço × (1,6 − 1,2·atividade); à noite, abaixo do limite de sono do pet (92 calmo → 68 ativo) |
| comer | vai à tigela (vazia: olha para ela) | fome além do limite próprio × (0,4 + 1,2·apetite) |
| brincar | **alvo:** um brinquedo do quarto (bola, pelúcia, chocalho) | (0,3 + 2·brincadeira) × tédio × peso do brinquedo (favorito 2,4 · gosta 1,3 · neutro 0,5 · não gosta 0); só com energia suficiente (brincalhões brincam mais cansados) |
| explorar | **alvo:** janela, lâmpada, planta ou cama | 0,2 + 2·curiosidade − distância; pausa de 8 s depois |
| procurar | vem até você | sociabilidade × falta de afeto × (1,2 − independência); com fome e tigela vazia, mais |
| passear | anda até um ponto qualquer | 0,4 + 1,5·atividade |
| descansar | fica parado (2–6 s; mais para os calmos) | 0,5 + 1,5·(1 − atividade) + cansaço; doente, muito mais |
| emburrar | fica emburrado | só impacientes (< 0,35) e entediados |

Todas somam `habit('opção')` (rotina, abaixo). Medido em simulação (30 sorteios, pet com fome, cansado e entediado): o
brincalhão vai **brincar** (20/30), o preguiçoso **dormir** (19/30), o guloso **comer** (25/30). Num dia inteiro sozinho, um
pet ativo passa ~35% do tempo brincando e ~45% dormindo; um calmo ~30% parado e ~49% dormindo; um apegado vem até você
~13% do tempo.

**Brinquedos** (itens não consumíveis, categoria `brinquedo`, prefab no catálogo): a **bola** vem com o quarto (entra no
inventário na primeira vez); a **pelúcia** 🧸 (macia, silenciosa, aconchego; diverte e dá um pouco de afeto) e o
**chocalho** 🔔 (barulhento, ativo; diverte mais) são comprados na loja (12 e 10 moedas, uma vez) e aparecem no quarto.

**Brinquedo favorito** — tem que dar para ver no 1×: é o que o pet mais gosta entre os que você tem (todo pet que gosta
de algum tem um). Na nota de brincar (UtilityAI, `target.props.peso`, que o pet atualiza) o favorito pesa 2,4, um que ele
gosta 1,3, um neutro 0,5 e um que não gosta 0 (nunca escolhe sozinho); o alvo é sorteado ∝ nota² — medido em 5 minutos
reais: **75–90% do tempo de brincadeira é com o favorito**, os outros ainda aparecem. Com o favorito ele vai correndo,
brinca ~7 s pulando alto e mexendo nele sem parar (a bola ele empurra e corre atrás), mostra ♥ (♥ também para a pelúcia,
♪ para os outros) e "brincou um tempão com a pelúcia. Parece ser o brinquedo preferido."; com um que só gosta, ~4 s de
pulinhos; com um neutro, ~2 s e "mexeu um pouco no chocalho e logo perdeu o interesse.".

**Reação na hora** quando um brinquedo aparece (comprado ou tirado da caixa) ou você clica nele: favorito → ♥ e vai correndo
("foi correndo ver a pelúcia e parece adorar!" / "se animou na hora com a bola!"); gosta/neutro → vai brincar; não gosta →
cheira, "…" e se afasta ("cheirou o chocalho e se afastou. Não parece ter gostado."); muito sensível com o chocalho → "!"
e foge ("se assustou com o barulho do chocalho"). Sem energia ou doente: só olha.

**Caixa de brinquedos** (botão **Brinquedos**, `scripts/caixa.js`): uma carta por brinquedo que você tem; clicar guarda
(sai do quarto, continua seu) ou põe de volta. **Arrastar** a pelúcia e o chocalho muda o lugar deles (tag `draggable`;
o clique só conta ao soltar sem arrastar; ao soltar volta para o chão). Arranjo salvo em `storage.quarto`
(`{bolaDada, brinquedos: {id: {guardado, x}}}`, `scripts/brinquedos.js`).

**Sono pelo jeito do pet:** à noite vai dormir abaixo do seu limite de energia (o ativo aguenta mais) e de manhã levanta
mais cedo se for ativo (menos descansado) e mais tarde se for calmo.

**Rotina** (`Routine`, 8 faixas de 3 h, meia-vida de 4 dias, salva com o indivíduo): cada decisão e cada hora de sono são
registradas na faixa do dia em que acontecem. A rotina vira um viés (`habit`) nas notas, então o pet tende a repetir o
que costuma fazer àquela hora — e muda devagar se a vida dele mudar. Os hábitos estáveis (`patterns`) vão alimentar o
diário (fase 7).

Velocidade base 90 px/s × 0,7–1,3 pela atividade (doente ×0,5, energia < 25 ×0,7). As observações ("parece estar com
fome") só contam o que se vê; quem decide é a IA.

## 6a. Memória (V0.7: componente `Memory`)

O pet **lembra** o que viveu, e a lembrança enfraquece com o tempo de jogo (meia-vida por tipo) e fica mais forte quando
se repete. Tudo aparece no 1× em poucos minutos:

| Lembrança (tipo · assunto) | Meia-vida | Quando | O que muda |
|---|---|---|---|
| `comida` · o item | 72 h | comeu ou recusou uma comida (adorou +1 … odiou −1) | **detestou:** da próxima vez reconhece e vira o rosto na hora, sem cheirar ("reconheceu o peixe e virou o rosto."; não come). **Adorou:** se anima antes de comer ("reconheceu a maçã e se animou na hora!") e, ao **abrir a Comida**, vem correndo até a bandeja ("veio correndo quando você abriu a comida.") |
| `susto` · brinquedo | 3 h | o barulho do chocalho assustou um pet sensível | **desconfia:** não escolhe mais o chocalho (peso quase 0) e, se você mexe nele, olha de longe e se afasta ("ainda parece desconfiado do chocalho.") |
| `brinquedo` · brinquedo | 24 h | brincou sozinho (favorito +1, neutro +0,1) | boas lembranças aumentam até 30% a vontade de brincar com ele |
| `brincouComVoce` · você | 8 h | brincou de bola com você | **pede de novo:** vai até a bola e fica olhando para você com "?" ("foi até a bola e está olhando para você. Parece querer brincar de novo."); jogar a bola nessa hora: ♥ e "parece que era exatamente isso que queria!". Pedido ignorado enfraquece a lembrança (pede cada vez menos: ~3 vezes em 10 min, caindo) |
| `carinho` · você | 6 h | carinho bom (+), aceito sem empolgação, recusado (−) | carinhos bons fazem o pet sociável vir até você mais vezes (nota de "procurar") |
| `acordado` · você | 2 h | você o acordou e ele é impaciente | fica chateado: um carinho logo depois o faz se afastar ("ainda parece chateado por ter sido acordado."); procura menos você |

Na Utility AI: `chamar` (nova; só com a bola no quarto, energia > 30; nota = lembrança de brincar com você × 3 × tédio ×
sociabilidade; 60 s de intervalo) e `procurar` + `memory('voce', 'carinho')` × sociabilidade × 1,5 + `memory('voce',
'acordado')` × 2. O peso de cada brinquedo é multiplicado por `1 + 1,2 × lembrança` (entre 0 e 1,3). A memória é salva
com o indivíduo (`storage.petIndividuo`) e volta ao reabrir o jogo.

## 7. Interações do jogador (mouse)

| Ação | Como | Efeito e reação |
|---|---|---|
| Carinho | clicar no pet | afeto +15 (carinhoso +22), diversão +3, pulinho e ♥; repetido em < 6 s: "não parece muito interessado"; dormindo: "se mexeu um pouco" (irritável acorda incomodado) |
| Encher a tigela | clicar na tigela | 3 porções (som); se o pet está acordado e com fome < 70, vai comer |
| Loja | botão "Loja · N 🪙" (canto superior direito) → cartas com preço e quanto você tem → clicar compra 1 | sem moedas: "Faltam moedas para…" |
| Comida | botão → bandeja com as comidas que você **tem** (com quantidade) → clicar numa; vazia: carta que leva à Loja | só sai do inventário se o pet comer | o pet cheira e reage pelo gosto (ver seção 7a); satisfeito (fome > 92): "não parece estar com fome agora" |
| Jogar a bola | clicar na bola | a bola voa e rola; o pet corre atrás se tiver energia > 20, não estiver doente e diversão < 85 (brincalhão sempre); brinca 4 s: diversão +30, energia −8, afeto +5, "ficou animado!" |
| Limpar | clicar na sujeira | uma nuvem de poeira (partículas); higiene +18; sem sujeira: "parece mais à vontade com o quarto limpo" |
| Remédio | botão | doente: cura, saúde +25; saudável: "não parece muito interessado" |
| Luz | clicar na lâmpada | acende/apaga; dormir no escuro recupera energia mais rápido; dormindo com luz à noite: "parece incomodado com a luz" |

Os objetos clicáveis ficam numa camada acima do pet, então dá para clicar na tigela mesmo com o pet na frente.

## 7a. Comidas (itens do catálogo, V0.7)

O catálogo fica em `items/` (uma comida por arquivo): o que importa é **o que a comida é** (tags), não um bônus fixo.

| Comida | Tags | Fome |
|---|---|---|
| 🥣 Ração (tigela) | crocante | +35 |
| 🍎 Maçã | fruta, doce, fresco | +15 (energia +3) |
| 🍌 Banana | fruta, doce, macio | +20 (energia +5) |
| 🥛 Leite | laticínio, líquido | +12 (energia +4) |
| 🧀 Queijo | laticínio, salgado | +18 |
| 🐟 Peixe | proteína, salgado, cheiroso | +30 |
| 🥕 Cenoura | vegetal, crocante, fresco | +12 |
| 🍪 Biscoito | doce, crocante, petisco | +10 |

Gosto de um pet por uma comida = 40% o gosto por ela mesma + 60% pelas tags, e nas tags pesa mais o sentimento mais
forte (um cheiro odiado estraga qualquer comida cheirosa). As tags têm faixas largas, então cada pet costuma ter uma
comida favorita (~60%) e uma que recusa (~35%), e dois pets discordam com frequência. Exemplos de pets novos: um adora
maçã e odeia banana; outro adora queijo e odeia cenoura.

| Gosto | Reação (depois de cheirar) | Efeito |
|---|---|---|
| adora | come rápido, ♥ ♥, pula; "parece ter adorado a maçã!" | fome cheia, afeto +10, diversão +5 |
| gosta | come, ♥; "parece ter gostado da maçã." | fome cheia, afeto +5 |
| neutro | come sem pressa; "comeu a maçã sem muito entusiasmo." | fome cheia |
| não gosta | belisca e emburra; "comeu só um pouco da maçã. Não parece ter gostado muito." | metade da fome |
| odeia | se vira e se afasta, a comida some no chão; "cheirou a maçã e se afastou." | nada (não é consumida) |

Mais de 4 doces por dia: saúde −2 e "parece ter comido doce demais hoje". A ração da tigela também é um item: quem não
gosta dela come devagar e só com mais fome. A bola é o item `bola` (brinquedo: ativo, rola).

## 7b. Moedas, inventário e loja (V0.7)

Economia da engine (`game.wallet`, `game.inventory()`, `game.shop`), salva junto com o jogo. Moeda: **moedas** (🪙).
O botão **Loja · N 🪙** mostra o saldo; cada ganho sobe dele como "+N 🪙".

| Ganho | Moedas | Limite |
|---|---|---|
| cesta de boas-vindas (uma vez por save) | 15 + maçã, cenoura, leite e biscoito | — |
| primeira visita de cada dia | 10 ("Um novo dia com Mimi: +10 moedas.") | 1 por dia (dias fora não acumulam) |
| oferecer uma comida que o pet nunca provou (descobrir o gosto) | 3 | 1 por comida por pet |
| brincar com a bola | 2 | a cada 30 min de jogo |
| limpar uma sujeira | 1 | — |
| o pet ficar muito feliz | 2 | junto da observação (a cada 3 h de jogo) |

Preços: cenoura e biscoito 2, maçã e banana 3, leite 4, queijo 6, peixe 8. A ração da tigela é grátis (cuidado básico
não é pago). A ideia é comprar algo novo para experimentar a cada dia ou dois, sem planilha: descobrir gostos é o que
mais rende. Brinquedos: pelúcia (12) e chocalho (10), uma vez cada (seção 6). Móveis, camas e lâmpadas entram com o ambiente (fase 8).

## 8. Sistema de observação

Fluxo: **estado → evento → notificação**, tudo pelo `game.notify` da engine (V0.7, fase 6). Cada notificação tem um tipo
(`kind`) com **cooldown**: o mesmo tipo só volta depois de N minutos de jogo **e** de pelo menos 25 s reais (para não
virar spam em 600×); os cooldowns de jogo e o histórico (50) ficam em `storage["vibe.notifications"]` e valem entre
sessões. As checagens automáticas têm **prioridade 0** e as reações a você prioridade 1: até 4 s reais depois de uma
observação (`config.notifications.minGapMs`), as automáticas não aparecem. A faixa no topo (`scripts/aviso.js`, evento
`notification`) mostra uma por vez por 5 s — 2,5 s se outra estiver esperando, para a reação ao que você fez não chegar atrasada (fila de no máximo 3). O diário lista as últimas 6 do histórico; um novo pet
limpa o histórico.

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
tigela." · "{n} está olhando para a tigela vazia." · "{n} parece estar
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

Playbooks de regressão em `playbooks/` (rodar com `run_playbooks`): `limpar_sujeira`, `encher_tigela`, `carinho`,
`bola`.

## 13. Limitações e pontos em aberto

- Só existem quadros parados: dormir, comer e brincar são animações improvisadas (o pet dorme de olhos abertos).
- Cenário e objetos são formas simples; não há trilha sonora; os sons são efeitos sintetizados.
- Balanceamento é um primeiro chute: ritmos das necessidades, 12 h / 36 h para evoluir, limites de doença.
- O pet adulto não envelhece nem muda depois de adulto; não há morte (decisão de design).
- Um único quarto; sem objetos novos para desbloquear, sem itens de loja, sem mini-jogos.
- A personalidade só aparece no diário depois de 3 sinais; não há outra pista explícita.
- Sem acessibilidade de teclado para as ações (só mouse, exceto digitar o nome).
