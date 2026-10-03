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
- **Diário** (painel sobre o quarto, V0.7 fase 7) em três abas — **Jeito · Gostos · Histórias** — que só contam o que
  você teve chance de ver, com a confiança disso e **sem números** (seção 8a). Na fase adulta: botão "Começar com um
  novo pet".
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
| luz e cortina (seção 6e) | apagar: ♥ "parece gostar do quarto mais escuro."; acender: 💢 "apertou os olhos com a luz. Parece preferir o escuro."; dorme pior com a luz acesa ("dormindo mal: parece incomodado com a luz") — seção 6b | não reage | quem prefere claridade: apagar ❗ "não parece gostar do escuro."; acender ♥ "parece mais à vontade com a luz acesa." Dormindo, só se mexe (💢 se incomodou) |

**Revelação:** cada comportamento típico de um traço **forte** (> 0,65 ou < 0,35) é meio ponto de evidência no
`Knowledge` ("jeito:atividade:alto"...). Com 1 ponto o diário diz "Talvez seja bastante ativo.", com 3 "Parece ser…",
com 6 "É bastante ativo." (16 descrições possíveis); confirmado, vira também uma página da história.

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

**Caixa de coisas** (botão **Coisas**, `scripts/caixa.js`): uma carta por brinquedo ou coisa do quarto que você tem; clicar guarda
(sai do quarto, continua seu) ou põe de volta. **Arrastar** a pelúcia e o chocalho muda o lugar deles (tag `draggable`;
o clique só conta ao soltar sem arrastar; ao soltar volta para o chão). Arranjo salvo em `storage.quarto`
(`{bolaDada, brinquedos: {id: {guardado, x}}}`, `scripts/brinquedos.js`).

**Sono pelo jeito do pet:** à noite vai dormir abaixo do seu limite de energia (o ativo aguenta mais) e de manhã levanta
mais cedo se for ativo (menos descansado) e mais tarde se for calmo. De dia só dorme de verdade com energia < 50; entre
50 e 80, **cochila** (seção 6b).

## 6e. Luz e cortina: o jeito de cada pet com a claridade

A janela tem uma **cortina** (duas metades, `scripts/cortina.js`): clicar nela ou no vidro abre/fecha (ela corre suave;
estado em `storage.quarto.cortina`). Fechada, tapa a luz do dia — a janela emite 10% da luz e o quarto escurece de dia
se a lâmpada estiver apagada (`ceu.js`). Cada pet tem um jeito com a claridade (gosto por escuro + sensibilidade):

| Jeito | Quem | Gosta de | Reação ao melhorar / piorar |
|---|---|---|---|
| **escuro** | gosto por escuro ≥ 0,2 (ou muito sensível) | cortina fechada **e** luz apagada | ♥ "parece gostar da cortina fechada / do quarto mais escuro." · 💢 "apertou os olhos com a claridade / com a luz…" |
| **luz** | gosto por escuro ≤ −0,2 | cortina aberta **e** luz acesa | ♥ "parece gostar da cortina aberta / mais à vontade com a luz acesa." · ❗ "não parece gostar do quarto mais escuro / do escuro." |
| **normal** | o resto, sensibilidade ≥ 0,35 | quarto claro acordado e escuro dormindo (a cortina tanto faz) | ♥ "parece mais à vontade com o quarto claro." · 💢 "não parece gostar do quarto escuro agora." |
| **indiferente** | o resto, pouco sensível | tanto faz | não reage |

Dormindo, só se mexe (z se melhorou; 💢 "se mexeu incomodado com a claridade" / "inquieto no escuro"), e a qualidade do
sono já conta a luz de verdade (lâmpada + janela com a cortina). **Mais feliz:** com o quarto todo do jeito dele, o afeto
sobe 1,5/h e a cada ~90 s ele mostra ♪ ("parece à vontade com o quarto assim."); todo do jeito errado, o afeto cai 1,5/h
e a cada ~60 s aparece 💢 ("parece incomodado com a claridade" …). As reações viram evidência no diário: "Gosta de
ficar no escuro", "Não gosta de ficar no escuro", "Parece gostar de luz acesa acordado e escuro para dormir", "Não liga
muito para ficar no escuro".

## 6d. Sinais (sem palavras)

Como os ♥ e ♪, o pet mostra o que **não** gosta: **💢** (vermelho) quando não gosta — comida recusada ou reconhecida e
recusada, "comeu só um pouco", carinho indesejado, ser acordado, música de que não gosta, coisa que cheira e larga,
brinquedo de que não gosta, luz para quem prefere o escuro; **❗** vermelho quando se assusta (barulho do chocalho);
**❗** âmbar quando fica desconfiado (o brinquedo que o assustou, o escuro para quem prefere luz). O gosto por escuro
agora é sorteado de −0,9 a 0,9 (+ sensibilidade), então muitos pets têm uma preferência clara.

## 6c. Gostos que mudam (V0.7: `Preferences.learnFrom`, evento `preference_change`)

O gosto **inato** nunca muda; a parte **aprendida** anda devagar com o que ele vive (`learnRate` 0,1 por experiência,
no máximo ±0,5) e conta **inteira** na reação àquela coisa (a expectativa pelas tags não a dilui). Quando um gosto
cruza um nível você vê:

| Experiência | Ensina |
|---|---|
| comer uma comida (memória `comida`) | adorou +0,1, gostou +0,05, não gostou −0,06, detestou −0,1 |
| **comer com fome** (fome < 50, algo que não detesta) | +0,08 a mais — uma cenoura indiferente vira "gosta" depois de ~5 refeições com fome |
| brincar sozinho com um brinquedo (`brinquedo`) | favorito +0,06 … não gosta −0,02 |
| susto com o barulho (`susto`) | −0,12 (além da desconfiança de algumas horas) |
| dançar com a música / se afastar dela (`musica`) | +0,06 / −0,06 na caixinha |
| carinho bom / ruim | +0,03 / −0,03 no carinho |

**Enjoo** (passa): a comida que ele **gosta ou adora**, repetida em seguida, enjoa — memória `enjoo` (meia-vida 2 h)
tira até um nível ("{n} comeu a maçã, mas parece estar enjoando um pouco."), nunca até recusar. Horas depois volta ao
normal; o gosto de verdade não muda (a memória e o diário ficam com ele). Do que é indiferente não há o que enjoar.

**Quando um gosto muda de nível:** observação ("{n} parece ter começado a gostar de cenoura." · "passado a adorar" ·
"não se incomodar mais com" · "perdido o interesse por" · "começado a não gostar de" · "passado a detestar"), página
na aba Histórias ("Começou a gostar de cenoura."), e na aba Gostos o nível antigo perde metade da evidência e o novo
passa na frente.

## 6b. Ambiente e sono (V0.7: componente `Ambient`)

Cada coisa do quarto põe algo no ambiente (`Ambient`, com alcance), e o pet sente pelo lugar onde está (`game.env`):

| Emissor | Emite | Alcance |
|---|---|---|
| lâmpada (acesa) | luz 1 | quarto todo |
| janela | luz 0,8 de dia → 0 à noite (segue o céu) | quarto todo |
| cama | conforto 0,6 | 100 px, plano |
| **cestinha fofa** 🧺 (loja, 14; macia, aconchego) | conforto 0,9 | 75 px, plano |
| **caixinha de música** 🎶 (loja, 16; clique liga/desliga) | música 1 e ruído 0,35 (notas ♪ e uma melodia de 3 notas enquanto toca) | 520 px |

- **Onde dorme** (`lugarDeDormir`: cama, cestinha): o de maior conforto + gosto pelo item − ruído × sensibilidade. Na
  cestinha ele deita ao lado dela (ela aparece atrás). Primeira vez num lugar novo: "Dormiu pela primeira vez na
  cestinha fofa." no diário.
- **Qualidade do sono** (0..1) = 0,45 + conforto × 0,45 − luz × (0,12 + gosto por escuro × 0,45 + sensibilidade acima de 0,5
  × 0,4) (+ um pouco para quem gosta de claridade) − ruído × (0,2 + sensibilidade × 0,7) + música × gosto por música ×
  0,25. A energia recuperada por hora vai de ×0,55 a ×1,35. **Dá para ver:** bem (≥ 0,7) = "z" devagar e "{n} está
  dormindo tranquilo na cestinha fofa."; mal (< 0,4) = "~", balança e vira de lado, "{n} está dormindo mal: parece
  incomodado com a luz / o barulho." (vira evidência de gosto por escuro e de sensibilidade no diário).
- **Cochilo** (UtilityAI `cochilar`, alvo um lugar de dormir, de dia, energia < 80, 90 s de intervalo): nota =
  (1,3 − atividade) × cansaço × (0,4 + conforto do lugar) × (1 − ruído × sensibilidade). Cochila 20–60 s reais (o
  calmo mais), recupera energia como dormindo e "{n} tirou um cochilo na cestinha fofa.".
- **Música**: ligar a caixinha → quem gosta se anima e vai dançar perto dela (pula, balança, ♪ ♫; "se animou todo com
  a música!"); neutro só olha; quem não gosta (ou é muito sensível) mostra "…" e vai para o outro lado ("não parece
  gostar da música"). Enquanto toca: `dancar` (alvo a caixinha tocando) e `afastar` (se a música chega até ele e
  incomoda). Primeira dança vai para o diário; "música" entra nos gostos.
- **Coisa nova no quarto** (comprada ou tirada da caixa): ele vai conferir; um lugar de dormir de que gosta ele
  experimenta na hora ("deitou na cestinha fofa para experimentar. Parece ter gostado!").

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
| Carinho | clicar no pet | afeto +15 (carinhoso +22), diversão +3, pulinho e ♥; repetido em < 6 s: "não parece querer mais carinho agora"; dormindo: "se mexeu um pouco" (irritável acorda incomodado) |
| Encher a tigela | clicar na tigela | 3 porções (som); se o pet está acordado e com fome < 70, vai comer |
| Loja | botão "Loja · N 🪙" (canto superior direito) → cartas com preço e quanto você tem → clicar compra 1 | sem moedas: "Faltam moedas para…" |
| Comida | botão → bandeja com as comidas que você **tem** (com quantidade) → clicar numa; vazia: carta que leva à Loja | só sai do inventário se o pet comer | o pet cheira e reage pelo gosto (ver seção 7a); satisfeito (fome > 92; de pouco apetite, > 78): "não parece estar com fome agora" |
| Jogar a bola | clicar na bola | a bola voa e rola; o pet corre atrás se tiver energia > 20, não estiver doente e diversão < 85 (brincalhão sempre); brinca 4 s: diversão +30, energia −8, afeto +5, "ficou animado!" |
| Limpar | clicar na sujeira | uma nuvem de poeira (partículas); higiene +18; sem sujeira: "parece mais à vontade com o quarto limpo" |
| Remédio | botão | doente: cura, saúde +25; saudável: "não parece precisar de remédio" |
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
`notification`) mostra uma por vez por 5 s — 2,5 s se outra estiver esperando, para a reação ao que você fez não chegar atrasada (fila de no máximo 3). Um novo pet limpa o histórico.

## 8a. Diário (V0.7: `Knowledge` + `Journal`)

**O que você sabe** (`Knowledge` do pet: possível ≥ 1, observado ≥ 3, confirmado ≥ 6 de evidência) — cada reação vista
conta: comida adorada/detestada 2, gostou/não gostou 1,5, neutra 1 (reconhecer pela memória: metade); bola, carinho e
luz igual; brincar sozinho com um brinquedo conta o gosto dele (metade) e, se é o favorito, "favorito:{id}". Por isso
uma maçã adorada uma vez dá "Talvez adore maçã.", duas "Parece adorar maçã.", três "Adora maçã." — e uma banana
adorada que você nunca ofereceu **não aparece**.

| Aba | Conteúdo |
|---|---|
| **Jeito** | idade e fase; até 6 jeitos ("Talvez seja curioso." / "Parece ser…" / "É…"); até 4 hábitos da rotina estável ("Costuma dormir de madrugada." — madrugada, manhã, tarde, noite; aparecem com os dias) |
| **Gostos** | Comidas (até 7, sem artigo: "Adora maçã."), Brinquedos ("O brinquedo preferido parece ser a pelúcia.", "Talvez adore a bola."), Outras coisas (carinho, dormir no escuro). Por assunto vale o nível com mais evidência. Nada visto: "Ainda não deu para perceber do que gosta." |
| **Histórias** | a história inteira (o `Journal` guarda até 80 entradas), da mais nova para a mais antiga, com "Dia N", em páginas |

**Como cada jeito se mostra** (sinais que contam para "jeito:eixo:alto|baixo"; só contam se o pet é mesmo assim — traço
≥ 0,65 ou ≤ 0,35; peso 0,5, ou 1 quando o sinal é inequívoco). Desde a fase 12 os **traços baixos também se mostram**:
antes, um pet calmo passava 36 h com um só traço no diário.

| Eixo | alto | baixo |
|---|---|---|
| atividade | passeia pelo quarto; Pega-pega (corre rápido) | fica parado; dorme de dia; Pega-pega (devagar) |
| sociabilidade ("sociável" / "reservado") | vem até você; adora carinho | aceita carinho sem empolgação ou se afasta |
| curiosidade | investiga cantos; fareja a caixa certa nas Caixinhas | olha uma coisa nova de longe e continua o que fazia (peso 1); nas Caixinhas, nem fareja |
| independência ("independente" / "grudento") | brinca sozinho; se afasta do carinho | vem até você |
| sensibilidade ("sensível" / "tranquilo com o que acontece em volta") | dorme mal (luz, barulho); se assusta com barulho | dorme bem com a luz acesa; brinca com o chocalho sem se incomodar |
| apetite ("guloso" / "de pouco apetite") | come com vontade o que adora | satisfeito mais cedo: recusa comida com fome > 78 |
| paciência | — | emburra; acordado fica chateado; nas Caixinhas, não espera você |
| brincadeira | brinca, corre atrás da bola | olha a bola passar |

Cada aba é dividida em **páginas** que cabem no papel (14 linhas, estimando as que quebram; um título de seção não fica
sozinho no fim): ◀ 1/2 ▶ no canto de baixo à esquerda (`scripts/diarioSeta.js`); trocar de aba volta à página 1.

**Páginas da história** (cada uma uma vez só): Chegou ao quarto · Começou este diário (saves antigos) · Provou {a comida}
pela primeira vez e adorou / gostou / sem muito entusiasmo / não gostou muito / recusou na hora · Recebeu o primeiro
carinho e adorou (ou se afastou…) · Brincou com {o brinquedo} pela primeira vez · Escolheu {o brinquedo} como brinquedo
preferido · Levou um susto com o barulho do chocalho · Parece ter esquecido o susto com o chocalho (quando a memória
se apaga) · Brincou de bola com você pela primeira vez · Pediu pela primeira vez para brincar de bola · Ficou chateado
quando você o acordou · Ficou doente pela primeira vez · Ficou claro que é {jeito} · Cresceu: agora é jovem/adulto.

Saves antigos: os sinais de jeito viram evidência (3 sinais = observado), as comidas já provadas viram gostos vistos, e
a história começa em "Começou este diário." (sem inventar o passado). O texto quebra linha sozinho (`Text.maxWidth`).

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
"{n} não parece gostar disso agora." · "{n} não parece querer mais carinho agora." · "{n} não parece com vontade de
brincar agora." · "{n} parece ter gostado do petisco." ·
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
- **Jovem 1 ou 2** (V0.7 fase 10: a vida que levou): soma o que ele mais fez na infância — os pesos da rotina
  (`Routine`, toda decisão registrada) de brincar, explorar, passear, dançar, chamar para brincar (**ativo**) contra
  descansar, cochilar, vir até você (**calmo**), mais brincadeiras com você ×1,5 (ativo) e carinhos ×1,5 (calmo).
  Ativo → **Jovem 1**; calmo e carinhoso → **Jovem 2**. Como as decisões vêm do jeito dele e do que você faz, a forma
  é dos dois.
- **Adulto** (como foi cuidado): nota = bem-estar médio × 0,6 + relação com você × 0,25 + variedade de comida × 0,15
  (relação: parte de 30, + lembranças de carinho e de brincar com você, + até 25 pelas interações, − se foi acordado
  há pouco; variedade: 18 por comida provada). ≥ 70 → **1**, ≥ 45 → **2**, abaixo → **3**. A letra vem da linha do
  jovem: Jovem 1 → **a**, Jovem 2 → **b**. São 6 adultos diferentes (1a, 2a, 3a, 1b, 2b, 3b).
- **O diário explica**: ao crescer, "{n} cresceu! Passou a infância brincando e explorando o quarto." / "…Foi muito bem
  cuidado, confia muito em você e come de tudo um pouco." (ou "passou por uns apertos", "gosta da sua companhia", "se
  acostumou a ficar sozinho", "quase só conheceu ração"), e a mesma frase vira a página da história. **Antes** de
  crescer, a aba Jeito tem "Crescendo": "Passa o tempo brincando e explorando o quarto: parece que vai crescer ativo." /
  "Está crescendo muito bem cuidado." — sem números.
- Ao evoluir: pulsa, som, a forma entra na coleção.

## 10a. Brincar junto: minigames (V0.7 fase 11)

- Botão **Brincar** (à direita, abaixo de Coisas) abre dois jogos. Cada um é uma cena à parte (engine
  `startMinigame` / `endMinigame`): o quarto fica guardado como estava e volta igual no fim.
- O pet leva para o jogo a forma, o jeito (atividade, curiosidade, paciência) e o que acha de cada comida.
- **Pega-pega** (30 s): comidas e estrelas caem; você guia o pet com o mouse. A cada comida ele reage pelo gosto
  (♥ gosta/adora, nada se é indiferente, 💢 e para um instante se não gosta/detesta). Pets **ativos correm mais**.
  O tempo é uma barra; o que ele pegou aparece em fila no alto. No fim: "pegou bastante coisa", "Ficou feliz com: 🍎",
  "Fez careta para: 🐟" e as moedas.
- **Caixinhas** (3 rodadas): o **ossinho 🦴** — só do jogo: não se compra, não é comida, não mata a fome — entra
  numa caixa, as caixas se embaralham (cada vez mais trocas e mais rápido) e você clica onde está. O pet vai abrir e
  fica feliz (♥♥ se você acertou); errou, ele fareja até a certa. Achar é sempre bom: nenhum gosto envolvido. Um pet **curioso** fareja e chega perto da caixa certa antes de você escolher (uma dica, se você olhar
  para ele); um **sem paciência** não espera e vai abrir uma sozinho se você demora. No fim: ✅ ❌ por rodada.
- **Na volta ao quarto**: diversão sobe (mais se foi bem), afeto +6, cansa (Pega-pega cansa mais, e gasta um pouco
  de fome); lembrança "brincou com você" (conta para a relação e a evolução); as reações viram **pistas no diário**
  ("Talvez adore maçã" já na primeira partida) e o jogo mostra o jeito (rápido, farejador, impaciente); moedas (até 6
  por partida, 15 por dia em jogos); página "Brincou de Pega-pega com você pela primeira vez" e "foi melhor do que
  nunca" num recorde; observação "{n} adorou brincar de Pega-pega com você!".
- **Recusa**: dormindo, doente, cansado demais ou com fome demais, ele não vai (e a observação diz por quê).

## 11. Coleção ("pokédex") e novo pet

- Toda forma alcançada fica registrada (com o nome do pet que a revelou), mesmo depois de trocar de pet.
- O novo pet **começa do zero**: os itens, as moedas e a arrumação do quarto do anterior não passam para ele (ele
  ganha a cesta de boas-vindas, as 15 moedas e a bola). A coleção e a velocidade ficam.
- Na fase adulta, o Diário oferece **"Começar com um novo pet"** (pede um segundo clique para confirmar). O adulto vai
  para "Pets anteriores" (nome, forma final, dias de vida, traços percebidos) e o jogo volta à tela de nomear.
- O objetivo de longo prazo implícito é descobrir as 9 formas.

## 12. O que foi verificado (testes jogando)

Testado em execuções automatizadas do próprio motor (determinísticas, com relógio controlado) e em screenshots:
nomear e começar; pular direto para o quarto com save; céu e escuridão por hora; comportamento autônomo; comer,
dormir e acordar; carinho, tigela, bola, petisco, remédio, limpeza, luz; observações sem spam a 600×; evolução para
Jovem 1 e Jovem 2 conforme o cuidado e para Adulto 3a com abandono; resumo de tempo fora; novo pet na fase adulta e
coleção. A plataforma tem testes que confirmam que o save no disco sobrevive a um navegador novo.

**Avaliação da V0.7 (fase 12)** — dois pets gerados pela seed, os mais opostos entre 40 (Faísca: ativo, curioso,
brincalhão; Sereno: calmo, pouco curioso, de pouco apetite, impaciente), com **o mesmo jogador**: 10 min sozinhos a 1×,
as mesmas comidas, carinho, bola, luz e cortina, os dois minigames, depois 36 h a 60× com cuidado de hora em hora.
Faísca passou 60% dos primeiros 10 min brincando, Sereno 21% (e 35% parado); no Pega-pega, com as mesmas comidas
caindo, Faísca fez careta para o peixe e Sereno adorou; Faísca (gosta de escuro) dormiu mal com a luz e se incomodou
com a claridade, Sereno ficou "mais à vontade com a luz acesa"; cresceram por caminhos diferentes ("passou a infância
brincando" × "descansando") e os diários contam histórias diferentes. Ajustes que a avaliação pediu: sinais dos
traços baixos (acima), história inteira no diário (antes, só as 10 últimas), "sociável" no lugar de "muito apegado a
você" (contradizia "independente"), observações que dizem do quê, "começou a gostar da bola" (contração), o brinquedo
preferido já sabido não é repetido de hora em hora, e o resumo das Caixinhas conta quando o pet não esperou.

Playbooks de regressão em `playbooks/` (rodar com `run_playbooks`): `limpar_sujeira`, `encher_tigela`, `carinho`,
`bola`.

## 13. Limitações e pontos em aberto

- Só existem quadros parados: dormir, comer e brincar são animações improvisadas (o pet dorme de olhos abertos).
- Cenário e objetos são formas simples; não há trilha sonora; os sons são efeitos sintetizados.
- Balanceamento é um primeiro chute: ritmos das necessidades, 12 h / 36 h para evoluir, limites de doença.
- O pet adulto não envelhece nem muda depois de adulto; não há morte (decisão de design).
- Um único quarto; a loja tem 13 itens e há 2 minigames (prova de conceito da arquitetura).
- Com os outros traços iguais, um pet ativo dorme ~40% do dia e um calmo ~45%: a diferença existe, mas é pequena.
- Sem acessibilidade de teclado para as ações (só mouse, exceto digitar o nome).
