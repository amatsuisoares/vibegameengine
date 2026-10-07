# V0.8 — Desejos, eventos e vínculo (análise e arquitetura)

Objetivo: dar ao jogador **o que fazer em cada visita** e **motivo para experimentar coisas novas**, mesmo depois
de descobrir os favoritos. O pet passa a **querer** coisas (comer peixe, algo crocante, brincar de bola, ficar no
escuro…) e **acontecimentos** quebram a rotina do quarto (um passarinho na janela, uma tempestade, uma amostra
grátis na porta). Atender e participar do jeito certo aumenta o **vínculo** com você, que pesa na evolução.

O ciclo de uma visita vira: o pet mostra um desejo → o jogador interpreta → tenta (às vezes compra algo novo na loja)
→ o pet reage → o vínculo cresce e o diário registra.

Este documento é a Fase 1 (análise). A V0.9 (App) vem depois desta.

## 1. Diagnóstico

- **Visita sem objetivo.** A 1× o jogador enche a tigela, faz carinho, joga a bola e observa. A descoberta é passiva:
  ninguém chega com uma pergunta na cabeça.
- **A loja morre cedo.** Depois de achar a comida e o brinquedo favoritos, comprar outra coisa só serve para
  completar o diário. O enjoo (fase 9) empurra um pouco para variar, mas é invisível como motivo.
- **Relação fácil e sem memória longa.** `cuidado().relacao` vem de lembranças curtas (carinho: meia-vida de 6 h;
  brincar: 8 h) e de contadores que batem no teto em ~13 interações. Na avaliação da fase 12 os dois pets chegaram
  ao adulto 1 com um cuidado mecânico de hora em hora: **não há como fazer melhor que o básico**.
- **Nada acontece por si.** O quarto só muda quando o jogador mexe ou quando uma necessidade cai.

## 2. O que existe e é reaproveitado

| Peça | Uso nesta versão |
|---|---|
| `Preferences` (gostos por item e por tag, inato + aprendido) | escolher o que ele deseja (gosta, mas não é o de sempre; uma tag; uma novidade) |
| `Memory` (lembranças com força e meia-vida) | "você atendeu meu desejo" vira lembrança; desejos negados recentes pesam |
| `Knowledge` / `Journal` | desejo atendido revela gosto; primeira vez de cada evento vira página |
| `Routine`, `Traits` | quem deseja o quê e quando (sociável pede colo, curioso pede novidade, impaciente desiste rápido) |
| `game.notify` (prioridade, cooldown) | observações dos desejos e eventos sem spam |
| `UtilityAI` com alvos | comportamento de pedir (ir até a tigela/caixa/janela e olhar para você) |
| Itens, inventário, loja, `useItem`/`onItem` | atender desejos de comida e brinquedo; itens que você ainda não tem |
| Relógio de calendário, `Persist` | desejos e eventos duram tempo de jogo e sobrevivem a fechar o jogo |

## 3. Divisão engine × jogo

| Engine (genérico) | Jogo `meu-pet` |
|---|---|
| **`Relationship`** (vínculo): afinidade por alvo (ex.: `"player"`) que cresce com retorno decrescente perto do topo, limite por motivo e por dia, volta devagar a uma base sem contato (meia-vida no relógio), níveis com evento `relationship_level`; `bond()` nas expressões; salvo pelo `Persist`; no estado | quanto vale cada coisa (desejo atendido, evento bem resolvido, carinho de que gosta, acordar sem querer) e o que muda com o vínculo |
| **`Desires`** (desejos): ciclo de vida de desejos `{kind, subject, data}` — criar com duração no relógio, no máximo N ao mesmo tempo, intervalo mínimo e limite por dia; **atendimento automático por evento** (`fulfillOn: {event, match}`, ex.: `item_used` com o item desejado, ou com uma tag), expiração; eventos `desire_start` / `desire_fulfilled` / `desire_expired`; `wants()` nas expressões; salvo; no estado | o que ele deseja (candidatos por gosto, tag, novidade, personalidade, hora), como mostra (balão 💭 com o ícone, comportamento, observação) e a reação ao atender/perder |
| **`Happenings`** (eventos aleatórios / "diretor"): um baralho de eventos `{id, weight (expr), when (expr), cooldownHours, maxPerDay, durationMin}` sorteado pela seed no relógio do jogo, com intervalo médio; um evento por vez; eventos `happening_start` / `happening_end`; salvo; no estado e controlável nos testes (`game.happenings.start(id)`) | os eventos (o que aparece no quarto, como cada jeito reage, qual é a participação certa e o prêmio) |

Tudo aparece no `inspect_game_state` e em eventos, então os testes e os playbooks verificam desejos e eventos sem
mexer no storage.

## 4. Desenho no meu-pet

### Desejos

Como aparecem: **balão de pensamento** sobre o pet (💭 + ícone: 🐟, ⚽, 🌙, ♪…; para tag, 💭❓), **comportamento**
(vai até a bandeja/caixa/janela, olha para você, cutuca) e uma **observação** ("{n} parece com vontade de comer
peixe.", "{n} parece querer algo crocante."). O pet nunca fala.

| Tipo | Exemplo | Quem deseja mais | Atende |
|---|---|---|---|
| comida específica | "com vontade de comer peixe" — algo que gosta mas não comeu há tempo, **às vezes algo que você não tem** | guloso | dar aquela comida |
| comida por tag | "querer algo crocante / doce / fresco" | todos | dar qualquer comida com a tag (hipótese!) |
| novidade | "curioso com um cheiro novo" | curioso | uma comida/brinquedo que ele nunca provou |
| brinquedo | "olhando para a caixa de brinquedos… parece querer a pelúcia" (às vezes um que você não tem) | brincalhão | pôr o brinquedo no quarto / brincar com ele |
| brincar com você | "foi buscar a bola e olha para você" | sociável, ativo | jogar a bola / um minigame |
| carinho / companhia | "veio se encostar em você" | sociável | carinho (o certo depende do gosto) |
| ficar quieto | "parece querer ficar sozinho um pouco" | independente | **não mexer** nele por um tempo |
| ambiente | "incomodado com a claridade, olha para a cortina" / "parece querer música" | sensível | cortina, luz, caixinha de música |

- Desejo errado (tag errada, outra comida) não pune: ele come normalmente e o balão continua.
- Expirar não pune: perde a chance e um "parece ter desistido". Impacientes desistem antes.
- Atender: ♥♥, alegria, **vínculo +**, lembrança "desejoAtendido", às vezes um pouco de moeda, página do diário
  na primeira vez de cada tipo; desejo de comida atendido também revela o gosto no diário.
- Frequência pensada para o 1×: quase sempre há um desejo nos primeiros minutos de uma visita (ele "estava
  esperando você"), depois um a cada ~15–30 min acordado; nenhum dormindo; no máximo um por vez.

### Eventos aleatórios

| Evento | O que acontece | Reação pelo jeito | Participar certo |
|---|---|---|---|
| Passarinho na janela | um pássaro pousa e canta | curioso cola na janela; sensível se assusta; ativo pula | abrir a cortina e deixar ele ver |
| Tempestade (noite) | chuva, trovões, quarto pisca | sensível treme e se esconde | carinho, luz acesa, fechar a cortina |
| Borboleta | uma borboleta voa pelo quarto | ativo persegue; calmo só olha | clicar nela e soltar pela janela |
| Achado | ele fuça embaixo da cama e acha algo | curioso acha mais | clicar no achado (moeda, item perdido) |
| Amostra grátis | uma caixinha na porta com uma comida nova | — | oferecer a amostra (descoberta sem gastar) |
| Vendedor | a loja ganha um item especial por algumas horas | — | comprar (decoração/brinquedo raro) |
| Pesadelo (noite) | acorda assustado | sensível mais | carinho acalma |
| Espirros | espirra algumas vezes | — | sinal de que vai adoecer: remédio cedo evita |
| Bagunça | derruba o vaso | impaciente/entediado | limpar; brincar com ele depois |
| Presente (vínculo alto) | traz um brinquedo e deixa perto de você | sociável | aceitar (clicar) |

Eventos bem resolvidos: vínculo +, lembrança e página do diário ("Dia 3 · Teve medo da primeira tempestade e você
ficou com ele."). Mal resolvidos ou ignorados: só a chance perdida (sem punição severa).

### Vínculo

- Substitui a `relacao` de `cuidado()` (evolução adulta). Cresce com desejos atendidos e eventos resolvidos; o
  cuidado básico (tigela, carinho) mantém, mas **não leva ao topo sozinho**.
- Diário (aba Jeito), sem números: "Ainda está se acostumando com você." → "Gosta da sua companhia." → "Confia
  em você." → "Confia em você de olhos fechados."
- Comportamentos ligados a ele: vir te receber quando você abre o jogo, presentes, pedir em vez de desistir.

## 5. Riscos

- **Spam**: desejos + eventos + observações. Mitigação: um desejo e um evento por vez, intervalos no relógio, tudo
  pelo `Notifier` com prioridade; o balão fala mais que o texto.
- **Velocidade ×60/×600**: com intervalos no relógio, a 600× choveria desejo. Eventos e desejos só nascem com o
  jogo aberto e acordado, com intervalo mínimo real além do de relógio (como o Notifier).
- **Virar lista de tarefas**: desejos explícitos demais viram "missões". Mitigação: o tipo por tag e o de novidade
  exigem hipótese; o "ficar quieto" exige *não* agir; o balão só às vezes diz exatamente o item.
- **Economia**: desejos por itens que você não tem empurram para a loja; o prêmio em moedas é pequeno e o teto
  diário de moedas continua.
- **Saves**: componentes novos são opcionais; o save atual ganha vínculo inicial a partir das lembranças e
  contadores de hoje (migração no jogo).

## 6. Fases

| Fase | Engine | meu-pet |
|---|---|---|
| 1 ✅ | análise (este documento) | — |
| 2 ✅ | `Relationship`, `bond()` | vínculo com você no lugar da `relacao`; migração; diário; evolução adulta pelo vínculo; camas que se trocam (uma em uso) |
| 3 ✅ | `Desires` (ciclo de vida, atendimento por evento, expiração), `wants()` | balão 💭; desejos de comida (específica, por tag, novidade — inclusive o que você não tem) |
| 4 ✅ | — | desejos de brinquedo, brincar com você, carinho, ficar quieto, ambiente; quem deseja o quê pela personalidade |
| 5 ✅ | `Happenings` (baralho, sorteio no relógio, um por vez) | passarinho, borboleta, achado, amostra grátis, espirros |
| 6 ✅ | — | tempestade, pesadelo, bagunça, vendedor, presente; participação certa por jeito e prêmios |
| 7 | — | balanceamento a 1× (o que acontece numa visita de 5 min, numa de 30 min, voltando no dia seguinte), avaliação com dois pets opostos |
