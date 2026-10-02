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
function reveal(axis, dir) {
  const v = T(axis);
  if (dir === 'alto' ? v < HIGH : v > LOW) return;
  saber(gameRef, `jeito:${axis}:${dir}`, 0.5);
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
  anotar(game, 'evolucao', `Cresceu: agora é ${STAGES[next].label.toLowerCase()}.`, `estagio:${next}`, 1);
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
    mind = { act: 'yawn', t: 1.6, then: () => go(game, spot(game, 'cama'), 'sleep') };
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
    observe(game, `favorito:${item.id}`, `{n} brincou um tempão com ${oItem(item)}. Parece ser o brinquedo preferido.`, 30);
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
    emote(game, self, '…', '#cfd8dc');
    observe(game, `desconfiado:${item.id}`, `{n} ainda parece desconfiado ${doItem(item)}.`, 5);
    go(game, toy.x + lado * 260, 'idle');
    return;
  }
  if (jeito === 'nao' || barulhoIncomoda(item)) {
    const susto = barulhoIncomoda(item) && como !== 'novo';
    if (susto) assustou(game, item);
    const perto = () => {
      emote(game, self, susto ? '!' : '…', '#cfd8dc');
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
        emote(game, self, '…', '#cfd8dc');
        observe(game, 'aindaChateado', '{n} ainda parece chateado por ter sido acordado.', 5);
        go(game, self.x + (self.x < 480 ? -1 : 1) * 160, 'idle');
        return;
      }
      if (impaciente && (n.energia < 40 || recent)) {
        n.afeto = clamp(n.afeto - 3);
        reveal('paciencia', 'baixo');
        lembrar('carinho', 'voce', -0.6, 0.4);
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
        lembrar('carinho', 'voce', level === 'love' ? 1 : 0.6, 0.4);
        gostoVisto(game, 'carinho', level);
        anotar(game, 'lembranca', level === 'love' ? 'Recebeu o primeiro carinho e adorou.' : 'Recebeu o primeiro carinho e gostou.', 'carinho', 0.5);
        observe(game, 'carinho', level === 'love' ? '{n} parece adorar o carinho.' : '{n} parece gostar do carinho.', 2);
        mind = { act: 'happy', t: 1.2 };
      } else if (level === 'neutral') {
        n.afeto = clamp(n.afeto + 8);
        lembrar('carinho', 'voce', 0.1, 0.3);
        gostoVisto(game, 'carinho', level);
        anotar(game, 'lembranca', 'Recebeu o primeiro carinho, sem muita empolgação.', 'carinho', 0.4);
        observe(game, 'carinho', '{n} aceitou o carinho, sem muita empolgação.', 2);
        mind = { act: 'idle', t: 1 };
      } else {
        // Não gosta: se afasta um pouco (afastar já diz muito; sem punição).
        n.afeto = clamp(n.afeto + 2);
        reveal('independencia', 'alto');
        lembrar('carinho', 'voce', -0.4, 0.3);
        gostoVisto(game, 'carinho', level);
        anotar(game, 'lembranca', 'No primeiro carinho, se afastou: parece gostar do próprio espaço.', 'carinho', 0.5);
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
        observe(game, 'remedioSemDoenca', '{n} não parece muito interessado.', 2);
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
      verBrinquedo(game, self, id, como || 'novo');
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
        observe(game, 'semVontade', '{n} não parece muito interessado.', 5);
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
      if (pet.asleep && pet.lightOn && isNightAt(game.clock.now) && lightBothers()) {
        observe(game, 'luz', '{n} parece incomodado com a luz.', 30);
        gostoVisto(game, 'escuro', feel('escuro').level);
        reveal('sensibilidade', 'alto');
      }
      save(game);
    },
    /** O texto do diário na aba ("jeito" | "gostos" | "historias"; padrão: game.vars.diarioAba). */
    diario(aba) {
      return diaryText(game, aba || game.vars.diarioAba || 'jeito');
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
};
const VERBO = {
  love: ['adore', 'adorar', 'Adora'],
  like: ['goste de', 'gostar de', 'Gosta de'],
  neutral: ['não ligue muito para', 'não ligar muito para', 'Não liga muito para'],
  dislike: ['não goste de', 'não gostar de', 'Não gosta de'],
  hate: ['deteste', 'detestar', 'Detesta'],
};
const CONFIANCA = { possible: 0, observed: 1, confirmed: 2 };
const OUTROS = { carinho: 'carinho', escuro: 'dormir no escuro' };

function fraseJeito(level, jeito) {
  return [`Talvez seja ${jeito}.`, `Parece ser ${jeito}.`, `É ${jeito}.`][CONFIANCA[level]];
}

function fraseGosto(level, nivel, nome) {
  const v = VERBO[nivel];
  return [`Talvez ${v[0]} ${nome}.`, `Parece ${v[1]} ${nome}.`, `${v[2]} ${nome}.`][CONFIANCA[level]];
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
    if (item && item.category === 'brinquedo') brinquedos.push(`· ${fraseGosto(g.level, g.nivel, oItem(item))}`);
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
  if (brinquedos.length) lines.push('Brinquedos', ...brinquedos.slice(0, 4), '');
  if (outros.length) lines.push('Outras coisas', ...outros);
  if (!lines.length) lines.push('Ainda não deu para perceber do que gosta.', '', 'Ofereça comidas, mostre brinquedos, faça carinho — e observe.');
  return lines;
}

function abaHistorias(game) {
  const entries = me.journal.entries({ limit: 10 });
  if (!entries.length) return ['Nada aconteceu ainda.'];
  return entries.map((e) => `Dia ${Math.max(1, Math.floor((e.t - pet.born) / DAY) + 1)}  ·  ${e.text}`);
}

function diaryText(game, aba) {
  const body = aba === 'gostos' ? abaGostos(game) : aba === 'historias' ? abaHistorias(game) : abaJeito(game);
  return [`Diário de ${pet.name}`, '', ...body].join('\n');
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

/** Uma lembrança forte que se apagou também é parte da história. */
function onEvent(self, ev, game) {
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
  if (pet.needs.fome > 92) {
    observe(game, 'semFome', '{n} não parece estar com fome agora.', 1);
    return { consumed: false, reason: 'satisfeito' };
  }
  // Uma comida ainda no chão (oferecida logo antes): termina aquela primeiro.
  terminarRefeicao(game, self, false);
  const r = me.prefs.item(item.id);
  const lembra = lembranca(item.id, 'comida');
  if (lembra <= -0.5) {
    // Já provou e detestou: reconhece de longe e nem cheira.
    emote(game, self, '…', '#cfd8dc');
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
  refeicao = { item, level: r.level, food, dir };
  // Primeiro cheira (inclina a cabeça); a reação vem depois. O que ele lembra de ter adorado: nem precisa cheirar.
  if (lembra >= 0.5) {
    emote(game, self, '♥', '#ff8fab');
    observe(game, `reconheceu:${item.id}`, `{n} reconheceu ${oItem(item)} e se animou na hora!`);
  }
  mind = { act: lembra >= 0.5 ? 'happy' : 'investigate', t: lembra >= 0.5 ? 0.5 : 0.9, refeicao: true, then: () => react(game, self) };
  game.emit('reacao', { item: item.id, level: r.level });
  return { consumed: r.level !== 'hate', level: r.level };
}

/** Depois de cheirar: recusa (odeia) ou come; o efeito vem no fim (terminarRefeicao). */
function react(game, self) {
  const { item, level, food, dir } = refeicao;
  if (level === 'hate') {
    refeicao = null;
    lembrar('comida', item.id, -1, 0.9);
    gostoVisto(game, item.id, 'hate');
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
  const { item, level, food } = refeicao;
  refeicao = null;
  sumir(food, 0.3);
  if (level === 'hate') return;
  lembrar('comida', item.id, { love: 1, like: 0.5, neutral: 0.05, dislike: -0.6 }[level], { love: 0.8, like: 0.4, neutral: 0.2, dislike: 0.6 }[level]);
  gostoVisto(game, item.id, level);
  const n = pet.needs;
  const part = level === 'dislike' ? 0.5 : 1;
  n.fome = clamp(n.fome + (Number(item.props.fome) || 10) * part);
  n.energia = clamp(n.energia + (Number(item.props.energia) || 0) * part);
  pet.care.petiscos++;
  game.playSound('sfx_comer');
  if (item.tags.includes('doce')) comeuDoce(game);
  if (level === 'love') {
    n.afeto = clamp(n.afeto + 10);
    n.diversao = clamp(n.diversao + 5);
    reveal('apetite', 'alto');
    observe(game, `comida:${item.id}`, `{n} parece ter adorado ${oItem(item)}!`);
  } else if (level === 'like') {
    n.afeto = clamp(n.afeto + 5);
    observe(game, `comida:${item.id}`, `{n} parece ter gostado ${doItem(item)}.`);
  } else if (level === 'neutral') observe(game, `comida:${item.id}`, `{n} comeu ${oItem(item)} sem muito entusiasmo.`);
  else observe(game, `comida:${item.id}`, `{n} comeu só um pouco ${doItem(item)}. Não parece ter gostado muito.`);
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
  self.x = pet.asleep ? spot(game, 'cama') : 480;
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
  if (act === 'sleep') {
    if (!pet.asleep) decide(game, self);
    else if (Math.floor(anim * 0.5) !== Math.floor((anim - dt) * 0.5)) emote(game, self, 'z', '#c9d6ff');
    return;
  }
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
  if (pet.asleep && pet.lightOn && isNightAt(game.clock.now) && lightBothers() && observe(game, 'luz', '{n} parece incomodado com a luz.', 60, 0)) return gostoVisto(game, 'escuro', feel('escuro').level);
  if (awake && Math.min(n.fome, n.energia, n.diversao, n.higiene, n.afeto) > 80 && observe(game, 'feliz', '{n} parece muito feliz!', 180, 0)) {
    ganhar(game, 2, 'feliz');
    emote(game, self, '♪', '#ffd166');
    mind = { act: 'happy', t: 1.5 };
  }
}

function onInteract(self, by, game) {
  self.state.api.carinho();
}
