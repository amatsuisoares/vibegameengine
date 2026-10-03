// Cérebro do pet. Guarda o estado em game.storage ("pet"), simula as necessidades pelo
// relógio do jogo, escolhe o que o pet faz, fala do estado dele SÓ por observações (game.notify)
// ("Mimi parece estar com fome.") e expõe uma API (self.state.api) para os outros scripts.
//
// Quem o pet É fica nos componentes da entidade (scenes/quarto.json), não aqui:
//   Traits       8 eixos de personalidade 0..1, sorteados ao nascer (self.traits.get('atividade'))
//   Preferences  gostos por assunto: itens (maçã, bola...), tags (fruta, doce...) e contextos (carinho, escuro)
//   Routine      hábitos por hora do dia, aprendidos do que ele faz (self.routine.record)
//   Memory       o que ele viveu (susto, comida adorada, brincar com você), enfraquecendo com o tempo
//   Persist      tudo isso fica em storage.petIndividuo e volta em toda sessão
// Aqui só se decide o que cada traço e cada gosto MUDA no comportamento.

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MIN_X = 110;
const MAX_X = 850;
const SAVE_EVERY = 3; // segundos reais
const BIG_JUMP = 5 * 60000; // pulos de relógio maiores que isso viram "tempo fora"
const MAX_AWAY = 7 * DAY;

const JUVENIL_AT = 12; // horas de vida
const ADULTO_AT = 36;

// Como o diário descreve um traço que já se mostrou várias vezes ("eixo:alto" / "eixo:baixo").
const JEITO = {
  'atividade:alto': 'bastante ativo',
  'atividade:baixo': 'bem tranquilo',
  'sociabilidade:alto': 'sociável',
  'sociabilidade:baixo': 'reservado',
  'curiosidade:alto': 'curioso',
  'curiosidade:baixo': 'pouco curioso',
  'independencia:alto': 'independente',
  'independencia:baixo': 'grudento',
  'sensibilidade:alto': 'sensível',
  'sensibilidade:baixo': 'tranquilo com o que acontece em volta',
  'apetite:alto': 'guloso',
  'apetite:baixo': 'de pouco apetite',
  'paciencia:alto': 'paciente',
  'paciencia:baixo': 'impaciente',
  'brincadeira:alto': 'brincalhão',
  'brincadeira:baixo': 'pouco brincalhão',
};
const HIGH = 0.65;
const LOW = 0.35;

// Save v1 (traços sim/não) → eixos. Os eixos não citados são sorteados.
const V1_TRAITS = {
  brincalhao: { brincadeira: 0.85, atividade: 0.7 },
  preguicoso: { atividade: 0.15 },
  carinhoso: { sociabilidade: 0.85, independencia: 0.2 },
  curioso: { curiosidade: 0.85 },
  irritavel: { paciencia: 0.15, sensibilidade: 0.7 },
};
const V1_REVEALED = {
  brincalhao: 'brincadeira:alto',
  preguicoso: 'atividade:baixo',
  carinhoso: 'sociabilidade:alto',
  curioso: 'curiosidade:alto',
  irritavel: 'paciencia:baixo',
};

// foot: onde ficam os pés no desenho (fração da imagem abaixo do centro), para apoiar no chão.
const STAGES = {
  bebe: { frames: ['bebe_1', 'bebe_2'], size: 300, foot: 0.17, label: 'Bebê' },
  juvenil1: { frames: ['juvenil1_1', 'juvenil1_2'], size: 270, foot: 0.32, label: 'Jovem' },
  juvenil2: { frames: ['juvenil2_1', 'juvenil2_2'], size: 270, foot: 0.32, label: 'Jovem' },
  adulto1a: { frames: ['adulto1a'], size: 320, foot: 0.4, label: 'Adulto' },
  adulto2a: { frames: ['adulto2a'], size: 320, foot: 0.4, label: 'Adulto' },
  adulto3a: { frames: ['adulto3a'], size: 320, foot: 0.35, label: 'Adulto' },
  adulto1b: { frames: ['adulto1b'], size: 320, foot: 0.4, label: 'Adulto' },
  adulto2b: { frames: ['adulto2b'], size: 320, foot: 0.26, label: 'Adulto' },
  adulto3b: { frames: ['adulto3b'], size: 320, foot: 0.35, label: 'Adulto' },
};
const FEET_Y = 470;
const floorY = () => FEET_Y - STAGES[pet.stage].foot * STAGES[pet.stage].size;

const NEEDS = ['fome', 'energia', 'diversao', 'higiene', 'saude', 'afeto'];

let pet; // dados salvos
let me; // a entidade (traços e gostos: me.traits, me.prefs)
let mind; // comportamento do momento (não salvo)
let lastSleepHour = -1;
let refeicao = null; // comida oferecida sendo cheirada/comida: {item, level, food, dir}
let lastNow = 0;
let localOffset = 0;
let anim = 0;
let lastPetReal = -99;
let gameRef = null; // o game (para reveal, chamado de muitos lugares)
let pedindoBola = -99; // tempo real em que foi até a bola pedir para brincar
let lastLookBowl = -99;
let realTime = 0;

// ---------------------------------------------------------------- utilidades

const clamp = (v) => Math.max(0, Math.min(100, v));
/** Traço 0..1 (0,5 = médio). */
const T = (axis) => me.traits.get(axis);
/** De `a` (traço 0) a `b` (traço 1). */
const lerp = (a, b, k) => a + (b - a) * k;
/** O que o pet acha de algo: {score -1..1, level love|like|neutral|dislike|hate}. */
const feel = (subject, tags) => me.prefs.evaluate(subject, tags || []);
const hourAt = (t) => ((((t + localOffset) % DAY) + DAY) % DAY) / HOUR;
const isNightAt = (t) => {
  const h = hourAt(t);
  return h >= 22 || h < 7;
};
const ageHours = (now) => (now - pet.born) / HOUR;
const pick = (game, list) => list[Math.floor(game.random() * list.length)];

// ---------------------------------------------------------------- criação e save

function newPet(game, name) {
  // Um indivíduo novo: traços e gostos sorteados de novo (componentes Traits/Preferences).
  me.persist.reset();
  return {
    version: 2,
    name,
    born: game.clock.now,
    stage: 'bebe',
    needs: { fome: 70, energia: 80, diversao: 70, higiene: 90, saude: 100, afeto: 60 },
    sick: false,
    asleep: false,
    lightOn: true,
    bowl: 0,
    dirt: 0,
    care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
    wellbeing: 70,
    treats: { day: -1, n: 0 },
    revealed: {},
    cooldowns: {},
    lastSeen: game.clock.now,
  };
}

/**
 * Save v1 → v2: os traços sim/não viram eixos (os outros são sorteados, e os gostos seguem os
 * eixos); os sinais já vistos continuam valendo. Necessidades, idade, forma e notas não mudam.
 */
function migrateV1(saved) {
  const traits = {};
  for (const t of saved.traits || []) Object.assign(traits, V1_TRAITS[t] || {});
  me.persist.reset({ traits });
  const revealed = {};
  for (const [t, n] of Object.entries(saved.revealed || {})) if (V1_REVEALED[t]) revealed[V1_REVEALED[t]] = n;
  const { traits: _old, ...rest } = saved;
  return { ...rest, version: 2, revealed };
}

function save(game) {
  pet.lastSeen = game.clock.now;
  game.storage.set('pet', pet);
}

// ---------------------------------------------------------------- coleção ("pokédex")

/** Formas já vistas e pets anteriores, guardados à parte do pet atual. */
function collection(game) {
  const c = game.storage.get('colecao');
  return c && c.formas && c.pets ? c : { formas: {}, pets: [] };
}

function discover(game, stage) {
  const c = collection(game);
  if (c.formas[stage]) return;
  c.formas[stage] = { nome: pet.name, em: game.clock.now };
  game.storage.set('colecao', c);
}

const isAdult = () => pet.stage.startsWith('adulto');

/** Os jeitos que você já percebeu (Knowledge "jeito:eixo:alto|baixo", a partir de "observado"), para a coleção. */
function seenTraits() {
  return me.knowledge
    .list({ prefix: 'jeito:', minLevel: 'observed' })
    .map((k) => JEITO[k.key.slice(6)])
    .filter(Boolean);
}

// ---------------------------------------------------------------- o que você sabe dele (Knowledge) e a história dele (Journal)

/**
 * Você teve a chance de ver algo sobre o pet (um jeito, um gosto): mais evidência na chave. O diário só
 * fala do que tem evidência, com a confiança dela: possível ("talvez"), observado ("parece"), confirmado.
 */
function saber(game, key, weight = 1) {
  const r = me.knowledge.observe(key, weight);
  if (!r.discovered) return r;
  // Ficou claro (confirmado): vira uma página da história dele.
  if (r.level === 'confirmed' && key.startsWith('jeito:') && JEITO[key.slice(6)]) anotar(game, 'jeito', `Ficou claro que é ${JEITO[key.slice(6)]}.`, key, 0.6);
  if (r.level === 'observed' && key.startsWith('favorito:')) {
    const item = game.items.get(key.slice(9));
    if (item) anotar(game, 'brinquedo', `Escolheu ${oItem(item)} como brinquedo preferido.`, key, 0.8);
  }
  return r;
}

/** Uma página do diário (Journal): com chave, só a primeira vez ("provou a maçã pela primeira vez"). */
function anotar(game, category, text, key, importance = 0.5) {
  return me.journal.add(category, text.replace('{n}', pet.name), { key, importance });
}

/** A reação a algo de que ele tem gosto (comida, brinquedo, carinho) conta como evidência desse gosto. */
const NIVEL_PESO = { love: 2, hate: 2, like: 1.5, dislike: 1.5, neutral: 1 };
function gostoVisto(game, subject, level, extra = 1) {
  // Você já tinha visto outro gosto com segurança e agora vê este: o gosto mudou (mesmo que a mudança tenha
  // vindo aos poucos, ou de antes desta versão). O diário acompanha e você fica sabendo.
  const top = me.knowledge.list({ prefix: `gosto:${subject}:` })[0];
  const antes = top && top.key.slice(`gosto:${subject}:`.length);
  if (antes && antes !== level && VERBO[antes] && top.level !== 'possible') return mudouGosto(game, { subject, from: antes, to: level });
  saber(game, `gosto:${subject}:${level}`, (NIVEL_PESO[level] || 1) * extra);
}

// ---------------------------------------------------------------- observações

/**
 * Uma observação para o jogador ("{n} parece..."): passa pelo Notifier da engine (game.notify), que
 * segura repetições (cooldown em minutos de jogo e 25 s reais, para não virar spam a 600×), guarda o
 * histórico e evita empilhar: prioridade 0 (o que se vê do pet sozinho) não atropela uma reação a você.
 */
function observe(game, kind, text, cooldownMin = 0, priority = 1) {
  return game.notify(kind, text.replace('{n}', pet.name), {
    cooldownMs: cooldownMin * 60000,
    realCooldownMs: cooldownMin > 0 ? 25000 : 0,
    priority,
    entity: me.id,
  });
}

/**
 * Sinal de personalidade: um comportamento típico de um traço forte ("alto" ou "baixo"). Só conta se o
 * pet realmente é assim; vira evidência (Knowledge "jeito:eixo:dir") e o diário passa de "talvez" a "é".
 */
function reveal(axis, dir, weight = 0.5) {
  const v = T(axis);
  if (dir === 'alto' ? v < HIGH : v > LOW) return;
  saber(gameRef, `jeito:${axis}:${dir}`, weight);
}

function emote(game, self, glyph, color) {
  const e = game.spawn('emote', self.x + (game.random() - 0.5) * 40, self.y - pet_size() * 0.32);
  const t = e.get('Text');
  t.text = glyph;
  if (color) e.props.color = color;
}

/**
 * Sinais do que ele sente, sem palavras (como os ♥): 💢 não gostou, ❗ se assustou, ❗ âmbar desconfiado.
 * Ajudam a perceber do que ele NÃO gosta tão bem quanto do que gosta.
 */
const naoGostou = (game, self) => emote(game, self, '💢', '#e5534b');
const levouSusto = (game, self) => emote(game, self, '❗', '#e5534b');
const desconfiou = (game, self) => emote(game, self, '❗', '#f2b84b');

function pet_size() {
  return STAGES[pet.stage].size;
}

// ---------------------------------------------------------------- necessidades

/** Aplica `h` horas de vida às necessidades (linear; chamado em pedaços pequenos). */
function decay(game, h, at) {
  const n = pet.needs;
  const asleep = pet.asleep;
  n.fome -= h * (asleep ? 4 : 8) * lerp(0.75, 1.3, T('apetite'));
  if (asleep || pet.cochilando) n.energia += h * sleepRate(game, at);
  else n.energia -= h * 6 * lerp(0.8, 1.3, T('atividade')) * (pet.sick ? 1.5 : 1);
  const agitado = (T('atividade') + T('brincadeira')) / 2;
  n.diversao -= h * (asleep ? 1 : 7 * lerp(0.6, 1.5, agitado) * lerp(0.9, 1.2, T('curiosidade')));
  n.afeto -= h * (asleep ? 1 : 5 * lerp(0.4, 1.6, T('sociabilidade')) * lerp(1.25, 0.65, T('independencia')));
  if (!asleep) n.afeto += h * afetoDoQuarto(game); // o quarto do jeito dele (luz e cortina) faz bem aos poucos
  n.higiene -= h * 3;
  const lowest = Math.min(n.fome, n.higiene, n.energia);
  if (pet.sick) n.saude -= h * 4;
  else if (lowest < 15) n.saude -= h * 3;
  else if (Math.min(n.fome, n.energia, n.diversao, n.higiene, n.afeto) > 40) n.saude += h * 2;
  for (const k of NEEDS) n[k] = clamp(n[k]);

  // Doença: chance por hora quando mal cuidado.
  if (!pet.sick && (n.higiene < 25 || n.fome < 10 || n.saude < 30)) {
    const p = 1 - Math.pow(1 - 0.15, h);
    if (game.random() < p) {
      pet.sick = true;
      anotar(game, 'saude', 'Ficou doente pela primeira vez.', 'doente', 0.6);
    }
  }

  // Média de bem-estar (decide a evolução): meia-vida de ~6 h.
  const now = (n.fome + n.energia + n.diversao + n.higiene + n.saude + n.afeto) / 6;
  const a = 1 - Math.pow(0.5, h / 6);
  pet.wellbeing += (now - pet.wellbeing) * a;
}

// ---------------------------------------------------------------- ambiente e sono (componente Ambient da engine)
//
// A lâmpada e a janela põem luz no quarto, a cama e a cestinha conforto, a caixinha de música música e um
// pouco de ruído (cada uma com seu alcance). game.env(lugar) soma o que chega ali, e o pet sente isso pelo
// jeito e pelos gostos dele: onde dorme, como dorme, onde cochila, se dança ou se afasta.

/** Quanto um lugar de dormir (tag "lugarDeDormir": a cama, a cestinha...) agrada este pet. */
function notaDoLugar(game, e) {
  const env = game.env(e);
  const item = e.props.item && game.items.get(String(e.props.item));
  const gosto = item ? me.prefs.item(item.id).score : 0;
  return (env.comfort || 0) + gosto * 0.4 - (env.noise || 0) * T('sensibilidade');
}

function lugarDeDormir(game) {
  let best = null;
  for (const e of game.find('lugarDeDormir')) {
    const n = notaDoLugar(game, e);
    if (!best || n > best.n) best = { e, n };
  }
  return best ? best.e : game.entity('cama');
}

/** Onde o corpo fica ao deitar num lugar: numa cestinha um pouco ao lado (para ela aparecer atrás dele). */
const xDeitado = (e) => e.x + (e.props.item ? 45 : 0);

const xDeDormir = (game) => {
  const e = lugarDeDormir(game);
  return e ? xDeitado(e) : 480;
};

/** Luz no quarto numa hora: a lâmpada (se acesa) e a janela (de dia). Calculada, para valer também no tempo fora. */
/** Luz no quarto numa hora: a lâmpada (se acesa) e a janela (de dia, se a cortina está aberta). */
const luzEm = (game, at) => (pet.lightOn ? 1 : 0) + (isNightAt(at) || cortinaFechada(game) ? 0 : 0.8);

/** A lâmpada da cena emite luz (Ambient) só quando está acesa. */
function luzDaLampada(game) {
  const lamp = game.entity('lampada');
  if (lamp && lamp.get('Ambient')) lamp.get('Ambient').enabled = pet.lightOn;
}

const likesTag = (tag) => me.prefs.of(tag);

/**
 * Qualidade do sono (0..1) onde ele está: conforto ajuda; a luz atrapalha quem gosta de escuro (e quem é
 * sensível) e agrada um pouco quem gosta de claridade; ruído atrapalha os sensíveis; música embala quem gosta.
 * Também diz o que mais atrapalhou, para a observação ("dormindo mal: parece incomodado com a luz").
 */
function sono(game, at) {
  const env = game.env(me);
  const escuro = me.prefs.of('escuro');
  const sens = T('sensibilidade');
  const luz = luzEm(game, at);
  const pesoLuz = luz * (0.12 + Math.max(0, escuro) * 0.45 + Math.max(0, sens - 0.5) * 0.4) - luz * Math.max(0, -escuro) * 0.12;
  const pesoRuido = (env.noise || 0) * (0.2 + sens * 0.7);
  const musica = (env.music || 0) * likesTag('musica') * 0.25;
  const q = 0.45 + (env.comfort || 0) * 0.45 - pesoLuz - pesoRuido + musica;
  const causa = pesoLuz >= pesoRuido && pesoLuz > 0.15 ? 'a luz' : pesoRuido > 0.15 ? 'o barulho' : null;
  return { q: Math.max(0, Math.min(1, q)), causa };
}

/** Energia recuperada por hora de sono: dorme melhor, recupera mais. Pets ativos recuperam mais rápido. */
function sleepRate(game, at) {
  return 22 * lerp(0.55, 1.35, sono(game, at).q) * lerp(0.85, 1.25, T('atividade'));
}

/** Luz acesa à noite só incomoda quem gosta de escuro (ou é muito sensível). */
function lightBothers() {
  return me.prefs.of('escuro') > 0.2 || T('sensibilidade') > 0.8;
}

/** Onde ele está dormindo, para as frases (" na cestinha", " na cama"). */
function ondeDorme(game) {
  let best = null;
  for (const e of game.find('lugarDeDormir')) {
    const d = Math.abs(e.x - me.x);
    if (d < 90 && (!best || d < best.d)) best = { e, d };
  }
  const item = best && best.e.props.item && game.items.get(String(best.e.props.item));
  if (item) return { id: item.id, frase: ` ${noItem(item)}` };
  return best ? { id: best.e.id, frase: ' na cama' } : { id: null, frase: '' };
}

/** Adormeceu (de noite ou num cochilo): a primeira vez em cada lugar novo entra na história. */
function adormeceu(game) {
  const onde = ondeDorme(game);
  if (onde.id && onde.id !== 'cama') anotar(game, 'lembranca', `Dormiu pela primeira vez${onde.frase}.`, `dormiu:${onde.id}`, 0.5);
}

/** Como ele dorme dá para ver: tranquilo (z devagar) ou se revirando (~). De vez em quando, uma observação. */
function sonoVisivel(game) {
  const s = sono(game, game.clock.now);
  mind.q = s.q;
  if (s.q < 0.4 && s.causa) {
    if (observe(game, 'dormeMal', `{n} está dormindo mal: parece incomodado com ${s.causa}.`, 60, 0)) {
      if (s.causa === 'a luz') gostoVisto(game, 'escuro', feel('escuro').level);
      reveal('sensibilidade', 'alto');
    }
  } else if (s.q >= 0.7) {
    if (pet.lightOn) reveal('sensibilidade', 'baixo'); // dorme bem mesmo com a luz acesa
    const onde = ondeDorme(game);
    if (observe(game, 'dormeBem', `{n} está dormindo tranquilo${onde.frase}.`, 120, 0) && onde.id && onde.id !== 'cama') {
      gostoVisto(game, onde.id, me.prefs.item(onde.id).level, 0.5);
    }
  }
}

/**
 * Uma coisa nova no quarto (cestinha, caixinha): o pet vai conferir. Um lugar de dormir que ele gosta, ele
 * experimenta na hora (se deita um pouco); do que não gosta, cheira e se afasta.
 */
function verCoisa(game, self, id) {
  const e = game.entity(id);
  const item = e && game.items.get(String(e.props.item));
  if (!item || pet.asleep || refeicao) return;
  if (T('curiosidade') < LOW) {
    // Pouco curioso: olha de longe e continua o que fazia.
    observe(game, `coisa:${item.id}`, `{n} olhou ${oItem(item)} de longe e continuou o que estava fazendo.`, 10);
    reveal('curiosidade', 'baixo', 1);
    return;
  }
  const r = me.prefs.item(item.id);
  const lado = self.x < e.x ? -1 : 1;
  go(game, e.x + lado * 30, () => {
    mind = {
      act: 'investigate',
      t: 1.4,
      then: () => {
        gostoVisto(game, item.id, r.level);
        if (r.score <= -0.2) {
          naoGostou(game, self);
          observe(game, `coisa:${item.id}`, `{n} cheirou ${oItem(item)} e se afastou.`, 10);
          go(game, e.x + lado * 200, 'idle');
        } else if (e.hasTag('lugarDeDormir') && r.score >= 0.2) {
          emote(game, self, '♥', '#ff8fab');
          observe(game, `coisa:${item.id}`, `{n} deitou ${noItem(item)} para experimentar. Parece ter gostado!`, 10);
          self.x = xDeitado(e);
          mind = { act: 'nap', t: 4 };
        } else {
          observe(game, `coisa:${item.id}`, `{n} foi conferir ${oItem(item)}.`, 10);
          decide(game, self);
        }
      },
    };
  });
}

/**
 * O jeito dele com a claridade (do gosto por escuro e da sensibilidade):
 *   escuro       quer a cortina fechada e a luz apagada
 *   luz          quer a cortina aberta e a luz acesa
 *   normal       quer o quarto claro acordado e escuro para dormir (a cortina tanto faz)
 *   indiferente  pouco sensível: tanto faz
 */
function jeitoComLuz() {
  const escuro = feel('escuro').score;
  const sens = T('sensibilidade');
  if (escuro >= 0.2 || (sens > 0.8 && escuro > -0.2)) return 'escuro';
  if (escuro <= -0.2) return 'luz';
  return sens < 0.35 ? 'indiferente' : 'normal';
}

const cortinaFechada = (game) => !!(game.storage.get('quarto') || {}).cortina;

/** Quanto o quarto está do jeito que ele gosta: 0 (nada), 1 (meio), 2 (tudo). Indiferente: sempre 1. */
function satisfacaoLuz(game, jeito, luzAcesa, fechada) {
  const claro = luzAcesa || (!fechada && !isNightAt(game.clock.now));
  if (jeito === 'escuro') return (fechada ? 1 : 0) + (luzAcesa ? 0 : 1);
  if (jeito === 'luz') return (fechada ? 0 : 1) + (luzAcesa ? 1 : 0);
  if (jeito === 'normal') return pet.asleep ? (claro ? 0 : 2) : claro ? 2 : 0;
  return 1;
}

const FRASES_LUZ = {
  escuro: {
    cortina: ['{n} parece gostar da cortina fechada.', '{n} apertou os olhos com a claridade. Parece preferir a cortina fechada.'],
    luz: ['{n} parece gostar do quarto mais escuro.', '{n} apertou os olhos com a luz. Parece preferir o escuro.'],
  },
  luz: {
    cortina: ['{n} parece gostar da cortina aberta.', '{n} não parece gostar do quarto mais escuro.'],
    luz: ['{n} parece mais à vontade com a luz acesa.', '{n} não parece gostar do escuro.'],
  },
  normal: {
    cortina: ['{n} parece mais à vontade com o quarto claro.', '{n} não parece gostar do quarto escuro agora.'],
    luz: ['{n} parece mais à vontade com o quarto claro.', '{n} não parece gostar do quarto escuro agora.'],
  },
};

/**
 * Você mexeu na luz ou na cortina (o que = 'luz' | 'cortina'): ele reage na hora se ficou melhor (♥) ou pior (💢;
 * ❗ para quem tem medo do escuro) para o jeito dele. Indiferente ou nada mudou para ele: não reage. Dormindo, só se
 * mexe (a qualidade do sono muda). Cada reação vira evidência do jeito dele com a claridade (diário).
 */
function reagirAoAmbiente(game, self, o) {
  if (refeicao) return;
  const jeito = jeitoComLuz();
  const fechada = cortinaFechada(game);
  const antes = satisfacaoLuz(game, jeito, o === 'luz' ? !pet.lightOn : pet.lightOn, o === 'cortina' ? !fechada : fechada);
  const depois = satisfacaoLuz(game, jeito, pet.lightOn, fechada);
  if (jeito === 'indiferente') return saber(game, 'gosto:escuro:neutral', 0.5);
  if (depois === antes) return;
  if (jeito === 'normal') saber(game, 'gosto:luzNormal:like', 0.5);
  else gostoVisto(game, 'escuro', jeito === 'escuro' ? feel('escuro').level === 'love' ? 'love' : 'like' : feel('escuro').level === 'hate' ? 'hate' : 'dislike', 0.5);
  const melhorou = depois > antes;
  if (pet.asleep) {
    if (melhorou) emote(game, self, 'z', '#c9d6ff');
    else {
      naoGostou(game, self);
      observe(game, 'luzDormindo', jeito === 'luz' ? '{n} se mexeu inquieto no escuro.' : '{n} se mexeu incomodado com a claridade.', 10);
    }
    return;
  }
  const [bom, ruim] = FRASES_LUZ[jeito][o];
  if (melhorou) {
    emote(game, self, '♥', jeito === 'escuro' ? '#9fb4ff' : '#ffd166');
    observe(game, `${o}Melhor`, bom, 10);
  } else {
    if (jeito === 'luz') desconfiou(game, self);
    else naoGostou(game, self);
    observe(game, `${o}Pior`, ruim, 10);
    if (jeito === 'escuro') reveal('sensibilidade', 'alto');
  }
}

/**
 * Um quarto do jeito dele faz bem aos poucos: afeto sobe devagar e, de vez em quando, ele mostra ♪ ("parece à
 * vontade com o quarto assim."); do jeito errado, o afeto cai e de vez em quando aparece um 💢. Chamado a cada segundo.
 */
let sinalDoQuarto = 0; // tempo real do próximo sinal (sem sortear: não mexe na sorte das outras decisões)

function bemNoQuarto(game, self) {
  const jeito = jeitoComLuz();
  if (jeito === 'indiferente' || pet.asleep || refeicao || realTime < sinalDoQuarto) return;
  const s = satisfacaoLuz(game, jeito, pet.lightOn, cortinaFechada(game));
  if (s === 1) return;
  sinalDoQuarto = realTime + (s === 2 ? 90 : 60);
  if (s === 2) {
    emote(game, self, '♪', '#ffd166');
    observe(game, 'quartoBom', '{n} parece à vontade com o quarto assim.', 30, 0);
  } else {
    if (jeito === 'luz') desconfiou(game, self);
    else naoGostou(game, self);
    const msg = { escuro: '{n} parece incomodado com a claridade.', luz: '{n} parece incomodado com o quarto escuro.', normal: '{n} não parece gostar do quarto escuro agora.' }[jeito];
    observe(game, 'quartoRuim', msg, 30, 0);
  }
}

/** O afeto anda devagar com o quarto do jeito dele (por hora de jogo; também no tempo fora). */
function afetoDoQuarto(game) {
  const jeito = jeitoComLuz();
  if (jeito === 'indiferente') return 0;
  const s = satisfacaoLuz(game, jeito, pet.lightOn, cortinaFechada(game));
  return s === 2 ? 1.5 : s === 0 ? -1.5 : 0;
}

/** Você ligou a música: quem gosta se anima (e vai dançar); quem não gosta (ou é muito sensível) se afasta. */
function ouviuMusica(game, self, on, id) {
  if (!on || pet.asleep || refeicao) return;
  const box = game.entity(id);
  const item = box && game.items.get(String(box.props.item));
  if (!item) return;
  const r = me.prefs.item(item.id);
  gostoVisto(game, 'musica', r.level);
  if (r.score <= -0.2 || (T('sensibilidade') > 0.8 && r.score < 0.2)) {
    naoGostou(game, self);
    observe(game, 'musicaNao', '{n} não parece gostar da música.', 5);
    lembrar('musica', 'caixinhaMusica', -0.8, 0.5);
    go(game, box.x < 480 ? 820 : 140, 'idle');
  } else if (r.score >= 0.2) {
    emote(game, self, '♪', '#8e7dff');
    observe(game, 'musicaSim', r.level === 'love' ? '{n} se animou todo com a música!' : '{n} parece gostar da música.', 5);
    dancar(game, self, box);
  } else observe(game, 'musicaNeutro', '{n} olhou para a caixinha de música, sem muita reação.', 5);
}

function dancar(game, self, box) {
  go(game, box.x + (self.x < box.x ? -70 : 70), () => {
    mind = { act: 'dance', t: 5 + Math.max(0, likesTag('musica')) * 4 };
    lembrar('musica', 'caixinhaMusica', 0.8, 0.5);
    anotar(game, 'lembranca', 'Dançou com a música pela primeira vez.', 'dancou', 0.6);
  });
}

/** Hora de dormir: cansado, ou de noite sem estar totalmente descansado. */
function sleepy(at) {
  const e = pet.needs.energia;
  return e < 25 || (isNightAt(at) && e < limiteSono());
}

/** À noite, abaixo disso vai dormir: quem é ativo aguenta acordado até mais cansado. */
function limiteSono() {
  return lerp(92, 68, T('atividade'));
}

/** À noite só acorda de manhã (ou se for incomodado); de dia, quando descansou. */
function shouldWake(at) {
  const e = pet.needs.energia;
  if (isNightAt(at)) return false;
  const morning = hourAt(at) < 9;
  // Quem é ativo levanta mais cedo (menos descansado); o calmo fica mais na cama.
  return e >= lerp(99, 88, T('atividade')) || (morning && e >= lerp(75, 50, T('atividade')));
}

/** Decisões automáticas enquanto ninguém está olhando (tempo fora, velocidade alta). */
function autoLife(at, summary) {
  const n = pet.needs;
  if (!pet.asleep && sleepy(at)) {
    pet.asleep = true;
    summary.dormiu = true;
  } else if (pet.asleep && shouldWake(at)) {
    pet.asleep = false;
  }
  if (!pet.asleep && n.fome < hungerLimit() + 5 && pet.bowl > 0) {
    pet.bowl--;
    n.fome = clamp(n.fome + 35);
    pet.care.refeicoes++;
    summary.comeu = true;
  }
}

/** Simula um intervalo longo em pedaços de 15 min e conta o que aconteceu. */
function catchUp(game, from, to) {
  const summary = {};
  let t = from;
  const end = Math.min(to, from + MAX_AWAY);
  while (t < end) {
    const step = Math.min(15 * 60000, end - t);
    autoLife(t, summary);
    decay(game, step / HOUR, t);
    t += step;
  }
  return summary;
}

function duration(hours) {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  if (!d) return `${h} h`;
  return `${d} ${d === 1 ? 'dia' : 'dias'}${h ? ` e ${h} h` : ''}`;
}

function awaySummary(game, hours, s) {
  const parts = [];
  if (s.dormiu) parts.push('dormiu');
  if (s.comeu) parts.push('comeu da tigela');
  if (pet.needs.afeto < 30) parts.push('parece ter sentido sua falta');
  const what = parts.length ? `. ${pet.name} ${parts.join(', ').replace(/, ([^,]*)$/, ' e $1')}` : '';
  observe(game, 'fora', `Você ficou fora por ${duration(hours)}${what}.`);
}

// ---------------------------------------------------------------- evolução

function checkEvolution(game, self) {
  const age = ageHours(game.clock.now);
  let next = null;
  if (pet.stage === 'bebe' && age >= JUVENIL_AT) {
    // A vida que levou: mais brincadeira e exploração → linha 1; mais calma, carinho e você por perto → linha 2.
    next = `juvenil${historia().linha}`;
  } else if ((pet.stage === 'juvenil1' || pet.stage === 'juvenil2') && age >= ADULTO_AT) {
    // Como foi cuidado: bem-estar médio, a relação com você e a variedade de comida.
    next = `adulto${cuidado().tier}${pet.stage === 'juvenil1' ? 'a' : 'b'}`;
  }
  if (!next) return;
  pet.stage = next;
  applyStage(self);
  discover(game, next);
  mind = { act: 'evolve', t: 2.5 };
  const porque = porQueCresceu(next);
  observe(game, 'evolucao', `{n} cresceu! ${porque}`);
  anotar(game, 'evolucao', `Cresceu: agora é ${STAGES[next].label.toLowerCase()}. ${porque}`, `estagio:${next}`, 1);
  if (isAdult()) observe(game, 'adulto', '{n} chegou à fase adulta! No Diário você pode começar com um novo pet.');
  game.emit('evolucao', { stage: next });
  game.playSound('sfx_evolucao');
  save(game);
}

// ---------------------------------------------------------------- evolução pela história dele
//
// A forma em que ele cresce sai da vida que levou, não de um sorteio: o que mais fez (Routine — cada decisão
// fica registrada na faixa do dia), quanto brincou com você e recebeu carinho, quantas comidas conheceu e quão
// bem foi cuidado. Ao crescer, o diário conta por quê; antes disso, a aba Jeito mostra para onde ele vai.

// O que cada atividade conta para a linha da juventude: ativa (linha 1) ou calma e carinhosa (linha 2).
const LADO = {
  brincar: 'ativo', explorar: 'ativo', passear: 'ativo', dancar: 'ativo', chamar: 'ativo',
  descansar: 'calmo', cochilar: 'calmo', procurar: 'calmo',
};
const FAZENDO = {
  brincar: 'brincando', explorar: 'explorando o quarto', passear: 'andando pelo quarto', dancar: 'dançando',
  chamar: 'chamando você para brincar', descansar: 'descansando', cochilar: 'tirando cochilos', procurar: 'perto de você',
  carinhos: 'recebendo carinho',
};

/** O que ele mais fez na vida até aqui: pesos da rotina (todas as faixas do dia) + o que fez com você. */
function historia() {
  const r = (me.get('Routine') || {}).values || {};
  const total = {};
  for (const [a, w] of Object.entries(r)) if (LADO[a]) total[a] = w.reduce((s, v) => s + v, 0);
  // Brincar com você conta como brincar; receber carinho é um lado à parte (calmo).
  total.brincar = (total.brincar || 0) + pet.care.brincadeiras * 1.5;
  total.carinhos = pet.care.carinhos * 1.5;
  let ativo = 0;
  let calmo = total.carinhos;
  for (const [a, v] of Object.entries(total)) if (LADO[a] === 'ativo') ativo += v;
  else if (LADO[a] === 'calmo') calmo += v;
  const top = Object.entries(total)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([a]) => FAZENDO[a]);
  return { ativo, calmo, linha: ativo >= calmo ? 1 : 2, top };
}

/** Como foi cuidado (0..100): bem-estar médio, a relação com você e a variedade de comida. */
function cuidado() {
  const provou = Object.keys(pet.provou || {}).length;
  const relacao = Math.max(0, Math.min(100, 30 + lembranca('voce', 'carinho') * 40 + lembranca('voce', 'brincouComVoce') * 30 + Math.min(25, (pet.care.carinhos + pet.care.brincadeiras) * 2) - (lembranca('voce', 'acordado') < -0.3 ? 15 : 0)));
  const variedade = Math.min(100, provou * 18);
  const nota = pet.wellbeing * 0.6 + relacao * 0.25 + variedade * 0.15;
  return { nota, relacao, provou, tier: nota >= 70 ? '1' : nota >= 45 ? '2' : '3' };
}

const juntar = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}` : xs[0] || '');

/** Por que ele cresceu assim (frase do diário). */
function porQueCresceu(next) {
  if (next.startsWith('juvenil')) {
    const h = historia();
    return h.top.length ? `Passou a infância ${juntar(h.top)}.` : 'Passou a infância tranquilo.';
  }
  const c = cuidado();
  const partes = [c.nota >= 70 ? 'foi muito bem cuidado' : c.nota >= 45 ? 'foi bem cuidado' : 'passou por uns apertos'];
  partes.push(c.relacao >= 70 ? 'confia muito em você' : c.relacao >= 45 ? 'gosta da sua companhia' : 'se acostumou a ficar sozinho');
  if (c.provou >= 4) partes.push('come de tudo um pouco');
  else if (c.provou <= 1) partes.push('quase só conheceu ração');
  const frase = juntar(partes);
  return frase.charAt(0).toUpperCase() + frase.slice(1) + '.';
}

/** Para onde ele está indo (aba Jeito), sem números: só o que você pode ver na vida dele até aqui. */
function crescendo() {
  if (pet.stage === 'bebe') {
    const h = historia();
    if (!h.top.length) return 'Ainda é cedo para saber como vai crescer.';
    return `Passa o tempo ${juntar(h.top)}: ${h.linha === 1 ? 'parece que vai crescer ativo' : 'parece que vai crescer calmo e carinhoso'}.`;
  }
  if (!isAdult()) {
    const c = cuidado();
    return c.nota >= 70 ? 'Está crescendo muito bem cuidado.' : c.nota >= 45 ? 'Está crescendo bem.' : 'Está passando por uns apertos: precisa de mais cuidado.';
  }
  return null;
}

function applyStage(self) {
  const st = STAGES[pet.stage];
  const s = self.get('Sprite');
  s.asset = st.frames[0];
  // O Animator alterna os quadros de idle; cada forma tem os seus (1 ou 2).
  self.get('Animator').animations.idle.frames = [...st.frames];
  s.width = st.size;
  s.height = st.size;
}

// ---------------------------------------------------------------- comportamento

function spot(game, id) {
  const e = game.entity(id);
  return e ? e.x : 480;
}

function go(game, x, then) {
  mind = { act: 'walk', targetX: Math.max(MIN_X, Math.min(MAX_X, x)), then };
}

/** O que o pet acha da ração da tigela (item do catálogo: id, categoria e tags). */
const racao = () => me.prefs.item('racao');
/** A bola (item: brinquedo ativo). */
const bola = () => me.prefs.item('bola');

/**
 * O jeito do pet com um brinquedo: o FAVORITO é o que ele mais gosta entre os que você tem (todo pet
 * que gosta de algum tem um, e dá para ver: vai nele bem mais vezes, brinca um tempão, pula e mostra ♥);
 * depois "gosta", "neutro" e "nao" (não gosta: cheira e se afasta, nunca escolhe sozinho).
 */
function jeitoCom(game, id) {
  const r = me.prefs.item(id);
  if (r.score <= -0.2) return 'nao';
  if (id === favorito(game)) return 'favorito';
  return r.score >= 0.2 ? 'gosta' : 'neutro';
}

function favorito(game) {
  let best = null;
  for (const e of game.inventory().list({ category: 'brinquedo' })) {
    const s = me.prefs.item(e.item.id).score;
    if (s > -0.2 && (!best || s > best.s)) best = { id: e.item.id, s };
  }
  return best && best.id;
}

/**
 * Memória (componente Memory da engine): o pet lembra o que viveu — um susto, uma comida adorada, uma
 * brincadeira com você — e a lembrança enfraquece com o tempo de jogo (meia-vida por tipo, na cena) e
 * fica mais forte quando se repete. me.memory.feeling(assunto, tipo) = -1..1 puxa as decisões.
 */
function lembrar(type, subject, valence, importance) {
  me.memory.remember(type, { subject, valence, importance });
}
const lembranca = (subject, type) => me.memory.feeling(subject, type);

/** Quanto a memória mexe no peso de um brinquedo: um susto quase zera; boas lembranças aumentam um pouco. */
function fatorMemoria(id) {
  const f = lembranca(id);
  return Math.max(0, Math.min(1.3, 1 + f * 1.2));
}

// Peso de cada jeito na nota de brincar (UtilityAI, target.props.peso) e quanto dura uma brincadeira.
const PESO = { favorito: 2.4, gosta: 1.3, neutro: 0.5, nao: 0 };
const DURA = { favorito: 7, gosta: 4, neutro: 2.2, nao: 1.2 };
const MEXE_A_CADA = { favorito: 0.8, gosta: 1.3, neutro: 2, nao: 99 };

/**
 * Fome a partir da qual vai até a tigela: guloso vai antes; quem não gosta da ração espera
 * mais (acaba comendo, mas sem pressa).
 */
function hungerLimit() {
  return Math.max(30, Math.min(60, 45 + (T('apetite') - 0.5) * 20 + racao().score * 10));
}

function speed() {
  let v = 90 * lerp(0.7, 1.3, T('atividade'));
  if (pet.sick) v *= 0.5;
  if (pet.needs.energia < 25) v *= 0.7;
  return v;
}

/**
 * Escolhe a próxima atividade. TODAS as opções concorrem na UtilityAI do pet (scenes/quarto.json):
 * cada nota é necessidade × personalidade × gosto + hábito (Routine). Não há prioridade fixa: com
 * fome, cansado e entediado ao mesmo tempo, quem decide é o jeito do pet — o preguiçoso dorme, o
 * guloso come, o brincalhão brinca mesmo cansado. Brinquedos e cantos do quarto são alvos
 * ("smart objects"): a IA escolhe também QUAL (self.ai.target), pelo gosto do pet.
 */
function decide(game, self) {
  sincronizarProps(game, self);
  const choice = self.ai.decide();
  const target = self.ai.target;
  if (choice) me.routine.record(choice);
  if (choice === 'dormir') {
    mind = { act: 'yawn', t: 1.6, then: () => go(game, xDeDormir(game), 'sleep') };
  } else if (choice === 'comer') {
    go(game, spot(game, 'tigela') + 55, pet.bowl > 0 ? 'eat' : 'lookBowl');
  } else if (choice === 'brincar' && target) {
    go(game, spot(game, target) - 55, 'toy');
    mind.what = target;
    // Para o favorito ele vai correndo.
    const item = toyItem(game, game.entity(target));
    if (item && jeitoCom(game, item.id) === 'favorito') mind.pressa = 1.5;
  } else if (choice === 'explorar' && target) {
    go(game, spot(game, target) + (game.random() - 0.5) * 30, 'investigate');
    mind.what = target;
  } else if (choice === 'chamar') {
    // Lembra das brincadeiras de bola com você: vai até a bola e fica olhando para você.
    const ball = game.entity('bola');
    if (ball) go(game, ball.x - 50, () => {
      // Se você não jogar a bola (jogar interrompe isto), ele lembra disso também e vai pedindo menos.
      mind = { act: 'greet', t: 5, then: () => (lembrar('brincouComVoce', 'voce', -0.4, 0.3), decide(game, self)) };
      self.get('Sprite').flipX = false;
      emote(game, self, '?', '#ffd166');
      pedindoBola = realTime;
      observe(game, 'chamar', '{n} foi até a bola e está olhando para você. Parece querer brincar de novo.', 15);
      anotar(game, 'lembranca', 'Pediu pela primeira vez para brincar de bola com você.', 'pediuBola', 0.6);
    });
  } else if (choice === 'cochilar' && target) {
    // Cochilo de dia no lugar mais gostoso (a IA escolheu qual pelo conforto e pelo barulho de lá).
    go(game, xDeitado(game.entity(target)), () => {
      pet.cochilando = true;
      mind = { act: 'nap', t: 20 + (1 - T('atividade')) * 40, then: () => acordarDoCochilo(game, self) };
      adormeceu(game);
      sonoVisivel(game);
    });
  } else if (choice === 'dancar' && target) {
    dancar(game, self, game.entity(target));
  } else if (choice === 'afastar') {
    const box = game.find('musica').find((b) => b.props.tocando);
    naoGostou(game, self);
    observe(game, 'musicaNao', '{n} não parece gostar da música.', 30);
    go(game, box && box.x < 480 ? 840 : 120, 'idle');
  } else if (choice === 'procurar') {
    go(game, 480, 'greet');
  } else if (choice === 'passear') {
    go(game, MIN_X + game.random() * (MAX_X - MIN_X), 'idle');
    reveal('atividade', 'alto');
  } else if (choice === 'emburrar') {
    mind = { act: 'sulk', t: 4 };
    reveal('paciencia', 'baixo');
  } else {
    mind = { act: 'idle', t: 2 + game.random() * lerp(6, 2, T('atividade')) };
    reveal('atividade', 'baixo');
  }
}

function acordarDoCochilo(game, self) {
  pet.cochilando = false;
  pet.needs.energia = clamp(pet.needs.energia + 3);
  const onde = ondeDorme(game);
  observe(game, 'cochilou', `{n} tirou um cochilo${onde.frase}.`, 30);
  decide(game, self);
}

/** O que as expressões da UtilityAI leem em self.props; traços, gostos e hábitos elas leem direto. */
function sincronizarProps(game, self) {
  const p = self.props;
  for (const k of NEEDS) p[k] = Math.round(pet.needs[k]);
  p.doente = pet.sick;
  p.noite = isNightAt(game.clock.now);
  p.temRacao = pet.bowl > 0;
  p.olhouTigela = realTime - lastLookBowl < 20;
  p.limiteFome = Math.round(hungerLimit());
  p.limiteSono = Math.round(limiteSono());
  for (const toy of game.find('brinquedo')) {
    const id = String(toy.props.item);
    toy.props.peso = Math.round(PESO[jeitoCom(game, id)] * fatorMemoria(id) * 100) / 100;
  }
  p.temBola = !!game.entity('bola');
  // Música tocando que incomoda este pet (não gosta, ou é muito sensível) e chega até onde ele está.
  const tocando = game.find('musica').some((b) => b.props.tocando);
  const naoGosta = me.prefs.item('caixinhaMusica').score <= -0.2 || T('sensibilidade') > 0.8;
  p.musicaIncomoda = tocando && naoGosta && (game.env(self).noise || 0) > 0.1;
}

function arrive(game, self, then) {
  const n = pet.needs;
  if (then === 'eat') {
    // Come mais rápido o que gosta; o que não gosta, devagar.
    if (pet.bowl > 0) mind = { act: 'eat', t: 3 - racao().score * 1.5 };
    else mind = { act: 'lookBowl', t: 2.5 };
  } else if (then === 'lookBowl') {
    mind = { act: 'lookBowl', t: 2.5 };
  } else if (then === 'sleep') {
    pet.asleep = true;
    pet.care.sonecas++;
    mind = { act: 'sleep' };
    observe(game, 'dormiu', '{n} adormeceu.', 60);
    adormeceu(game);
    if (!isNightAt(game.clock.now)) reveal('atividade', 'baixo');
  } else if (then === 'investigate') {
    mind = { act: 'investigate', t: 2 + T('curiosidade') * 2, what: mind.what };
    reveal('curiosidade', 'alto');
    if (T('curiosidade') > HIGH && game.random() < 0.5) observe(game, 'curioso', '{n} parece estar procurando alguma coisa.', 120);
  } else if (then === 'greet') {
    mind = { act: 'greet', t: 3 };
    reveal('sociabilidade', 'alto');
    reveal('independencia', 'baixo');
    if (n.afeto < 40) observe(game, 'saudade', '{n} parece estar com saudade de você.', 90);
  } else if (then === 'toy') {
    comecarBrincar(game, self, mind.what);
  } else if (then === 'chase') {
    mind = { act: 'play', t: 4 };
  } else mind = { act: 'idle', t: 1.5 + game.random() * 2 };
}

const toyItem = (game, toy) => toy && game.items.get(String(toy.props.item));
const barulhoIncomoda = (item) => item.tags.includes('barulhento') && T('sensibilidade') > HIGH;

/**
 * Começa a brincar sozinho com um brinquedo do quarto. O jeito decide como: com o favorito é um tempão,
 * pulando, mexendo nele sem parar (a bola ele vai empurrando e correndo atrás); com um neutro, um
 * pouquinho e perde o interesse. Durante a brincadeira ele segue o brinquedo (behave, "toy").
 */
function comecarBrincar(game, self, id) {
  const item = toyItem(game, game.entity(id));
  if (!item) return decide(game, self);
  const jeito = jeitoCom(game, item.id);
  mind = { act: 'toy', t: DURA[jeito], what: id, jeito, tick: 0.3 };
  reveal('brincadeira', 'alto');
  reveal('independencia', 'alto');
  if (jeito === 'favorito') emote(game, self, '♥', '#ff8fab');
}

/** O barulho de um brinquedo assustou o pet: ele lembra (desconfia por um tempo) e isso entra na história dele. */
function assustou(game, item) {
  lembrar('susto', item.id, -1, 0.8);
  levouSusto(game, me);
  anotar(game, 'lembranca', `Levou um susto com o barulho ${doItem(item)}.`, `susto:${item.id}`, 0.7);
}

/** Uma mexida no brinquedo durante a brincadeira: a bola é empurrada para longe do pet, os outros balançam. */
function mexerNo(game, self, toy) {
  if (toy.state.push) toy.state.push((toy.x >= self.x ? 1 : -1) * (110 + game.random() * 130));
  else if (toy.state.mexer) toy.state.mexer();
  if (mind.jeito === 'favorito' && game.random() < 0.5) {
    const item = toyItem(game, toy);
    emote(game, self, item && item.tags.includes('aconchego') ? '♥' : '♪', item && item.tags.includes('aconchego') ? '#ff8fab' : '#ffd166');
  }
}

/**
 * Fim da brincadeira sozinho: diverte pelo item e pelo jeito (o favorito diverte muito mais); quem é
 * independente se diverte mais sozinho. Um brinquedo barulhento incomoda quem é sensível.
 */
function brincouSozinho(game, self, id) {
  const item = toyItem(game, game.entity(id));
  if (!item) return;
  const n = pet.needs;
  const jeito = mind.jeito || jeitoCom(game, item.id);
  const k = { favorito: 1.6, gosta: 1, neutro: 0.4, nao: 0 }[jeito];
  n.diversao = clamp(n.diversao + (Number(item.props.diversao) || 8) * k * lerp(0.7, 1.4, T('independencia')));
  n.afeto = clamp(n.afeto + (Number(item.props.afeto) || 0) * k);
  if (item.tags.includes('barulhento') && !barulhoIncomoda(item)) reveal('sensibilidade', 'baixo');
  if (barulhoIncomoda(item)) {
    n.diversao = clamp(n.diversao - 6);
    reveal('sensibilidade', 'alto');
    assustou(game, item);
    observe(game, `barulho:${item.id}`, `{n} não parece gostar do barulho ${doItem(item)}.`, 120);
    return;
  }
  lembrar('brinquedo', item.id, { favorito: 1, gosta: 0.6, neutro: 0.1, nao: -0.3 }[jeito], 0.5);
  gostoVisto(game, item.id, me.prefs.item(item.id).level, 0.5);
  if (jeito === 'favorito') saber(game, `favorito:${item.id}`, 1);
  anotar(game, 'brinquedo', `Brincou com ${oItem(item)} pela primeira vez.`, `brincou:${item.id}`, 0.4);
  if (jeito === 'favorito') {
    emote(game, self, '♥', '#ff8fab');
    // Enquanto você ainda não sabe, a observação aponta o preferido; depois, só de vez em quando.
    const sabe = me.knowledge.level(`favorito:${item.id}`) !== 'unknown' && me.knowledge.level(`favorito:${item.id}`) !== 'possible';
    if (sabe) observe(game, `favorito:${item.id}`, `{n} se divertiu um tempão com ${oItem(item)}, o brinquedo preferido.`, 360);
    else observe(game, `favorito:${item.id}`, `{n} brincou um tempão com ${oItem(item)}. Parece ser o brinquedo preferido.`, 30);
  } else if (jeito === 'neutro') observe(game, `neutro:${item.id}`, `{n} mexeu um pouco ${noItem(item)} e logo perdeu o interesse.`, 60);
}

/**
 * Um brinquedo apareceu ("novo": comprado; "voltou": saiu da caixa) ou você o mexeu ("mostrou"). O pet
 * reage pelo jeito, na hora: corre para o favorito com ♥; vai brincar com o que gosta; com o neutro,
 * cheira e brinca um pouquinho; do que não gosta (ou do barulho, se é sensível) se afasta.
 */
function verBrinquedo(game, self, id, como) {
  const toy = game.entity(id);
  const item = toyItem(game, toy);
  if (!item || pet.asleep || refeicao) return;
  const jeito = jeitoCom(game, item.id);
  const lado = self.x < toy.x ? -1 : 1;
  // Ainda lembra do susto: olha de longe, desconfiado, e não chega perto.
  if (lembranca(item.id, 'susto') <= -0.3) {
    desconfiou(game, self);
    observe(game, `desconfiado:${item.id}`, `{n} ainda parece desconfiado ${doItem(item)}.`, 5);
    go(game, toy.x + lado * 260, 'idle');
    return;
  }
  if (jeito === 'nao' || barulhoIncomoda(item)) {
    const susto = barulhoIncomoda(item) && como !== 'novo';
    if (susto) assustou(game, item);
    const perto = () => {
      if (susto) levouSusto(game, self);
      else naoGostou(game, self);
      observe(game, `naoGosta:${item.id}`, susto ? `{n} se assustou com o barulho ${doItem(item)} e foi para longe.` : `{n} cheirou ${oItem(item)} e se afastou. Não parece ter gostado.`, 10);
      go(game, toy.x + lado * 230, 'idle');
    };
    if (susto) perto();
    else go(game, toy.x + lado * 70, () => (mind = { act: 'investigate', t: 1.2, what: id, then: perto }));
    return;
  }
  if (pet.needs.energia < 15 || pet.sick) {
    observe(game, `cansado:${item.id}`, `{n} olhou ${oItem(item)}, mas parece sem energia para brincar.`, 10);
    mind = { act: 'investigate', t: 1.2, what: id };
    return;
  }
  if (jeito === 'favorito') {
    emote(game, self, '♥', '#ff8fab');
    const msg = como === 'novo' ? `{n} foi correndo ver ${oItem(item)} e parece adorar!` : `{n} se animou na hora com ${oItem(item)}!`;
    observe(game, `animou:${item.id}`, msg, 10);
  } else if (como === 'novo') {
    observe(game, `novo:${item.id}`, jeito === 'gosta' ? `{n} foi ver ${oItem(item)} e começou a brincar.` : `{n} cheirou ${oItem(item)} e brincou só um pouquinho.`, 10);
  }
  go(game, toy.x + lado * 55, 'toy');
  mind.what = id;
  if (jeito === 'favorito') mind.pressa = 1.7;
}

/** Ações que terminam com um efeito. */
function finish(game, self) {
  const n = pet.needs;
  const act = mind.act;
  if (act === 'eat') {
    if (pet.bowl > 0) {
      pet.bowl--;
      n.fome = clamp(n.fome + 35);
      pet.care.refeicoes++;
      const r = racao();
      if (r.level === 'love' || r.level === 'like') {
        observe(game, 'comeu', r.level === 'love' ? '{n} comeu a ração com muita vontade.' : '{n} comeu da tigela.', 30);
        if (r.level === 'love') emote(game, self, '♥', '#ff8fab');
        reveal('apetite', 'alto');
      } else if (r.level === 'neutral') observe(game, 'comeu', '{n} comeu da tigela.', 30);
      else observe(game, 'comeuSemVontade', '{n} comeu a ração, mas sem muita vontade.', 60);
      game.playSound('sfx_comer');
    }
  } else if (act === 'lookBowl') {
    lastLookBowl = realTime;
    observe(game, 'tigelaVazia', '{n} está olhando para a tigela vazia.', 60);
    emote(game, self, '?', '#f6e3a1');
  } else if (act === 'play') {
    // Brincar com você: o quanto diverte depende do gosto pela bola e de o pet ser sociável.
    const b = bola();
    n.diversao = clamp(n.diversao + 30 * (1 + 0.5 * b.score));
    n.energia = clamp(n.energia - 8);
    n.afeto = clamp(n.afeto + 5 * lerp(0.4, 1.6, T('sociabilidade')));
    pet.care.brincadeiras++;
    ganhar(game, 2, 'brincar', 30);
    reveal('brincadeira', 'alto');
    lembrar('brincouComVoce', 'voce', { love: 1, like: 0.7, neutral: 0.35 }[b.level] ?? 0.1, 0.6);
    gostoVisto(game, 'bola', b.level);
    anotar(game, 'lembranca', 'Brincou de bola com você pela primeira vez.', 'bolaComVoce', 0.5);
    if (b.level === 'love') {
      observe(game, 'brincou', '{n} ficou animado!', 20);
      emote(game, self, '♪', '#ffd166');
    } else if (b.level === 'like') {
      observe(game, 'brincou', '{n} parece ter gostado de brincar.', 20);
      emote(game, self, '♪', '#ffd166');
    } else observe(game, 'brincou', '{n} brincou um pouco com a bola.', 20);
  } else if (act === 'toy') brincouSozinho(game, self, mind.what);
  decide(game, self);
}

// ---------------------------------------------------------------- interações (API)

// ---------------------------------------------------------------- minigames (engine: game.startMinigame / endMinigame)
//
// Brincar junto é uma cena à parte (o quarto fica guardado como estava e volta no fim). O pet leva para lá o
// que o jogo precisa saber dele (forma, jeito, gostos) e volta com o que aconteceu: aqui isso vira diversão,
// cansaço, lembrança de ter brincado com você, pistas dos gostos dele, moedas e uma página no diário.

const JOGOS = {
  pegar: { nome: 'Pega-pega', cena: 'pegar', energia: -10, fome: -4 },
  caixinhas: { nome: 'Caixinhas', cena: 'caixinhas', energia: -4, fome: 0 },
};
const MOEDAS_JOGO_DIA = 15;

function moedasDeJogoHoje(game) {
  const dia = Math.floor((game.clock.now + localOffset) / DAY);
  if (!pet.jogosDia || pet.jogosDia.dia !== dia) pet.jogosDia = { dia, moedas: 0 };
  return pet.jogosDia;
}

/** Por que ele não quer brincar agora (ou null). */
function semVontadeDeJogar() {
  if (pet.asleep) return '{n} está dormindo.';
  if (pet.sick) return '{n} não está se sentindo bem para brincar.';
  if (pet.needs.energia < 20) return '{n} está cansado demais para brincar agora.';
  if (pet.needs.fome < 15) return '{n} está com fome demais para brincar.';
  return null;
}

function jogar(game, self, jogo) {
  const j = JOGOS[jogo];
  if (!j) return { ok: false, reason: 'jogo' };
  const nao = semVontadeDeJogar();
  if (nao) {
    observe(game, 'semJogo', nao, 0, 2); // resposta ao seu clique: aparece sempre
    return { ok: false, reason: nao };
  }
  terminarRefeicao(game, self, false);
  const st = STAGES[pet.stage];
  const params = {
    jogo,
    nome: pet.name,
    quadros: [...st.frames],
    tamanho: st.size,
    pe: st.foot,
    jeito: { atividade: T('atividade'), curiosidade: T('curiosidade'), paciencia: T('paciencia'), brincadeira: T('brincadeira') },
    // O que ele acha de cada comida (o jogo mostra a reação; o diário só aprende com o que você vê).
    comidas: game.items.list({ category: 'comida' }).map((it) => ({ id: it.id, icon: it.icon || '•', nivel: me.prefs.item(it.id).level })),
    moedas: Math.max(0, MOEDAS_JOGO_DIA - moedasDeJogoHoje(game).moedas),
  };
  save(game);
  game.startMinigame(j.cena, params);
  return { ok: true };
}

/** De volta ao quarto depois de um minigame: o que a brincadeira fez com ele. */
function voltouDoJogo(game, self, ev) {
  const r = ev.result || {};
  const j = JOGOS[r.jogo];
  if (!j) return;
  const animo = Math.max(0, Math.min(1, Number(r.animo) || 0));
  const n = pet.needs;
  n.diversao = clamp(n.diversao + 12 + animo * 18);
  n.afeto = clamp(n.afeto + 6);
  n.energia = clamp(n.energia + j.energia);
  n.fome = clamp(n.fome + j.fome);
  pet.care.brincadeiras++;
  lembrar('brincouComVoce', 'voce', 1, 0.6);
  me.routine.record('brincar');
  // As reações que você viu no jogo são pistas dos gostos (mais fracas do que dar de comer, mas uma partida já dá um "talvez").
  for (const [id, nivel] of Object.entries(r.reacoes || {})) if (game.items.get(id) && VERBO[nivel]) gostoVisto(game, id, nivel, 0.6);
  // O jeito dele aparece no jogo: rápido (ativo), farejador (curioso), sem paciência para esperar.
  if (r.jogo === 'pegar') reveal('atividade', 'alto', 1);
  if (r.jogo === 'pegar') reveal('atividade', 'baixo', 1); // devagar atrás das coisas
  if (r.farejou) reveal('curiosidade', 'alto', 1);
  if (r.jogo === 'caixinhas' && !r.farejou) reveal('curiosidade', 'baixo', 1); // nem fareja
  if (r.naoEsperou) reveal('paciencia', 'baixo', 1);
  if (animo >= 0.6) reveal('brincadeira', 'alto');
  const hoje = moedasDeJogoHoje(game);
  const moedas = Math.min(Math.max(0, Math.floor(Number(r.moedas) || 0)), MOEDAS_JOGO_DIA - hoje.moedas);
  if (moedas > 0) {
    hoje.moedas += moedas;
    ganhar(game, moedas, 'jogo');
  }
  pet.jogos = pet.jogos || {};
  const rec = pet.jogos[r.jogo] || { vezes: 0, melhor: 0 };
  const primeira = rec.vezes === 0;
  const recorde = !primeira && (Number(r.pontos) || 0) > rec.melhor;
  rec.vezes++;
  rec.melhor = Math.max(rec.melhor, Number(r.pontos) || 0);
  pet.jogos[r.jogo] = rec;
  if (primeira) anotar(game, 'lembranca', `Brincou de ${j.nome} com você pela primeira vez.`, `jogo:${r.jogo}`, 0.6);
  else if (recorde) anotar(game, 'lembranca', `Foi melhor do que nunca no ${j.nome}.`, undefined, 0.4);
  const frase = recorde
    ? `{n} foi melhor do que nunca no ${j.nome}!`
    : animo >= 0.6
      ? `{n} adorou brincar de ${j.nome} com você!`
      : animo >= 0.25
        ? `{n} se divertiu brincando de ${j.nome} com você.`
        : `{n} brincou de ${j.nome} com você, meio sem jeito.`;
  observe(game, 'jogo', frase, 0, 2);
  emote(game, self, '♥', '#ff8fab');
  if (animo >= 0.6) self.after(300, () => emote(game, self, '♥', '#ff8fab'));
  mind = { act: 'happy', t: 1.4 };
  save(game);
}

function makeApi(game, self) {
  const awake = () => !pet.asleep;
  return {
    get pet() {
      return pet;
    },
    stage: () => STAGES[pet.stage],
    carinho() {
      const n = pet.needs;
      const impaciente = T('paciencia') < LOW;
      if (pet.asleep) {
        if (impaciente) {
          naoGostou(game, self);
          observe(game, 'acordado', '{n} acordou e não parece gostar disso.', 5);
          lembrar('acordado', 'voce', -1, 0.7);
          anotar(game, 'lembranca', 'Ficou chateado quando você o acordou.', 'acordado', 0.5);
          wake(game, self, true);
          reveal('paciencia', 'baixo');
        } else observe(game, 'carinhoDormindo', '{n} se mexeu um pouco, ainda dormindo.', 10);
        return;
      }
      const recent = realTime - lastPetReal < 6;
      lastPetReal = realTime;
      // Ainda lembra de ter sido acordado por você há pouco: se afasta.
      if (!recent && lembranca('voce', 'acordado') <= -0.4) {
        naoGostou(game, self);
        observe(game, 'aindaChateado', '{n} ainda parece chateado por ter sido acordado.', 5);
        go(game, self.x + (self.x < 480 ? -1 : 1) * 160, 'idle');
        return;
      }
      if (impaciente && (n.energia < 40 || recent)) {
        n.afeto = clamp(n.afeto - 3);
        reveal('paciencia', 'baixo');
        lembrar('carinho', 'voce', -0.6, 0.4);
        me.prefs.learn('carinho', -0.3);
        naoGostou(game, self);
        observe(game, 'carinhoRuim', '{n} não parece gostar disso agora.', 2);
        mind = { act: 'sulk', t: 3 };
        return;
      }
      if (recent) {
        observe(game, 'carinhoDemais', '{n} não parece querer mais carinho agora.', 2);
        return;
      }
      // O gosto pelo carinho (o inato já é puxado pelo jeito: apegados gostam mais, independentes menos).
      const level = feel('carinho').level;
      pet.care.carinhos++;
      if (level === 'love' || level === 'like') {
        n.afeto = clamp(n.afeto + (level === 'love' ? 22 : 15));
        n.diversao = clamp(n.diversao + 3);
        emote(game, self, '♥', '#ff8fab');
        reveal('sociabilidade', 'alto');
        lembrar('carinho', 'voce', level === 'love' ? 1 : 0.6, 0.4);
        me.prefs.learn('carinho', 0.3);
        gostoVisto(game, 'carinho', level);
        anotar(game, 'lembranca', level === 'love' ? 'Recebeu o primeiro carinho e adorou.' : 'Recebeu o primeiro carinho e gostou.', 'carinho', 0.5);
        observe(game, 'carinho', level === 'love' ? '{n} parece adorar o carinho.' : '{n} parece gostar do carinho.', 2);
        mind = { act: 'happy', t: 1.2 };
      } else if (level === 'neutral') {
        n.afeto = clamp(n.afeto + 8);
        lembrar('carinho', 'voce', 0.1, 0.3);
        reveal('sociabilidade', 'baixo');
        gostoVisto(game, 'carinho', level);
        anotar(game, 'lembranca', 'Recebeu o primeiro carinho, sem muita empolgação.', 'carinho', 0.4);
        observe(game, 'carinho', '{n} aceitou o carinho, sem muita empolgação.', 2);
        mind = { act: 'idle', t: 1 };
      } else {
        // Não gosta: se afasta um pouco (afastar já diz muito; sem punição).
        n.afeto = clamp(n.afeto + 2);
        reveal('independencia', 'alto');
        reveal('sociabilidade', 'baixo');
        lembrar('carinho', 'voce', -0.4, 0.3);
        gostoVisto(game, 'carinho', level);
        anotar(game, 'lembranca', 'No primeiro carinho, se afastou: parece gostar do próprio espaço.', 'carinho', 0.5);
        naoGostou(game, self);
        observe(game, 'carinhoAfasta', '{n} se afastou um pouco. Parece preferir o próprio espaço.', 30);
        go(game, self.x + (self.x < 480 ? -1 : 1) * 140, 'idle');
      }
    },
    encherTigela() {
      if (pet.bowl >= 3) {
        observe(game, 'tigelaCheia', 'A tigela já está cheia.', 1);
        return;
      }
      pet.bowl = 3;
      game.playSound('sfx_tigela');
      if (awake() && pet.needs.fome < 70) go(game, spot(game, 'tigela') + 55, 'eat');
    },
    remedio() {
      if (!pet.sick) {
        observe(game, 'remedioSemDoenca', '{n} não parece precisar de remédio.', 2);
        return;
      }
      pet.sick = false;
      pet.needs.saude = clamp(pet.needs.saude + 25);
      observe(game, 'remedio', '{n} parece estar se sentindo melhor.', 2);
    },
    /** Você mexeu num brinquedo: reage pelo jeito com ele (verBrinquedo). */
    brinquedoMostrado(id) {
      verBrinquedo(game, self, id, 'mostrou');
    },
    /** Um brinquedo apareceu no quarto: comprado ("novo") ou tirado da caixa ("voltou"). */
    brinquedoNovo(id, como) {
      const e = game.entity(id);
      const item = e && game.items.get(String(e.props.item));
      if (item && item.category === 'ambiente') verCoisa(game, self, id);
      else verBrinquedo(game, self, id, como || 'novo');
    },
    /** Brincar junto (minigame "pegar" ou "caixinhas"): {ok} ou {ok: false, reason} se ele não quer agora. */
    jogar(jogo) {
      return jogar(game, self, jogo);
    },
    /** Você abriu ou fechou a cortina. */
    cortina() {
      reagirAoAmbiente(game, self, 'cortina');
    },
    /** A caixinha de música começou ou parou de tocar. */
    musica(on, id) {
      ouviuMusica(game, self, on, id);
    },
    /**
     * Você abriu a comida: se ele lembra de ter adorado alguma das que você tem, vem correndo
     * até a bandeja (lembra que dali vem coisa boa).
     */
    bandejaAberta() {
      if (pet.asleep || refeicao || pet.sick) return;
      const boa = game.inventory().list({ category: 'comida' }).map((e) => lembranca(e.item.id, 'comida')).reduce((a, b) => Math.max(a, b), 0);
      if (boa < 0.4) return;
      emote(game, self, '♥', '#ff8fab');
      observe(game, 'bandeja', '{n} veio correndo quando você abriu a comida.', 10);
      go(game, 480, 'greet');
      mind.pressa = 1.6;
    },
    /** O favorito entre os brinquedos que você tem (id), ou null. */
    favorito: () => favorito(game),
    bolaJogada(x) {
      const n = pet.needs;
      if (pet.asleep) return;
      const b = bola();
      const wants = n.energia > 20 && (n.diversao < 85 || T('brincadeira') > HIGH) && !pet.sick;
      if (!wants) {
        observe(game, 'semVontade', '{n} não parece com vontade de brincar agora.', 5);
        return;
      }
      if (b.score <= -0.3) {
        // Olha a bola passar e fica onde está.
        reveal('brincadeira', 'baixo');
        observe(game, 'bolaNao', '{n} olhou a bola passar, mas não parece muito interessado nela.', 20);
        gostoVisto(game, 'bola', b.level);
        mind = { act: 'investigate', t: 1.5, what: 'bola' };
        return;
      }
      reveal('brincadeira', 'alto');
      if (realTime - pedindoBola < 20) {
        // Era isso que ele estava pedindo.
        pedindoBola = -99;
        emote(game, self, '♥', '#ff8fab');
        observe(game, 'pedidoAtendido', 'Parece que era exatamente isso que {n} queria!', 5);
      } else if (jeitoCom(game, 'bola') === 'favorito') emote(game, self, '♥', '#ff8fab');
      mind = { act: 'chase' };
    },
    limpar(id) {
      const d = game.entity(id);
      if (d) d.destroy();
      pet.dirt = Math.max(0, pet.dirt - 1);
      // Pelo menos o nível que corresponde às sujeiras que sobraram, para não brotar outra na hora.
      const level = [75, 50, 30][pet.dirt] ?? 0; // com folga sobre os limites (70, 45, 25)
      pet.needs.higiene = clamp(Math.max(pet.needs.higiene + 18, level));
      pet.care.limpezas++;
      ganhar(game, 1, 'limpar');
      if (pet.dirt === 0) observe(game, 'limpo', '{n} parece mais à vontade com o quarto limpo.', 60);
    },
    alternarLuz() {
      pet.lightOn = !pet.lightOn;
      luzDaLampada(game);
      reagirAoAmbiente(game, self, 'luz');
      save(game);
    },
    /** O texto do diário na aba ("jeito" | "gostos" | "historias"; padrão: game.vars.diarioAba). */
    diario(aba, pagina) {
      return diaryText(game, aba || game.vars.diarioAba || 'jeito', pagina === undefined ? game.vars.diarioPagina || 0 : pagina);
    },
    /** Quantas páginas a aba tem (padrão: a aberta). */
    diarioPaginas(aba) {
      return diaryPages(game, aba || game.vars.diarioAba || 'jeito').length;
    },
    salvar() {
      save(game);
    },
    adulto: () => isAdult(),
    /** Só na fase adulta: o pet vai para a coleção e um novo pet pode chegar. */
    novoPet() {
      if (!isAdult()) return false;
      const c = collection(game);
      c.pets.push({
        nome: pet.name,
        forma: pet.stage,
        nasceu: pet.born,
        partiu: game.clock.now,
        dias: Math.floor(ageHours(game.clock.now) / 24),
        jeito: seenTraits(),
      });
      game.storage.set('colecao', c);
      game.storage.remove('pet');
      if (me.persist.key) game.storage.remove(me.persist.key);
      game.notifications.clear(); // as observações eram deste pet
      // O novo pet começa do zero: sem os itens, as moedas e o quarto arrumado do anterior (vem a cesta de
      // boas-vindas, as moedas iniciais e a bola). A coleção e a velocidade ficam.
      for (const k of ['vibe.inventory', 'vibe.wallet', 'economia', 'quarto']) game.storage.remove(k);
      game.loadScene('inicio');
      return true;
    },
  };
}

function wake(game, self, rude) {
  pet.asleep = false;
  mind = { act: rude ? 'sulk' : 'idle', t: 2 };
  if (!rude) observe(game, 'acordou', '{n} acordou.', 60);
}

// ---------------------------------------------------------------- diário (abas: jeito, gostos, histórias)
//
// O diário só conta o que você teve chance de ver (Knowledge), com a confiança disso — "talvez",
// "parece", e sem rodeio quando está confirmado — e a história dele (Journal). Nenhum número.

const PARTES_DO_DIA = [[0, 6, 'de madrugada'], [6, 12, 'de manhã'], [12, 18, 'à tarde'], [18, 24, 'à noite']];
const ATIVIDADE = {
  dormir: 'dormir',
  comer: 'comer',
  brincar: 'brincar',
  explorar: 'explorar o quarto',
  procurar: 'vir até você',
  passear: 'passear pelo quarto',
  descansar: 'descansar',
  chamar: 'chamar você para brincar',
  cochilar: 'tirar um cochilo',
  dancar: 'dançar com a música',
};
const VERBO = {
  love: ['adore', 'adorar', 'Adora'],
  like: ['goste de', 'gostar de', 'Gosta de'],
  neutral: ['não ligue muito para', 'não ligar muito para', 'Não liga muito para'],
  dislike: ['não goste de', 'não gostar de', 'Não gosta de'],
  hate: ['deteste', 'detestar', 'Detesta'],
};
const CONFIANCA = { possible: 0, observed: 1, confirmed: 2 };
const OUTROS = { carinho: 'carinho', escuro: 'ficar no escuro', musica: 'música', luzNormal: 'luz acesa acordado e escuro para dormir' };

function fraseJeito(level, jeito) {
  return [`Talvez seja ${jeito}.`, `Parece ser ${jeito}.`, `É ${jeito}.`][CONFIANCA[level]];
}

function fraseGosto(level, nivel, nome) {
  const v = VERBO[nivel];
  const frase = [`Talvez ${v[0]} ${nome}.`, `Parece ${v[1]} ${nome}.`, `${v[2]} ${nome}.`][CONFIANCA[level]];
  // "gostar de a bola" → "gostar da bola"; "de o chocalho" → "do chocalho".
  return frase.replace(/\bde (a|o) /g, (_, art) => `d${art} `);
}

/** Por assunto, o nível de gosto com mais evidência: [{subject, nivel, level, evidence}]. */
function gostosVistos() {
  const best = {};
  for (const k of me.knowledge.list({ prefix: 'gosto:' })) {
    const [, subject, nivel] = k.key.split(':');
    if (!VERBO[nivel]) continue;
    if (!best[subject] || k.evidence > best[subject].evidence) best[subject] = { subject, nivel, level: k.level, evidence: k.evidence };
  }
  return Object.values(best);
}

function abaJeito(game) {
  const age = ageHours(game.clock.now);
  const days = Math.floor(age / 24);
  const hours = Math.floor(age % 24);
  const lines = [`Idade: ${days > 0 ? `${days} ${days === 1 ? 'dia' : 'dias'} e ` : ''}${hours} h  ·  ${STAGES[pet.stage].label}`, '', 'Jeito'];
  const jeitos = me.knowledge.list({ prefix: 'jeito:' }).filter((k) => JEITO[k.key.slice(6)]);
  if (jeitos.length) for (const k of jeitos.slice(0, 6)) lines.push(`· ${fraseJeito(k.level, JEITO[k.key.slice(6)])}`);
  else lines.push('· Ainda observando... cada coisa que ele faz conta.');
  lines.push('', 'Hábitos');
  const habitos = [];
  for (const h of me.routine.patterns()) {
    const parte = PARTES_DO_DIA.find(([a, b]) => h.from >= a && h.from < b);
    const frase = ATIVIDADE[h.activity] && parte && `Costuma ${ATIVIDADE[h.activity]} ${parte[2]}.`;
    if (frase && !habitos.includes(frase)) habitos.push(frase);
  }
  if (habitos.length) for (const f of habitos.slice(0, 4)) lines.push(`· ${f}`);
  else lines.push('· Os hábitos aparecem com os dias.');
  const rumo = crescendo();
  if (rumo) lines.push('', 'Crescendo', `· ${rumo}`);
  if (isAdult()) lines.push('', 'Fase adulta: você pode começar com um novo pet (botão abaixo).');
  return lines;
}

function abaGostos(game) {
  const comidas = [];
  const brinquedos = [];
  const outros = [];
  for (const g of gostosVistos()) {
    const item = game.items.get(g.subject);
    // Comida sem artigo ("adora maçã"); brinquedo com ("adora a bola").
    if (item && item.category !== 'comida') brinquedos.push(`· ${fraseGosto(g.level, g.nivel, oItem(item))}`);
    else if (item) comidas.push(`· ${fraseGosto(g.level, g.nivel, nomeDe(item))}`);
    else if (OUTROS[g.subject]) outros.push(`· ${fraseGosto(g.level, g.nivel, OUTROS[g.subject])}`);
  }
  const fav = me.knowledge.list({ prefix: 'favorito:' })[0];
  const favItem = fav && game.items.get(fav.key.slice(9));
  if (favItem) {
    const o = oItem(favItem);
    brinquedos.unshift(`· ${[`Talvez o brinquedo preferido seja ${o}.`, `O brinquedo preferido parece ser ${o}.`, `O brinquedo preferido é ${o}.`][CONFIANCA[fav.level]]}`);
  }
  const lines = [];
  if (comidas.length) lines.push('Comidas', ...comidas.slice(0, 7), '');
  if (brinquedos.length) lines.push('Brinquedos e coisas do quarto', ...brinquedos.slice(0, 5), '');
  if (outros.length) lines.push('Outras coisas', ...outros);
  if (!lines.length) lines.push('Ainda não deu para perceber do que gosta.', '', 'Ofereça comidas, mostre brinquedos, faça carinho — e observe.');
  return lines;
}

function abaHistorias(game) {
  const entries = me.journal.entries();
  if (!entries.length) return ['Nada aconteceu ainda.'];
  return entries.map((e) => `Dia ${Math.max(1, Math.floor((e.t - pet.born) / DAY) + 1)}  ·  ${e.text}`);
}

/**
 * As páginas de uma aba: o papel cabe ~15 linhas, então o texto é dividido (estimando as linhas que quebram por
 * tamanho) e as setas do diário trocam de página. Um título de seção não fica sozinho no fim de uma página.
 */
const LINHAS_POR_PAGINA = 14;
const linhasDe = (s) => Math.max(1, Math.ceil(s.length / 62));

function diaryPages(game, aba) {
  const body = aba === 'gostos' ? abaGostos(game) : aba === 'historias' ? abaHistorias(game) : abaJeito(game);
  const pages = [[]];
  let used = 0;
  body.forEach((line, i) => {
    const n = linhasDe(line);
    const titulo = line && !line.startsWith('·') && body[i + 1] && body[i + 1].startsWith('·');
    if (used + n + (titulo ? 1 : 0) > LINHAS_POR_PAGINA && used > 0) {
      pages.push([]);
      used = 0;
    }
    if (used === 0 && line === '') return; // página não começa em branco
    pages[pages.length - 1].push(line);
    used += n;
  });
  return pages;
}

function diaryText(game, aba, pagina = 0) {
  const pages = diaryPages(game, aba);
  const p = pages[Math.max(0, Math.min(pages.length - 1, pagina))];
  return [`Diário de ${pet.name}`, '', ...p].join('\n');
}

/**
 * Saves de antes do diário: os sinais de jeito antigos viram evidência, os gostos já provados também,
 * e a história começa aqui (sem inventar o passado).
 */
function migrarDiario(game) {
  if (pet.revealed && Object.keys(pet.revealed).length) {
    for (const [k, n] of Object.entries(pet.revealed)) if (JEITO[k]) saber(game, `jeito:${k}`, n);
    pet.revealed = {};
  }
  for (const [id, level] of Object.entries(pet.provou || {})) {
    if (game.items.get(id) && !me.knowledge.list({ prefix: `gosto:${id}:` }).length) gostoVisto(game, id, level);
  }
  if (!me.journal.entries({ limit: 1 }).length) anotar(game, 'evolucao', 'Começou este diário.', 'diario', 0.9);
}

/**
 * Um gosto mudou de nível (Preferences: o que ele viveu ensina — a fome, o enjoo que passou, um susto, as
 * brincadeiras): uma observação, uma página do diário, e o que você sabia dele acompanha a mudança.
 */
const SUBIU = {
  love: ['parece ter passado a adorar', 'Passou a adorar'],
  like: ['parece ter começado a gostar de', 'Começou a gostar de'],
  neutral: ['parece não se incomodar mais com', 'Deixou de se incomodar com'],
  dislike: ['parece estar detestando menos', 'Passou a detestar menos'],
};
const DESCEU = {
  like: ['parece não estar mais tão louco por', 'Já não é mais tão louco por'],
  neutral: ['parece ter perdido o interesse por', 'Perdeu o interesse por'],
  dislike: ['parece ter começado a não gostar de', 'Começou a não gostar de'],
  hate: ['parece ter passado a detestar', 'Passou a detestar'],
};

/** "gostar de" + "a bola" → "gostar da bola"; "por" + "o leite" → "pelo leite". */
function junta(frase, nome) {
  const m = /^(o|a|os|as) (.*)$/.exec(nome);
  if (m && frase.endsWith(' de')) return `${frase.slice(0, -3)} d${nome}`;
  if (m && frase.endsWith(' por')) return `${frase.slice(0, -4)} pel${nome}`;
  return `${frase} ${nome}`;
}

let mudouAgora = { subject: null, t: -99 }; // o gosto que acabou de mudar (para não dizer "enjoando" na mesma hora)

function mudouGosto(game, ev) {
  mudouAgora = { subject: ev.subject, t: realTime };
  const ordem = ['hate', 'dislike', 'neutral', 'like', 'love'];
  const subiu = ordem.indexOf(ev.to) > ordem.indexOf(ev.from);
  const frase = (subiu ? SUBIU : DESCEU)[ev.to];
  const item = game.items.get(ev.subject);
  const nome = item ? (item.category === 'comida' ? nomeDe(item) : oItem(item)) : OUTROS[ev.subject];
  if (!frase || !nome) return;
  observe(game, `mudou:${ev.subject}`, `{n} ${junta(frase[0], nome)}.`, 30);
  anotar(game, 'gosto', `${junta(frase[1], nome)}.`, `mudou:${ev.subject}:${ev.to}`, 0.7);
  // O que você sabia do gosto antigo vale menos; o novo passa na frente (você acabou de ver).
  let antes = 0;
  for (const k of me.knowledge.list({ prefix: `gosto:${ev.subject}:`, minLevel: 'unknown' })) {
    antes = Math.max(antes, k.evidence);
    if (!k.key.endsWith(`:${ev.to}`)) me.knowledge.observe(k.key, -k.evidence * 0.5);
  }
  saber(game, `gosto:${ev.subject}:${ev.to}`, antes * 0.6 + 1);
}

/** Uma lembrança forte que se apagou também é parte da história; um gosto que mudou também. */
function onEvent(self, ev, game) {
  if (ev.type === 'minigame_end') return voltouDoJogo(game, self, ev);
  if (ev.type === 'preference_change' && ev.entity === self.id) return mudouGosto(game, ev);
  if (ev.type !== 'memory_forgotten' || ev.entity !== self.id || ev.memory !== 'susto' || ev.importance < 0.7) return;
  const item = game.items.get(String(ev.subject));
  if (item) anotar(game, 'lembranca', `Parece ter esquecido o susto com ${oItem(item)}.`, `esqueceu:susto:${item.id}`, 0.4);
}

// ---------------------------------------------------------------- moedas (engine: game.wallet / game.inventory)

const MOEDA = 'moedas';
const VISITA = 10;
// Cesta de boas-vindas: um pouco de cada para começar a descobrir os gostos.
const CESTA = { maca: 1, cenoura: 1, leite: 1, biscoito: 1 };
const CESTA_MOEDAS = 15;

/** Moedas por cuidar; com cooldown (minutos de jogo) para não virar fazenda de cliques. */
function ganhar(game, n, motivo, cooldownMin = 0) {
  if (cooldownMin > 0) {
    const k = `moeda:${motivo}`;
    const last = pet.cooldowns[k];
    if (last !== undefined && game.clock.now - last < cooldownMin * 60000) return;
    pet.cooldowns[k] = game.clock.now;
  }
  game.wallet.add(n, MOEDA, motivo);
}

/** Cesta de boas-vindas (uma vez por save) e moedas pela primeira visita de cada dia. */
function economiaDoDia(game) {
  const e = game.storage.get('economia') || {};
  const day = Math.floor((game.clock.now + localOffset) / DAY);
  if (e.cesta && e.dia === day) return;
  if (!e.cesta) {
    e.cesta = true;
    for (const [id, n] of Object.entries(CESTA)) game.inventory().add(id, n, 'cesta');
    game.wallet.add(CESTA_MOEDAS, MOEDA, 'cesta');
  }
  if (e.dia !== day) {
    const first = e.dia === undefined;
    e.dia = day;
    if (!first) {
      game.wallet.add(VISITA, MOEDA, 'visita');
      observe(game, 'visita', `Um novo dia com ${pet.name}: +${VISITA} moedas.`);
    }
  }
  game.storage.set('economia', e);
}

// ---------------------------------------------------------------- comida oferecida (itens)

const DOCES_POR_DIA = 4;
// "a maçã", "da maçã" (props.artigo do item: "a" ou "o").
const nomeDe = (item) => item.name.toLowerCase();
const oItem = (item) => `${item.props.artigo || 'o'} ${nomeDe(item)}`;
const doItem = (item) => `d${item.props.artigo || 'o'} ${nomeDe(item)}`;
const noItem = (item) => `n${item.props.artigo || 'o'} ${nomeDe(item)}`;

/** A comida no chão some aos poucos. */
function sumir(food, s) {
  food.tween('opacity', 0, s * 1000, { onDone: () => food.destroy() });
}

/**
 * Alguém ofereceu um item (game.useItem). O pet cheira e reage pelo que acha dele (id, categoria e
 * tags): adora → come rápido, ♥ e pula; gosta → come e ♥; neutro → come sem pressa; não gosta →
 * belisca e emburra; odeia → recusa e se afasta. Sem punição: não gostar só rende menos.
 * Devolve {consumed, level} a quem ofereceu (a loja/inventário vão usar).
 */
function onItem(self, item, game) {
  if (item.category !== 'comida') return { consumed: false, reason: 'naoComida' };
  if (pet.asleep) {
    observe(game, 'ofertaDormindo', '{n} está dormindo.', 1);
    return { consumed: false, reason: 'dormindo' };
  }
  if (pet.needs.fome > (T('apetite') < LOW ? 78 : 92)) {
    observe(game, 'semFome', '{n} não parece estar com fome agora.', 1);
    reveal('apetite', 'baixo');
    return { consumed: false, reason: 'satisfeito' };
  }
  // Uma comida ainda no chão (oferecida logo antes): termina aquela primeiro.
  terminarRefeicao(game, self, false);
  const r = me.prefs.item(item.id);
  const lembra = lembranca(item.id, 'comida');
  if (lembra <= -0.5) {
    // Já provou e detestou: reconhece de longe e nem cheira.
    naoGostou(game, self);
    observe(game, `reconheceu:${item.id}`, `{n} reconheceu ${oItem(item)} e virou o rosto.`);
    gostoVisto(game, item.id, r.level, 0.5);
    mind = { act: 'sulk', t: 1.4 };
    game.emit('reacao', { item: item.id, level: r.level, lembrou: true });
    return { consumed: false, level: r.level, reason: 'lembrou' };
  }
  // Primeira vez que este pet prova algo: descobrir rende moedas (incentiva experimentar).
  pet.provou = pet.provou || {};
  if (!pet.provou[item.id]) {
    pet.provou[item.id] = r.level;
    const como = { love: 'e adorou', like: 'e gostou', neutral: 'sem muito entusiasmo', dislike: 'e não gostou muito', hate: 'e recusou na hora' }[r.level];
    anotar(game, 'comida', `Provou ${oItem(item)} pela primeira vez ${como}.`, `provou:${item.id}`, r.level === 'love' || r.level === 'hate' ? 0.7 : 0.4);
    ganhar(game, 3, 'descoberta');
  }
  const dir = self.get('Sprite').flipX ? -1 : 1;
  const food = game.spawn('oferta', self.x + dir * 70, FEET_Y - 12);
  food.get('Text').text = item.icon || '•';
  const agora = gostoAgora(item);
  refeicao = { item, level: agora.level, base: agora.base, enjoado: agora.enjoado, fome: pet.needs.fome, food, dir };
  // Primeiro cheira (inclina a cabeça); a reação vem depois. O que ele lembra de ter adorado: nem precisa cheirar.
  if (lembra >= 0.5) {
    emote(game, self, '♥', '#ff8fab');
    observe(game, `reconheceu:${item.id}`, `{n} reconheceu ${oItem(item)} e se animou na hora!`);
  }
  mind = { act: lembra >= 0.5 ? 'happy' : 'investigate', t: lembra >= 0.5 ? 0.5 : 0.9, refeicao: true, then: () => react(game, self) };
  game.emit('reacao', { item: item.id, level: agora.level, ...(agora.enjoado && { enjoado: true }) });
  return { consumed: r.level !== 'hate', level: agora.level };
}

/** Depois de cheirar: recusa (odeia) ou come; o efeito vem no fim (terminarRefeicao). */
function react(game, self) {
  const { item, level, food, dir } = refeicao;
  if (level === 'hate') {
    refeicao = null;
    lembrar('comida', item.id, -1, 0.9);
    gostoVisto(game, item.id, 'hate');
    naoGostou(game, self);
    observe(game, `comida:${item.id}`, `{n} cheirou ${oItem(item)} e se afastou.`);
    sumir(food, 1.5);
    go(game, self.x - dir * 140, 'idle');
    return;
  }
  const eatFor = { love: 1.3, like: 2, neutral: 2.6, dislike: 1.4 }[level];
  mind = { act: 'eat', t: eatFor, refeicao: true, then: () => terminarRefeicao(game, self, true) };
}

/**
 * Fim da refeição: a comida some do chão e o pet fica com o que comeu. Também vale quando algo
 * interrompe (carinho, sono, outra comida...): ele já tinha decidido comer, então come — só não
 * troca a ação nova pela reação (`reagir` = false).
 */
function terminarRefeicao(game, self, reagir) {
  if (!refeicao) return;
  const { item, level, food, base, enjoado, fome } = refeicao;
  refeicao = null;
  sumir(food, 0.3);
  if (level === 'hate') return;
  // A memória e o diário ficam com o gosto de verdade (enjoar passa); repetir enjoa um pouco mais.
  const real = base || level;
  lembrar('comida', item.id, { love: 1, like: 0.5, neutral: 0.05, dislike: -0.6 }[real], { love: 0.8, like: 0.4, neutral: 0.2, dislike: 0.6 }[real]);
  lembrar('enjoo', item.id, 0, 0.3);
  gostoVisto(game, item.id, real);
  // A fome ensina: comer algo (que não detesta) com fome, várias vezes, faz gostar mais.
  if (fome !== undefined && fome < 50) me.prefs.learn(item.id, 0.8);
  const n = pet.needs;
  const part = level === 'dislike' ? 0.5 : 1;
  n.fome = clamp(n.fome + (Number(item.props.fome) || 10) * part);
  n.energia = clamp(n.energia + (Number(item.props.energia) || 0) * part);
  pet.care.petiscos++;
  game.playSound('sfx_comer');
  if (item.tags.includes('doce')) comeuDoce(game);
  const acabouDeMudar = mudouAgora.subject === item.id && realTime - mudouAgora.t < 5;
  if (enjoado && !acabouDeMudar) observe(game, `enjoou:${item.id}`, `{n} comeu ${oItem(item)}, mas parece estar enjoando um pouco.`, 30);
  if (enjoado && reagir) mind = { act: 'idle', t: 1 };
  if (enjoado) return;
  if (level === 'love') {
    n.afeto = clamp(n.afeto + 10);
    n.diversao = clamp(n.diversao + 5);
    reveal('apetite', 'alto');
    observe(game, `comida:${item.id}`, `{n} parece ter adorado ${oItem(item)}!`);
  } else if (level === 'like') {
    n.afeto = clamp(n.afeto + 5);
    observe(game, `comida:${item.id}`, `{n} parece ter gostado ${doItem(item)}.`);
  } else if (level === 'neutral') observe(game, `comida:${item.id}`, `{n} comeu ${oItem(item)} sem muito entusiasmo.`);
  else {
    observe(game, `comida:${item.id}`, `{n} comeu só um pouco ${doItem(item)}. Não parece ter gostado muito.`);
    if (reagir) naoGostou(game, me);
  }
  if (!reagir) return;
  if (level === 'love') {
    emote(game, self, '♥', '#ff8fab');
    self.after(300, () => emote(game, self, '♥', '#ff8fab'));
    mind = { act: 'happy', t: 1.4 };
  } else if (level === 'like') {
    emote(game, self, '♥', '#ff8fab');
    mind = { act: 'happy', t: 0.9 };
  } else if (level === 'neutral') mind = { act: 'idle', t: 1 };
  else mind = { act: 'sulk', t: 1.5 };
}

/**
 * O gosto por uma comida AGORA: o de sempre menos o enjoo de tê-la comido muitas vezes seguidas (memória
 * "enjoo", meia-vida curta). Só enjoa do que gosta ou adora (do indiferente não há o que enjoar), e enjoar só
 * desce até "não gosta" — recusar mesmo, só o que ele detesta.
 */
function gostoAgora(item) {
  const r = me.prefs.item(item.id);
  const enjoo = (me.memory.recall({ type: 'enjoo', subject: item.id })[0] || { strength: 0 }).strength;
  if ((r.level !== 'love' && r.level !== 'like') || enjoo < 0.05) return { level: r.level, base: r.level, enjoado: false };
  const ordem = ['hate', 'dislike', 'neutral', 'like', 'love'];
  const level = ordem[Math.max(1, ordem.indexOf(me.prefs.level(r.score - enjoo * 0.9)))];
  return { level, base: r.level, enjoado: level !== r.level };
}

/** Doce demais num dia faz mal (um pouco). */
function comeuDoce(game) {
  const day = Math.floor((game.clock.now + localOffset) / DAY);
  if (pet.treats.day !== day) pet.treats = { day, n: 0 };
  pet.treats.n++;
  if (pet.treats.n > DOCES_POR_DIA) {
    pet.needs.saude = clamp(pet.needs.saude - 2);
    observe(game, 'doceDemais', '{n} parece ter comido doce demais hoje.', 60);
  }
}

// ---------------------------------------------------------------- ciclo de vida do script

function onStart(self, game) {
  me = self;
  gameRef = game;
  const now = game.clock.now;
  localOffset = ((game.clock.hour * HOUR - (now % DAY)) % DAY + DAY) % DAY;
  const saved = game.storage.get('pet');
  if (saved && (saved.version === 1 || saved.version === 2)) {
    pet = saved.version === 1 ? migrateV1(saved) : saved;
    const away = now - pet.lastSeen;
    if (away > BIG_JUMP) {
      const s = catchUp(game, pet.lastSeen, now);
      awaySummary(game, away / HOUR, s);
    }
  } else {
    const fresh = game.storage.get('novoPet');
    pet = newPet(game, (fresh && fresh.nome) || 'Pet');
    game.storage.remove('novoPet');
    observe(game, 'nasceu', '{n} chegou! Observe com atenção.');
    anotar(game, 'evolucao', 'Chegou ao quarto.', 'nasceu', 1);
  }
  migrarDiario(game);
  const cfg = game.storage.get('config');
  if (cfg && cfg.speed) game.clock.speed = cfg.speed;
  lastNow = now;
  applyStage(self);
  luzDaLampada(game);
  self.x = pet.asleep ? xDeDormir(game) : 480;
  self.y = floorY();
  mind = pet.asleep ? { act: 'sleep' } : { act: 'idle', t: 1.5 };
  self.state.api = makeApi(game, self);
  game.vars.petName = pet.name;
  discover(game, pet.stage);
  economiaDoDia(game);
  save(game);
  // Timers da engine (tempo de jogo em frames, reproduzível): observações a cada 1 s, save a cada 3 s.
  self.every(1000, () => {
    economiaDoDia(game);
    if (mind.act === 'sleep' || mind.act === 'nap') sonoVisivel(game);
    checkObservations(game, self);
    bemNoQuarto(game, self);
    checkEvolution(game, self);
  }, 'observar');
  self.every(SAVE_EVERY * 1000, () => save(game), 'salvar');
}

function onUpdate(self, game, dt) {
  realTime += dt;
  anim += dt;
  const now = game.clock.now;
  const elapsed = now - lastNow;
  lastNow = now;

  if (elapsed > BIG_JUMP) {
    const s = catchUp(game, now - elapsed, now);
    awaySummary(game, elapsed / HOUR, s);
    if (!pet.asleep && mind.act === 'sleep') mind = { act: 'idle', t: 1 };
    if (pet.asleep && mind.act !== 'sleep') {
      self.x = xDeDormir(game);
      mind = { act: 'sleep' };
    }
  } else if (elapsed > 0) {
    decay(game, elapsed / HOUR, now);
  }

  if (pet.asleep && shouldWake(now)) wake(game, self, false);
  if (pet.asleep) {
    const h = Math.floor(game.clock.hour);
    if (h !== lastSleepHour) {
      lastSleepHour = h;
      me.routine.record('dormir');
    }
  }

  updateDirt(game);
  behave(self, game, dt);
  animate(self, game);

  game.vars.fome = Math.round(pet.needs.fome);
  game.vars.energia = Math.round(pet.needs.energia);
  game.vars.diversao = Math.round(pet.needs.diversao);
  game.vars.higiene = Math.round(pet.needs.higiene);
  game.vars.saude = Math.round(pet.needs.saude);
  game.vars.afeto = Math.round(pet.needs.afeto);
  // A atividade do momento é o estado da StateMachine: o agente vê state/stateMs e os eventos state_change.
  if (self.fsm.state !== mind.act) self.fsm.go(mind.act);
  game.vars.acao = mind.act;
  game.vars.estagio = pet.stage;
  game.vars.dormindo = pet.asleep;
  game.vars.doente = pet.sick;
  game.vars.tigela = pet.bowl;
}

function behave(self, game, dt) {
  // Algo interrompeu a refeição (a ação nova não faz parte dela): termina sem trocar a ação.
  if (refeicao && !mind.refeicao) terminarRefeicao(game, self, false);
  if (pet.asleep && mind.act !== 'sleep') mind = { act: 'sleep' };
  const act = mind.act;
  if (pet.cochilando && act !== 'nap') pet.cochilando = false; // algo interrompeu o cochilo
  if (act === 'sleep' || act === 'nap') {
    if (act === 'sleep' && !pet.asleep) return decide(game, self);
    // Dormindo bem: z devagar; mal: ~ mais vezes.
    const q = mind.q === undefined ? 0.6 : mind.q;
    const every = q < 0.4 ? 1.4 : q >= 0.7 ? 2.6 : 2;
    if (Math.floor(anim / every) !== Math.floor((anim - dt) / every)) emote(game, self, q < 0.4 ? '~' : 'z', q < 0.4 ? '#b8c4a8' : '#c9d6ff');
    if (act === 'sleep') return;
  }
  if (act === 'dance' && Math.floor(anim / 0.8) !== Math.floor((anim - dt) / 0.8)) emote(game, self, game.random() < 0.5 ? '♪' : '♫', '#8e7dff');
  if (act === 'walk') {
    const dx = mind.targetX - self.x;
    const stepX = speed() * (mind.pressa || 1) * dt;
    if (Math.abs(dx) <= stepX) {
      self.x = mind.targetX;
      const then = mind.then;
      if (typeof then === 'function') then();
      else arrive(game, self, then);
    } else {
      self.x += Math.sign(dx) * stepX;
      self.get('Sprite').flipX = dx < 0; // os desenhos olham para a direita
    }
    return;
  }
  if (act === 'chase') {
    const ball = game.entity('bola');
    if (!ball) return decide(game, self);
    const dx = ball.x - 50 - self.x;
    self.x += Math.sign(dx) * Math.min(Math.abs(dx), speed() * 1.4 * dt);
    self.get('Sprite').flipX = dx < 0;
    if (Math.abs(dx) < 8 && Math.abs(ball.state.vx || 0) < 20) arrive(game, self, 'chase');
    return;
  }
  if (act === 'toy') {
    // Brincando sozinho: fica junto do brinquedo (a bola rola, ele vai atrás) e mexe nele de tempos em tempos.
    const toy = game.entity(mind.what);
    if (!toy) return decide(game, self);
    const want = toy.x + (self.x <= toy.x ? -1 : 1) * 55;
    const dx = Math.max(MIN_X, Math.min(MAX_X, want)) - self.x;
    if (Math.abs(dx) > 6) self.x += Math.sign(dx) * Math.min(Math.abs(dx), speed() * 1.3 * dt);
    self.get('Sprite').flipX = toy.x < self.x;
    mind.tick -= dt;
    if (mind.tick <= 0) {
      mind.tick = MEXE_A_CADA[mind.jeito] || 2;
      mexerNo(game, self, toy);
    }
  }
  if (act === 'play' && Math.floor(anim * 1.5) !== Math.floor((anim - dt) * 1.5)) {
    const ball = game.entity('bola');
    if (ball && ball.state.push) ball.state.push((game.random() < 0.5 ? -1 : 1) * 80);
  }
  if (mind.t !== undefined) {
    mind.t -= dt;
    if (mind.t <= 0) {
      if (typeof mind.then === 'function') {
        const then = mind.then;
        then();
      } else if (['eat', 'lookBowl', 'play', 'toy'].includes(act)) finish(game, self);
      else decide(game, self);
    }
  }
}

function animate(self, game) {
  const s = self.get('Sprite');
  const st = STAGES[pet.stage];
  const slow = pet.sick || pet.asleep ? 0.4 : 1;
  // Os dois quadros de idle (bebê e jovens) são do Animator; doente ou dormindo, mais devagar.
  self.anim.speed = slow;
  let sx = 1;
  let sy = 1;
  let rot = 0;
  let y = floorY();
  const act = mind.act;
  const breathe = Math.sin(anim * 2.2 * slow) * 0.025;
  sx = 1 - breathe;
  sy = 1 + breathe;
  if (act === 'walk' || act === 'chase') {
    const hop = Math.abs(Math.sin(anim * lerp(7, 13, T('atividade'))));
    y -= hop * (pet.sick ? 3 : 9);
  } else if (act === 'sleep' || act === 'nap') {
    sy = 0.9 + Math.sin(anim * 1.2) * 0.02;
    sx = 1.05;
    y += st.size * 0.03;
    // Dormindo mal: se revira (balança e vira de lado de tempos em tempos).
    if ((mind.q === undefined ? 0.6 : mind.q) < 0.4) {
      rot = Math.sin(anim * 1.7) * 8;
      s.flipX = Math.floor(anim / 4) % 2 === 0;
    }
  } else if (act === 'dance') {
    y -= Math.abs(Math.sin(anim * 7)) * 14;
    rot = Math.sin(anim * 3.5) * 10;
  } else if (act === 'eat') {
    rot = Math.sin(anim * 10) * 4;
    y += 4;
  } else if (act === 'happy' || act === 'play' || act === 'greet') {
    y -= Math.abs(Math.sin(anim * 8)) * 16;
  } else if (act === 'yawn') {
    sy = 1 + Math.sin(Math.min(1, (1.6 - (mind.t || 0)) / 1.6) * Math.PI) * 0.12;
    sx = 2 - sy;
  } else if (act === 'toy' && (mind.jeito === 'favorito' || mind.jeito === 'gosta')) {
    // Com o favorito pula alto; com um que só gosta, pulinhos.
    y -= Math.abs(Math.sin(anim * 8)) * (mind.jeito === 'favorito' ? 20 : 9);
  } else if (act === 'lookBowl' || act === 'investigate' || act === 'toy') {
    rot = Math.sin(anim * 3) * 6;
  } else if (act === 'sulk') {
    sy = 0.94;
    rot = -4;
  } else if (act === 'evolve') {
    const k = 1 + Math.sin(anim * 20) * 0.08;
    sx = k;
    sy = k;
  }
  if (pet.sick && act !== 'sleep') rot += Math.sin(anim * 25) * 1.5;
  self.scaleX = sx;
  self.scaleY = sy;
  self.rotation = rot;
  self.y = y;
  s.opacity = 1;
}

/** Sujeira aparece conforme a higiene cai e só some quando é limpa (e é recriada ao reabrir o jogo). */
function updateDirt(game) {
  const h = pet.needs.higiene;
  const target = h < 25 ? 3 : h < 45 ? 2 : h < 70 ? 1 : 0;
  if (target > pet.dirt) pet.dirt = target;
  let existing = game.find('sujeira').length;
  while (existing < pet.dirt) {
    // Id estável (o primeiro livre: sujeira1, sujeira2...), para playbooks e testes clicarem nela.
    let k = 1;
    while (game.entity(`sujeira${k}`)) k++;
    game.spawn('sujeira', 160 + game.random() * 640, 452 + game.random() * 30, `sujeira${k}`);
    existing++;
  }
}

function checkObservations(game, self) {
  const n = pet.needs;
  const awake = !pet.asleep;
  if (pet.sick && observe(game, 'doente', '{n} não parece estar se sentindo bem.', 90, 0)) return emote(game, self, '~', '#9fd8a4');
  // Observações só contam o que se vê; decidir o que fazer é da UtilityAI (decide).
  if (awake && n.fome < 30 && observe(game, 'fome', '{n} parece estar com fome.', 90, 0)) return;
  if (awake && n.energia < 20 && observe(game, 'cansaco', n.energia < 10 ? '{n} parece estar muito cansado.' : '{n} está ficando cansado.', 90, 0)) return;
  if (awake && n.diversao < 30 && observe(game, 'tedio', '{n} parece entediado.', 120, 0)) return;
  if (awake && n.afeto < 30 && observe(game, 'saudade', '{n} parece estar com saudade de você.', 120, 0)) return;
  if (n.higiene < 30 && observe(game, 'sujo', '{n} parece incomodado com a sujeira.', 120, 0)) return;
  if (awake && Math.min(n.fome, n.energia, n.diversao, n.higiene, n.afeto) > 80 && observe(game, 'feliz', '{n} parece muito feliz!', 180, 0)) {
    ganhar(game, 2, 'feliz');
    emote(game, self, '♪', '#ffd166');
    mind = { act: 'happy', t: 1.5 };
  }
}

function onInteract(self, by, game) {
  self.state.api.carinho();
}
