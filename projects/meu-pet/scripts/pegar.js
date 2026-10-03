// Pega-pega (minigame, cena "pegar"): coisas caem e você guia o pet com o mouse para pegar. Ele reage a cada
// comida pelo gosto dele (♥ gosta, 💢 não gosta) — dá para ver o que ele acha sem precisar dar de comer. Pets
// ativos correm mais rápido. No fim, volta ao quarto com o que aconteceu (game.endMinigame).
const DURACAO = 30; // segundos
const CHAO = 470;
const MIN_X = 90;
const MAX_X = 870;
const PONTOS = { love: 3, like: 2, neutral: 1, dislike: 0, hate: 0 };
const ESTRELA = { id: null, icon: '⭐', nivel: 'estrela' };

let p = null;
let pet = null;
let tamanho = 180;
let t = 0;
let proxima = 1.5;
let quedas = [];
let pontos = 0;
let pegou = [];
let reacoes = {};
let fim = false;
let susto = 0;
let alegria = 0;
let anim = 0;

const lerp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));

function onStart(self, game) {
  p = (game.minigame && game.minigame.params) || {};
  p.jeito = p.jeito || {};
  pet = game.entity('pet');
  // A forma dele, um pouco menor que no quarto (o céu precisa de espaço).
  tamanho = Math.round((p.tamanho || 300) * 0.62);
  const s = pet.get('Sprite');
  s.asset = (p.quadros && p.quadros[0]) || s.asset;
  s.width = s.height = tamanho;
  pet.x = 480;
  pet.y = CHAO - (p.pe || 0.3) * tamanho;
  const dica = game.entity('dica');
  dica.get('Text').text = `Mova o mouse para guiar ${p.nome || 'o pet'}. Pegue o que cai!`;
  self.after(4500, () => dica.tween('opacity', 0, 800));
  self.state.voltar = () => voltar(game);
  self.state.resultado = resultado;
}

function cair(game) {
  const comidas = (p.comidas || []).filter((c) => c.icon);
  const c = !comidas.length || game.random() < 0.25 ? ESTRELA : comidas[Math.floor(game.random() * comidas.length)];
  const e = game.spawn('queda', lerp(MIN_X, MAX_X, game.random()), -30);
  e.get('Text').text = c.icon;
  quedas.push({ e, c, gira: (game.random() - 0.5) * 120 });
}

function emote(game, x, y, glyph, color) {
  const e = game.spawn('emote', x, y);
  e.get('Text').text = glyph;
  if (color) e.props.color = color;
}

/** Pegou: pontos e a reação dele pelo gosto daquela comida. */
function pegar(game, q) {
  const { c, e } = q;
  e.destroy();
  pegou.push(c.icon);
  game.entity('cesta').get('Text').text = pegou.slice(-16).join(' ');
  const topo = pet.y - tamanho * 0.35;
  if (c.nivel === 'estrela') {
    pontos += 2;
    emote(game, pet.x, topo, '✨', '#ffd166');
    game.playSound('sfx_guizo', 0.5);
    return;
  }
  reacoes[c.id] = c.nivel;
  pontos += PONTOS[c.nivel] || 0;
  if (c.nivel === 'love' || c.nivel === 'like') {
    emote(game, pet.x, topo, '♥', '#ff8fab');
    if (c.nivel === 'love') emote(game, pet.x + 20, topo - 10, '♥', '#ff8fab');
    alegria = c.nivel === 'love' ? 0.9 : 0.5;
    game.playSound('sfx_comer', 0.6);
  } else if (c.nivel === 'neutral') {
    game.playSound('sfx_comer', 0.4);
  } else {
    // Não gosta: careta e para um instante (detesta: para mais).
    emote(game, pet.x, topo, '💢', '#e5534b');
    susto = c.nivel === 'hate' ? 1.1 : 0.6;
  }
}

function onUpdate(self, game, dt) {
  if (!pet) return;
  anim += dt;
  game.vars.pontos = pontos; // para quem testa (não aparece na tela)
  game.vars.fim = fim;
  susto = Math.max(0, susto - dt);
  alegria = Math.max(0, alegria - dt);
  if (!fim) {
    t += dt;
    const k = t / DURACAO;
    const barra = game.entity('tempo');
    const s = barra.get('Sprite');
    s.width = Math.max(0, 400 * (1 - k));
    barra.x = 280 + s.width / 2;
    if (t < DURACAO) {
      proxima -= dt;
      if (proxima <= 0) {
        cair(game);
        proxima = lerp(1.15, 0.7, k);
      }
    } else if (!quedas.length) terminar(game);
  }

  // As coisas caem; perto da boca dele, ele pega.
  const v = lerp(130, 230, t / DURACAO);
  const boca = pet.y - tamanho * 0.3;
  for (const q of [...quedas]) {
    q.e.y += v * dt;
    q.e.rotation += q.gira * dt;
    if (q.e.y >= boca && q.e.y <= pet.y + tamanho * 0.1 && Math.abs(q.e.x - pet.x) < tamanho * 0.32) {
      quedas.splice(quedas.indexOf(q), 1);
      pegar(game, q);
    } else if (q.e.y > CHAO + 10) {
      quedas.splice(quedas.indexOf(q), 1);
      q.e.tween('opacity', 0, 300, { onDone: () => q.e.destroy() });
    }
  }

  // O pet segue o mouse: ativos correm mais; depois de algo que não gosta, para um instante.
  const alvo = fim ? pet.x : Math.max(MIN_X, Math.min(MAX_X, game.input.mouseWorld.x));
  const rapidez = lerp(250, 430, p.jeito.atividade === undefined ? 0.5 : p.jeito.atividade) * (susto > 0 ? 0.25 : 1);
  const dx = alvo - pet.x;
  const passo = Math.sign(dx) * Math.min(Math.abs(dx), rapidez * dt);
  pet.x += passo;
  const s = pet.get('Sprite');
  if (Math.abs(dx) > 4) s.flipX = dx < 0;
  if (p.quadros && p.quadros.length > 1) s.asset = p.quadros[Math.floor(anim * 2) % p.quadros.length];
  const andando = Math.abs(passo) > 0.5;
  const pulo = alegria > 0 ? Math.abs(Math.sin(anim * 9)) * 18 : andando ? Math.abs(Math.sin(anim * 11)) * 7 : 0;
  pet.y = CHAO - (p.pe || 0.3) * tamanho - pulo;
  pet.rotation = susto > 0 ? -5 : 0;
}

/** O que aconteceu, para o quarto (e para o resumo). */
function resultado() {
  const moedas = Math.min(Math.floor(pontos / 5), 6, p.moedas === undefined ? 6 : p.moedas);
  return { jogo: 'pegar', pontos, animo: Math.min(1, pontos / 30), moedas, reacoes: { ...reacoes }, pegou: pegou.length };
}

function unicos(nivel) {
  return [...new Set((p.comidas || []).filter((c) => reacoes[c.id] && nivel.includes(reacoes[c.id])).map((c) => c.icon))];
}

function terminar(game) {
  fim = true;
  const r = resultado();
  const n = pegou.length;
  const quanto = n === 0 ? 'não pegou nada desta vez' : n < 6 ? 'pegou algumas coisas' : n < 14 ? 'pegou bastante coisa' : 'pegou um montão de coisas!';
  const linhas = [`${p.nome || 'O pet'} ${quanto}${quanto.endsWith('!') ? '' : '.'}`];
  const feliz = unicos(['love', 'like']);
  const careta = unicos(['dislike', 'hate']);
  if (feliz.length) linhas.push(`Ficou feliz com: ${feliz.join(' ')}`);
  if (careta.length) linhas.push(`Fez careta para: ${careta.join(' ')}`);
  if (r.moedas > 0) linhas.push(`+${r.moedas} 🪙`);
  else if (p.moedas === 0 && pontos >= 5) linhas.push('Hoje já ganhou bastante moeda brincando.');
  game.entity('resumo').get('Text').text = linhas.join('\n');
  for (const id of ['painel', 'resumo', 'botaoVoltarJogo']) game.entity(id).enabled = true;
  game.playSound('sfx_evolucao', 0.5);
}

function voltar(game) {
  if (!fim) return;
  game.endMinigame(resultado());
}
