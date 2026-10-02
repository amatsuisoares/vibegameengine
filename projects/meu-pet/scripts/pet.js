// Cérebro do pet. Guarda o estado em game.storage ("pet"), simula as necessidades pelo
// relógio do jogo, escolhe o que o pet faz, fala do estado dele SÓ por observações
// ("Mimi parece estar com fome.") e expõe uma API (self.state.api) para os outros scripts.
//
// Quem o pet É fica nos componentes da entidade (scenes/quarto.json), não aqui:
//   Traits       8 eixos de personalidade 0..1, sorteados ao nascer (self.traits.get('atividade'))
//   Preferences  gostos por assunto (carinho, bola, petisco, ração, escuro...), inatos e puxados pelos traços
//   Persist      os dois ficam em storage.petIndividuo e voltam em toda sessão
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
  'sociabilidade:alto': 'muito apegado a você',
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
let lastNow = 0;
let localOffset = 0;
let anim = 0;
let lastNoteReal = -99;
let lastPetReal = -99;
let lastLookBowl = -99;
let realTime = 0;
const realCooldown = {};

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
    notes: [],
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

function seenTraits() {
  return Object.entries(pet.revealed)
    .filter(([k, c]) => c >= 3 && JEITO[k])
    .map(([k]) => JEITO[k]);
}

// ---------------------------------------------------------------- observações

/**
 * Mostra uma observação. kind agrupa mensagens parecidas: a mesma kind só volta depois
 * de `cooldownMin` minutos de jogo E de pelo menos 25 s reais (velocidades altas).
 */
function observe(game, kind, text, cooldownMin = 0) {
  const now = game.clock.now;
  if (cooldownMin > 0) {
    const last = pet.cooldowns[kind];
    if (last !== undefined && now - last < cooldownMin * 60000) return false;
    if (realCooldown[kind] !== undefined && realTime - realCooldown[kind] < 25) return false;
  }
  pet.cooldowns[kind] = now;
  realCooldown[kind] = realTime;
  lastNoteReal = realTime;
  const msg = text.replace('{n}', pet.name);
  pet.notes.push({ t: now, text: msg });
  if (pet.notes.length > 30) pet.notes.shift();
  game.emit('observacao', { kind, text: msg });
  return true;
}

/**
 * Sinal de personalidade: um comportamento típico de um traço forte ("alto" ou "baixo").
 * Só conta se o pet realmente é assim; depois de 3 sinais o diário passa a mencionar.
 */
function reveal(axis, dir) {
  const v = T(axis);
  if (dir === 'alto' ? v < HIGH : v > LOW) return;
  const k = `${axis}:${dir}`;
  pet.revealed[k] = (pet.revealed[k] || 0) + 1;
}

function emote(game, self, glyph, color) {
  const e = game.spawn('emote', self.x + (game.random() - 0.5) * 40, self.y - pet_size() * 0.32);
  const t = e.get('Text');
  t.text = glyph;
  if (color) e.props.color = color;
}

function pet_size() {
  return STAGES[pet.stage].size;
}

// ---------------------------------------------------------------- necessidades

function dark() {
  return !pet.lightOn;
}

/** Aplica `h` horas de vida às necessidades (linear; chamado em pedaços pequenos). */
function decay(game, h, at) {
  const n = pet.needs;
  const asleep = pet.asleep;
  n.fome -= h * (asleep ? 4 : 8) * lerp(0.75, 1.3, T('apetite'));
  if (asleep) n.energia += h * sleepRate(at);
  else n.energia -= h * 6 * lerp(0.8, 1.3, T('atividade')) * (pet.sick ? 1.5 : 1);
  const agitado = (T('atividade') + T('brincadeira')) / 2;
  n.diversao -= h * (asleep ? 1 : 7 * lerp(0.6, 1.5, agitado) * lerp(0.9, 1.2, T('curiosidade')));
  n.afeto -= h * (asleep ? 1 : 5 * lerp(0.4, 1.6, T('sociabilidade')) * lerp(1.25, 0.65, T('independencia')));
  n.higiene -= h * 3;
  const lowest = Math.min(n.fome, n.higiene, n.energia);
  if (pet.sick) n.saude -= h * 4;
  else if (lowest < 15) n.saude -= h * 3;
  else if (Math.min(n.fome, n.energia, n.diversao, n.higiene, n.afeto) > 40) n.saude += h * 2;
  for (const k of NEEDS) n[k] = clamp(n[k]);

  // Doença: chance por hora quando mal cuidado.
  if (!pet.sick && (n.higiene < 25 || n.fome < 10 || n.saude < 30)) {
    const p = 1 - Math.pow(1 - 0.15, h);
    if (game.random() < p) pet.sick = true;
  }

  // Média de bem-estar (decide a evolução): meia-vida de ~6 h.
  const now = (n.fome + n.energia + n.diversao + n.higiene + n.saude + n.afeto) / 6;
  const a = 1 - Math.pow(0.5, h / 6);
  pet.wellbeing += (now - pet.wellbeing) * a;
}

/**
 * Energia recuperada por hora de sono. Pets ativos recuperam mais rápido (dormem menos). A luz
 * acesa à noite atrapalha quem gosta de escuro e quase não incomoda quem prefere claridade; no
 * escuro, quem gosta dorme melhor e quem não gosta, pior.
 */
function sleepRate(at) {
  const escuro = me.prefs.of('escuro');
  let rate = 22;
  if (dark()) rate += 4 * escuro;
  else if (isNightAt(at)) rate -= 6 + 4 * escuro;
  return rate * lerp(0.85, 1.25, T('atividade'));
}

/** Luz acesa à noite só incomoda quem gosta de escuro (ou é muito sensível). */
function lightBothers() {
  return me.prefs.of('escuro') > 0.2 || T('sensibilidade') > 0.8;
}

/** Hora de dormir: cansado, ou de noite sem estar totalmente descansado. */
function sleepy(at) {
  const e = pet.needs.energia;
  return e < 25 || (isNightAt(at) && e < 85);
}

/** À noite só acorda de manhã (ou se for incomodado); de dia, quando descansou. */
function shouldWake(at) {
  const e = pet.needs.energia;
  if (isNightAt(at)) return false;
  const morning = hourAt(at) < 9;
  return e >= 95 || (morning && e >= 60);
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
    // Estilo de cuidado: mais brincadeira → linha 1; mais calma/carinho → linha 2.
    const c = pet.care;
    next = c.brincadeiras + c.petiscos * 0.5 >= c.carinhos + c.sonecas * 0.5 ? 'juvenil1' : 'juvenil2';
  } else if ((pet.stage === 'juvenil1' || pet.stage === 'juvenil2') && age >= ADULTO_AT) {
    const tier = pet.wellbeing >= 70 ? '1' : pet.wellbeing >= 45 ? '2' : '3';
    next = `adulto${tier}${pet.stage === 'juvenil1' ? 'a' : 'b'}`;
  }
  if (!next) return;
  pet.stage = next;
  applyStage(self);
  discover(game, next);
  mind = { act: 'evolve', t: 2.5 };
  observe(game, 'evolucao', '{n} cresceu!');
  if (isAdult()) observe(game, 'adulto', '{n} chegou à fase adulta! No Diário você pode começar com um novo pet.');
  game.emit('evolucao', { stage: next });
  game.playSound('sfx_evolucao');
  save(game);
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

/** O que a ração da tigela parece ao pet (ela é crocante). */
const racao = () => feel('racao', ['crocante']);
/** A bola é um brinquedo de correr. */
const bola = () => feel('bola', ['ativo']);
/** O petisco é doce. */
const petiscoGosto = () => feel('petisco', ['doce']);

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

/** Escolhe a próxima atividade pelas necessidades, a hora e a personalidade. */
function decide(game, self) {
  const n = pet.needs;
  if (sleepy(game.clock.now)) {
    mind = { act: 'yawn', t: 1.6, then: () => go(game, spot(game, 'cama'), 'sleep') };
    return;
  }
  const hungry = n.fome < hungerLimit();
  if (hungry && (pet.bowl > 0 || realTime - lastLookBowl > 20)) {
    go(game, spot(game, 'tigela') + 55, pet.bowl > 0 ? 'eat' : 'lookBowl');
    return;
  }
  if (hungry && game.random() < lerp(0.2, 0.8, T('sociabilidade'))) {
    // Tigela vazia e já olhou: quem é apegado vem até você.
    go(game, 480, 'greet');
    return;
  }
  const ball = game.entity('bola');
  // A escolha ponderada é da UtilityAI do pet (scenes/quarto.json): os pesos são expressões sobre as
  // necessidades (self.props), os traços (trait('atividade')) e os gostos (likes('bola')).
  sincronizarProps(self, ball);
  const choice = self.ai.decide();
  if (choice === 'passear') {
    go(game, MIN_X + game.random() * (MAX_X - MIN_X), 'idle');
    reveal('atividade', 'alto');
  }
  else if (choice === 'investigar') {
    const target = pick(game, ['janela', 'lampada', 'planta', 'cama']);
    go(game, spot(game, target) + (game.random() - 0.5) * 30, 'investigate');
    mind.what = target;
  } else if (choice === 'cumprimentar') go(game, 480, 'greet');
  else if (choice === 'brincar' && ball) go(game, ball.x - 60, 'toy');
  else if (choice === 'emburrar') {
    mind = { act: 'sulk', t: 4 };
    reveal('paciencia', 'baixo');
  } else {
    mind = { act: 'idle', t: 2 + game.random() * lerp(6, 2, T('atividade')) };
    reveal('atividade', 'baixo');
  }
}

/** Necessidades que as expressões da UtilityAI leem (self.props.fome...); traços e gostos elas leem direto. */
function sincronizarProps(self, ball) {
  const p = self.props;
  for (const k of NEEDS) p[k] = Math.round(pet.needs[k]);
  p.doente = pet.sick;
  p.temBola = !!ball;
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
    if (!isNightAt(game.clock.now)) reveal('atividade', 'baixo');
  } else if (then === 'investigate') {
    mind = { act: 'investigate', t: 2 + T('curiosidade') * 2, what: mind.what };
    reveal('curiosidade', 'alto');
    if (T('curiosidade') > HIGH && game.random() < 0.5) observe(game, 'curioso', '{n} parece estar procurando alguma coisa.', 120);
  } else if (then === 'greet') {
    mind = { act: 'greet', t: 3 };
    reveal('sociabilidade', 'alto');
    if (n.afeto < 40) observe(game, 'saudade', '{n} parece estar com saudade de você.', 90);
  } else if (then === 'toy') {
    mind = { act: 'toy', t: 2.5 };
    reveal('brincadeira', 'alto');
    reveal('independencia', 'alto');
    if (n.diversao < 50) observe(game, 'brinquedo', '{n} está olhando para o brinquedo.', 90);
  } else if (then === 'chase') {
    mind = { act: 'play', t: 4 };
  } else mind = { act: 'idle', t: 1.5 + game.random() * 2 };
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
    reveal('brincadeira', 'alto');
    if (b.level === 'love') {
      observe(game, 'brincou', '{n} ficou animado!', 20);
      emote(game, self, '♪', '#ffd166');
    } else if (b.level === 'like') {
      observe(game, 'brincou', '{n} parece ter gostado de brincar.', 20);
      emote(game, self, '♪', '#ffd166');
    } else observe(game, 'brincou', '{n} brincou um pouco com a bola.', 20);
  } else if (act === 'toy') {
    // Brincar sozinho com a bola: quem é independente se diverte mais assim.
    const ball = game.entity('bola');
    if (ball && ball.state.push) ball.state.push(60 + game.random() * 120);
    n.diversao = clamp(n.diversao + 8 * (1 + bola().score * 0.5) * lerp(0.7, 1.4, T('independencia')));
  }
  decide(game, self);
}

// ---------------------------------------------------------------- interações (API)

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
          observe(game, 'acordado', '{n} acordou e não parece gostar disso.', 5);
          wake(game, self, true);
          reveal('paciencia', 'baixo');
        } else observe(game, 'carinhoDormindo', '{n} se mexeu um pouco, ainda dormindo.', 10);
        return;
      }
      const recent = realTime - lastPetReal < 6;
      lastPetReal = realTime;
      if (impaciente && (n.energia < 40 || recent)) {
        n.afeto = clamp(n.afeto - 3);
        reveal('paciencia', 'baixo');
        observe(game, 'carinhoRuim', '{n} não parece gostar disso agora.', 2);
        mind = { act: 'sulk', t: 3 };
        return;
      }
      if (recent) {
        observe(game, 'carinhoDemais', '{n} não parece muito interessado.', 2);
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
        observe(game, 'carinho', level === 'love' ? '{n} parece adorar o carinho.' : '{n} parece gostar do carinho.', 2);
        mind = { act: 'happy', t: 1.2 };
      } else if (level === 'neutral') {
        n.afeto = clamp(n.afeto + 8);
        observe(game, 'carinho', '{n} aceitou o carinho, sem muita empolgação.', 2);
        mind = { act: 'idle', t: 1 };
      } else {
        // Não gosta: se afasta um pouco (afastar já diz muito; sem punição).
        n.afeto = clamp(n.afeto + 2);
        reveal('independencia', 'alto');
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
    petisco() {
      const n = pet.needs;
      if (pet.asleep) {
        observe(game, 'petiscoDormindo', '{n} está dormindo.', 1);
        return;
      }
      const day = Math.floor((game.clock.now + localOffset) / DAY);
      if (pet.treats.day !== day) pet.treats = { day, n: 0 };
      pet.treats.n++;
      if (pet.treats.n > 4 || n.fome > 95) {
        n.saude = clamp(n.saude - 2);
        observe(game, 'petiscoDemais', '{n} não parece muito interessado.', 2);
        return;
      }
      const g = petiscoGosto();
      if (g.level === 'hate') {
        // Recusa: cheira e se afasta. Não come, não perde nada.
        pet.treats.n--;
        observe(game, 'petiscoRecusa', '{n} cheirou o petisco e se afastou.', 2);
        go(game, self.x + (self.x < 480 ? -1 : 1) * 100, 'idle');
        return;
      }
      n.fome = clamp(n.fome + 10);
      pet.care.petiscos++;
      game.playSound('sfx_comer');
      if (g.level === 'love' || g.level === 'like') {
        n.afeto = clamp(n.afeto + (g.level === 'love' ? 12 : 8));
        n.diversao = clamp(n.diversao + 5);
        emote(game, self, '♥', '#ff8fab');
        reveal('apetite', 'alto');
        observe(game, 'petisco', g.level === 'love' ? '{n} parece ter adorado o petisco.' : '{n} parece ter gostado do petisco.', 2);
        mind = { act: 'happy', t: 1.2 };
      } else if (g.level === 'neutral') {
        n.afeto = clamp(n.afeto + 3);
        observe(game, 'petisco', '{n} comeu o petisco sem muito entusiasmo.', 2);
        mind = { act: 'idle', t: 1.2 };
      } else {
        observe(game, 'petisco', '{n} comeu o petisco, mas não parece ter gostado muito.', 2);
        mind = { act: 'sulk', t: 1.5 };
      }
    },
    remedio() {
      if (!pet.sick) {
        observe(game, 'remedioSemDoenca', '{n} não parece muito interessado.', 2);
        return;
      }
      pet.sick = false;
      pet.needs.saude = clamp(pet.needs.saude + 25);
      observe(game, 'remedio', '{n} parece estar se sentindo melhor.', 2);
    },
    bolaJogada(x) {
      const n = pet.needs;
      if (pet.asleep) return;
      const b = bola();
      const wants = n.energia > 20 && (n.diversao < 85 || T('brincadeira') > HIGH) && !pet.sick;
      if (!wants) {
        observe(game, 'semVontade', '{n} não parece muito interessado.', 5);
        return;
      }
      if (b.score <= -0.3) {
        // Olha a bola passar e fica onde está.
        reveal('brincadeira', 'baixo');
        observe(game, 'bolaNao', '{n} olhou a bola passar, mas não parece muito interessado nela.', 20);
        mind = { act: 'investigate', t: 1.5, what: 'bola' };
        return;
      }
      reveal('brincadeira', 'alto');
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
      if (pet.dirt === 0) observe(game, 'limpo', '{n} parece mais à vontade com o quarto limpo.', 60);
    },
    alternarLuz() {
      pet.lightOn = !pet.lightOn;
      if (pet.asleep && pet.lightOn && isNightAt(game.clock.now) && lightBothers()) {
        observe(game, 'luz', '{n} parece incomodado com a luz.', 30);
        reveal('sensibilidade', 'alto');
      }
      save(game);
    },
    diario() {
      return diaryText(game);
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

function diaryText(game) {
  const age = ageHours(game.clock.now);
  const days = Math.floor(age / 24);
  const hours = Math.floor(age % 24);
  const lines = [];
  lines.push(`Diário de ${pet.name}  ·  ${STAGES[pet.stage].label}`);
  lines.push(`Idade: ${days > 0 ? `${days} dia(s) e ` : ''}${hours} h`);
  const seen = seenTraits();
  lines.push(seen.length ? `Parece ser: ${seen.join(', ')}` : 'Personalidade: ainda observando...');
  if (isAdult()) lines.push('Fase adulta: você pode começar com um novo pet (botão abaixo).');
  lines.push('');
  lines.push('Últimas observações:');
  for (const note of pet.notes.slice(-6)) lines.push(`· ${note.text}`);
  lines.push('');
  lines.push('O jogo é salvo automaticamente.  (clique no diário para fechar)');
  return lines.join('\n');
}

// ---------------------------------------------------------------- ciclo de vida do script

function onStart(self, game) {
  me = self;
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
  }
  const cfg = game.storage.get('config');
  if (cfg && cfg.speed) game.clock.speed = cfg.speed;
  lastNow = now;
  applyStage(self);
  self.x = pet.asleep ? spot(game, 'cama') : 480;
  self.y = floorY();
  mind = pet.asleep ? { act: 'sleep' } : { act: 'idle', t: 1.5 };
  self.state.api = makeApi(game, self);
  game.vars.petName = pet.name;
  discover(game, pet.stage);
  save(game);
  // Timers da engine (tempo de jogo em frames, reproduzível): observações a cada 1 s, save a cada 3 s.
  self.every(1000, () => {
    checkObservations(game, self);
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
      self.x = spot(game, 'cama');
      mind = { act: 'sleep' };
    }
  } else if (elapsed > 0) {
    decay(game, elapsed / HOUR, now);
  }

  if (pet.asleep && shouldWake(now)) wake(game, self, false);

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
  if (pet.asleep && mind.act !== 'sleep') mind = { act: 'sleep' };
  const act = mind.act;
  if (act === 'sleep') {
    if (!pet.asleep) decide(game, self);
    else if (Math.floor(anim * 0.5) !== Math.floor((anim - dt) * 0.5)) emote(game, self, 'z', '#c9d6ff');
    return;
  }
  if (act === 'walk') {
    const dx = mind.targetX - self.x;
    const stepX = speed() * dt;
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
  } else if (act === 'sleep') {
    sy = 0.9 + Math.sin(anim * 1.2) * 0.02;
    sx = 1.05;
    y += st.size * 0.03;
  } else if (act === 'eat') {
    rot = Math.sin(anim * 10) * 4;
    y += 4;
  } else if (act === 'happy' || act === 'play' || act === 'greet') {
    y -= Math.abs(Math.sin(anim * 8)) * 16;
  } else if (act === 'yawn') {
    sy = 1 + Math.sin(Math.min(1, (1.6 - (mind.t || 0)) / 1.6) * Math.PI) * 0.12;
    sx = 2 - sy;
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
    game.spawn('sujeira', 160 + game.random() * 640, 452 + game.random() * 30);
    existing++;
  }
}

function checkObservations(game, self) {
  const n = pet.needs;
  if (realTime - lastNoteReal < 4) return; // não empilhar avisos
  const awake = !pet.asleep;
  if (pet.sick && observe(game, 'doente', '{n} não parece estar se sentindo bem.', 90)) return emote(game, self, '~', '#9fd8a4');
  if (awake && n.fome < 30 && observe(game, 'fome', '{n} parece estar com fome.', 90)) {
    if (mind.act === 'idle' && (pet.bowl > 0 || realTime - lastLookBowl > 20)) go(game, spot(game, 'tigela') + 55, pet.bowl > 0 ? 'eat' : 'lookBowl');
    return;
  }
  if (awake && n.energia < 20 && observe(game, 'cansaco', n.energia < 10 ? '{n} parece estar muito cansado.' : '{n} está ficando cansado.', 90)) {
    if (mind.act !== 'walk') mind = { act: 'yawn', t: 1.6, then: () => go(game, spot(game, 'cama'), 'sleep') };
    return;
  }
  if (awake && n.diversao < 30 && observe(game, 'tedio', '{n} parece entediado.', 120)) return;
  if (awake && n.afeto < 30 && observe(game, 'saudade', '{n} parece estar com saudade de você.', 120)) {
    if (mind.act === 'idle') go(game, 480, 'greet');
    return;
  }
  if (n.higiene < 30 && observe(game, 'sujo', '{n} parece incomodado com a sujeira.', 120)) return;
  if (pet.asleep && pet.lightOn && isNightAt(game.clock.now) && lightBothers() && observe(game, 'luz', '{n} parece incomodado com a luz.', 60)) return;
  if (awake && Math.min(n.fome, n.energia, n.diversao, n.higiene, n.afeto) > 80 && observe(game, 'feliz', '{n} parece muito feliz!', 180)) {
    emote(game, self, '♪', '#ffd166');
    mind = { act: 'happy', t: 1.5 };
  }
}

function onInteract(self, by, game) {
  self.state.api.carinho();
}
