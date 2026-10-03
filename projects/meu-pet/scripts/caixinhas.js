// Caixinhas (minigame, cena "caixinhas"): o ossinho de brincar entra numa das três caixas, elas se embaralham e
// você aponta onde ele está; o pet vai lá abrir e fica feliz de achar. O ossinho é só do jogo (não se compra, não
// é comida, não mata a fome): achar é sempre bom, sem gosto envolvido. O jeito dele aparece:
// um pet curioso fareja e chega perto da caixa certa (uma dica); um sem paciência não espera você escolher.
// Três rodadas; no fim, volta ao quarto com o que aconteceu (game.endMinigame).
const RODADAS = 3;
const TROCAS = [3, 5, 7];
const TROCA_MS = [650, 520, 400];
const SLOT_X = [300, 480, 660];
const CAIXA_Y = 250;
const CHAO = 500;
const HIGH = 0.6;
const LOW = 0.35;
const OSSINHO = '🦴';

let p = null;
let pet = null;
let tamanho = 180;
let anim = 0;
let rodada = 0;
let fase = 'inicio'; // inicio | mostrar | embaralhar | escolher | abrir | fim
let espera = 0;
let ordem = [0, 1, 2]; // ordem[slot] = caixa
let premio = 0; // a caixa com o ossinho
let trocas = 0;
let andarPara = null;
let depois = null;
let acertos = [];
let farejou = false;
let naoEsperou = false;
let dicaDada = false;
let alegria = 0;

const caixa = (game, i) => game.entity(`cx${i}`);
const tampa = (game, i) => game.entity(`tampa${i}`);
const slotDe = (i) => ordem.indexOf(i);

function onStart(self, game) {
  p = (game.minigame && game.minigame.params) || {};
  p.jeito = p.jeito || {};
  pet = game.entity('pet');
  tamanho = Math.round((p.tamanho || 300) * 0.55);
  const s = pet.get('Sprite');
  s.asset = (p.quadros && p.quadros[0]) || s.asset;
  s.width = s.height = tamanho;
  pet.x = 480;
  self.state.escolher = (i) => escolher(game, Number(i), false);
  self.state.voltar = () => voltar(game);
  self.state.resultado = resultado;
  self.state.fase = () => fase;
  self.state.premio = () => premio;
  espera = 1;
}

function texto(game, t) {
  game.entity('dica').get('Text').text = t;
}

function emote(game, x, y, glyph, color) {
  const e = game.spawn('emote', x, y);
  e.get('Text').text = glyph;
  if (color) e.props.color = color;
}

function mostrar(game) {
  rodada++;
  fase = 'mostrar';
  premio = ordem[1];
  const pt = game.entity('petisco');
  pt.get('Text').text = OSSINHO;
  pt.x = SLOT_X[1];
  pt.y = 120;
  pt.enabled = true;
  texto(game, rodada === 1 ? `Olhe bem onde fica o ossinho de ${p.nome || 'seu pet'}...` : 'De novo! Olhe bem...');
  const t = tampa(game, premio);
  t.tween('y', CAIXA_Y - 95, 300, { onDone: () => {
    pt.tween('y', CAIXA_Y + 5, 700, { ease: 'easeIn', onDone: () => {
      pt.enabled = false;
      t.tween('y', CAIXA_Y - 55, 250, { onDone: () => {
        fase = 'embaralhar';
        trocas = TROCAS[rodada - 1];
        espera = 0.5;
      } });
    } });
  } });
}

/** Troca duas caixas de lugar (uma passa por cima, a outra por baixo). */
function trocar(game) {
  const a = Math.floor(game.random() * 3);
  const b = (a + 1 + Math.floor(game.random() * 2)) % 3;
  const ms = TROCA_MS[rodada - 1];
  const ca = ordem[a];
  const cb = ordem[b];
  ordem[a] = cb;
  ordem[b] = ca;
  for (const [i, slot, dy] of [[ca, b, -40], [cb, a, 40]]) {
    for (const e of [caixa(game, i), tampa(game, i)]) {
      e.tween('x', SLOT_X[slot], ms, { ease: 'easeInOut' });
      e.tween('y', e.y + dy, ms / 2, { yoyo: true, ease: 'easeOut' });
    }
  }
  game.playSound('sfx_clique', 0.4);
  espera = ms / 1000 + 0.08;
}

function escolher(game, i, sozinho) {
  if (fase !== 'escolher') return;
  fase = 'abrir';
  if (sozinho) naoEsperou = true;
  texto(game, sozinho ? `${p.nome || 'O pet'} não esperou e foi abrir uma sozinho!` : '');
  andarPara = { x: SLOT_X[slotDe(i)], depois: () => abrir(game, i, true) };
}

/** Abre a caixa i: com o ossinho, ele se alegra; vazia, ele fareja até a certa. */
function abrir(game, i, primeira) {
  const t = tampa(game, i);
  t.tween('y', CAIXA_Y - 100, 250);
  const certo = i === premio;
  if (!certo) {
    caixa(game, i).get('Text').text = '💨';
    acertos.push(false);
    espera = 1;
    depois = () => {
      t.tween('y', CAIXA_Y - 55, 200);
      caixa(game, i).get('Text').text = '';
      andarPara = { x: SLOT_X[slotDe(premio)], depois: () => abrir(game, premio, false) };
    };
    return;
  }
  if (primeira) {
    acertos.push(true);
    emote(game, SLOT_X[slotDe(i)], CAIXA_Y - 120, '✨', '#ffd166');
    game.playSound('sfx_guizo', 0.5);
  }
  const pt = game.entity('petisco');
  pt.x = SLOT_X[slotDe(i)];
  pt.y = CAIXA_Y;
  pt.enabled = true;
  pt.tween('y', CAIXA_Y - 70, 300, { onDone: () => achou(game) });
}

/** Achou o ossinho: fica feliz (mais ainda se foi você quem acertou) e brinca com ele um pouco. */
function achou(game) {
  const pt = game.entity('petisco');
  pt.tween('opacity', 0, 500, { onDone: () => {
    pt.enabled = false;
    pt.get('Text').opacity = 1;
  } });
  const topo = pet.y - tamanho * 0.35;
  emote(game, pet.x, topo, '♥', '#ff8fab');
  if (acertos[acertos.length - 1]) emote(game, pet.x + 20, topo - 10, '♥', '#ff8fab');
  alegria = 1.2;
  game.playSound('sfx_guizo', 0.6);
  espera = 1.6;
  depois = () => {
    for (let k = 0; k < 3; k++) tampa(game, k).tween('y', CAIXA_Y - 55, 200);
    andarPara = { x: 480, depois: () => (rodada >= RODADAS ? terminar(game) : mostrar(game)) };
  };
}

function onUpdate(self, game, dt) {
  if (!pet) return;
  anim += dt;
  // Para quem testa (inspect_game_state): a fase e onde está o ossinho (não aparecem na tela).
  game.vars.fase = fase;
  game.vars.premio = premio;
  alegria = Math.max(0, alegria - dt);
  if (espera > 0) {
    espera -= dt;
    if (espera <= 0 && depois) {
      const f = depois;
      depois = null;
      f();
    } else if (espera <= 0 && fase === 'inicio') mostrar(game);
  }
  if (fase === 'embaralhar' && espera <= 0) {
    if (trocas > 0) {
      trocas--;
      trocar(game);
    } else {
      fase = 'escolher';
      espera = 0;
      self.state.desde = 0;
      dicaDada = false;
      texto(game, 'Onde está o ossinho? Clique na caixa.');
      for (let k = 0; k < 3; k++) caixa(game, k).get('Text').text = '?';
    }
  }
  if (fase === 'escolher') {
    self.state.desde += dt;
    const certoX = SLOT_X[slotDe(premio)];
    // Curioso: fareja e chega perto da caixa certa (uma dica, se você estiver olhando para ele).
    if (!dicaDada && (p.jeito.curiosidade || 0) >= HIGH && self.state.desde > 1.2) {
      dicaDada = true;
      farejou = true;
      andarPara = { x: 480 + (certoX - 480) * 0.6, depois: null };
    }
    // Sem paciência: se você demora, ele vai sozinho.
    if ((p.jeito.paciencia === undefined ? 0.5 : p.jeito.paciencia) < LOW && self.state.desde > 5) {
      escolher(game, Math.floor(game.random() * 3), true);
    }
  }
  if (fase !== 'escolher') for (let k = 0; k < 3; k++) if (caixa(game, k).get('Text').text === '?') caixa(game, k).get('Text').text = '';
  andar(game, dt);
}

function andar(game, dt) {
  const s = pet.get('Sprite');
  if (p.quadros && p.quadros.length > 1) s.asset = p.quadros[Math.floor(anim * 2) % p.quadros.length];
  let pulo = alegria > 0 ? Math.abs(Math.sin(anim * 9)) * 16 : 0;
  let rot = 0;
  if (andarPara) {
    const dx = andarPara.x - pet.x;
    const passo = Math.sign(dx) * Math.min(Math.abs(dx), 320 * dt);
    pet.x += passo;
    if (Math.abs(dx) > 2) s.flipX = dx < 0;
    pulo = Math.max(pulo, Math.abs(Math.sin(anim * 11)) * 7);
    if (Math.abs(andarPara.x - pet.x) < 1) {
      const f = andarPara.depois;
      andarPara = null;
      if (f) f();
    }
  } else if (fase === 'escolher' && farejou) rot = Math.sin(anim * 6) * 6; // farejando
  pet.y = CHAO - (p.pe || 0.3) * tamanho - pulo;
  pet.rotation = rot;
}

/** O que aconteceu, para o quarto (e para o resumo). */
function resultado() {
  const n = acertos.filter(Boolean).length;
  const moedas = Math.min(n * 2, p.moedas === undefined ? 6 : p.moedas);
  return { jogo: 'caixinhas', pontos: n, animo: 0.25 + (n / RODADAS) * 0.75, moedas, farejou, naoEsperou };
}

function terminar(game) {
  fase = 'fim';
  const r = resultado();
  const linhas = [acertos.map((a) => (a ? '✅' : '❌')).join(' ')];
  linhas.push(r.pontos === RODADAS ? 'Você achou o ossinho todas as vezes!' : r.pontos === 0 ? `${p.nome || 'O pet'} achou o ossinho pelo faro.` : 'Acharam o ossinho juntos.');
  if (farejou) linhas.push(`${p.nome || 'O pet'} farejou por perto antes de você escolher.`);
  if (r.moedas > 0) linhas.push(`+${r.moedas} 🪙`);
  else if (p.moedas === 0 && r.pontos > 0) linhas.push('Hoje já ganhou bastante moeda brincando.');
  texto(game, '');
  game.entity('resumo').get('Text').text = linhas.join('\n');
  for (const id of ['painel', 'resumo', 'botaoVoltarJogo']) game.entity(id).enabled = true;
  game.playSound('sfx_evolucao', 0.5);
}

function voltar(game) {
  if (fase !== 'fim') return;
  game.endMinigame(resultado());
}
