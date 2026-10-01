// Cérebro do pet. Guarda o estado em game.storage ("pet"), simula as necessidades pelo
// relógio do jogo, escolhe o que o pet faz, fala do estado dele SÓ por observações
// ("Mimi parece estar com fome.") e expõe uma API (self.state.api) para os outros scripts.

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MIN_X = 110;
const MAX_X = 850;
const SAVE_EVERY = 3; // segundos reais
const BIG_JUMP = 5 * 60000; // pulos de relógio maiores que isso viram "tempo fora"
const MAX_AWAY = 7 * DAY;

const JUVENIL_AT = 12; // horas de vida
const ADULTO_AT = 36;

const TRAITS = ['brincalhao', 'preguicoso', 'carinhoso', 'curioso', 'irritavel'];
const TRAIT_LABEL = { brincalhao: 'brincalhão', preguicoso: 'preguiçoso', carinhoso: 'carinhoso', curioso: 'curioso', irritavel: 'irritável' };

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
let mind; // comportamento do momento (não salvo)
let lastNow = 0;
let localOffset = 0;
let saveTimer = 0;
let checkTimer = 0;
let anim = 0;
let lastNoteReal = -99;
let lastPetReal = -99;
let lastLookBowl = -99;
let realTime = 0;
const realCooldown = {};

// ---------------------------------------------------------------- utilidades

const clamp = (v) => Math.max(0, Math.min(100, v));
const has = (t) => pet.traits.includes(t);
const hourAt = (t) => ((((t + localOffset) % DAY) + DAY) % DAY) / HOUR;
const isNightAt = (t) => {
  const h = hourAt(t);
  return h >= 22 || h < 7;
};
const ageHours = (now) => (now - pet.born) / HOUR;
const pick = (game, list) => list[Math.floor(game.random() * list.length)];

function weighted(game, options) {
  const total = options.reduce((s, o) => s + Math.max(0, o.w), 0);
  let r = game.random() * total;
  for (const o of options) {
    r -= Math.max(0, o.w);
    if (r <= 0) return o.id;
  }
  return options[options.length - 1].id;
}

// ---------------------------------------------------------------- criação e save

function newPet(game, name) {
  const traits = [pick(game, TRAITS)];
  if (game.random() < 0.6) {
    const second = pick(game, TRAITS.filter((t) => t !== traits[0]));
    traits.push(second);
  }
  return {
    version: 1,
    name,
    born: game.clock.now,
    stage: 'bebe',
    traits,
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
  return Object.entries(pet.revealed).filter(([, c]) => c >= 3).map(([t]) => TRAIT_LABEL[t]);
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

/** Sinais de personalidade: depois de alguns, o diário passa a mencionar o traço. */
function reveal(trait) {
  if (!has(trait)) return;
  pet.revealed[trait] = (pet.revealed[trait] || 0) + 1;
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
  n.fome -= h * (asleep ? 4 : 8);
  if (asleep) n.energia += h * (dark() || !isNightAt(at) ? 22 : 12);
  else n.energia -= h * 6 * (has('preguicoso') ? 1.4 : 1) * (pet.sick ? 1.5 : 1);
  n.diversao -= h * (asleep ? 1 : 7 * (has('brincalhao') ? 1.5 : has('curioso') ? 1.2 : 1));
  n.afeto -= h * (asleep ? 1 : 5 * (has('carinhoso') ? 1.5 : 1));
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
  if (!pet.asleep && n.fome < 50 && pet.bowl > 0) {
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

function speed() {
  let v = 90;
  if (has('brincalhao')) v *= 1.25;
  if (has('preguicoso')) v *= 0.7;
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
  if (n.fome < 45 && (pet.bowl > 0 || realTime - lastLookBowl > 20)) {
    go(game, spot(game, 'tigela') + 55, pet.bowl > 0 ? 'eat' : 'lookBowl');
    return;
  }
  if (n.fome < 45 && game.random() < 0.5) {
    // Tigela vazia e já olhou: vem até você.
    go(game, 480, 'greet');
    return;
  }
  const ball = game.entity('bola');
  const options = [
    { id: 'wander', w: 3 },
    { id: 'idle', w: has('preguicoso') ? 4 : 2 },
    { id: 'investigate', w: has('curioso') ? 3 : 0.7 },
    { id: 'greet', w: (has('carinhoso') ? 2.5 : 0.8) + (n.afeto < 40 ? 2 : 0) },
    { id: 'toy', w: ball && n.energia > 30 ? (has('brincalhao') ? 2.5 : 1) + (n.diversao < 40 ? 1.5 : 0) : 0 },
    { id: 'sulk', w: has('irritavel') && n.diversao < 50 ? 1.2 : 0 },
  ];
  if (pet.sick) options.push({ id: 'idle', w: 6 });
  const choice = weighted(game, options);
  if (choice === 'wander') go(game, MIN_X + game.random() * (MAX_X - MIN_X), 'idle');
  else if (choice === 'idle') mind = { act: 'idle', t: 2 + game.random() * (has('preguicoso') ? 6 : 3) };
  else if (choice === 'investigate') {
    const target = pick(game, ['janela', 'lampada', 'planta', 'cama']);
    go(game, spot(game, target) + (game.random() - 0.5) * 30, 'investigate');
    mind.what = target;
  } else if (choice === 'greet') go(game, 480, 'greet');
  else if (choice === 'toy') go(game, ball.x - 60, 'toy');
  else mind = { act: 'sulk', t: 4 };
}

function arrive(game, self, then) {
  const n = pet.needs;
  if (then === 'eat') {
    if (pet.bowl > 0) mind = { act: 'eat', t: 3 };
    else mind = { act: 'lookBowl', t: 2.5 };
  } else if (then === 'lookBowl') {
    mind = { act: 'lookBowl', t: 2.5 };
  } else if (then === 'sleep') {
    pet.asleep = true;
    pet.care.sonecas++;
    mind = { act: 'sleep' };
    observe(game, 'dormiu', '{n} adormeceu.', 60);
    reveal('preguicoso');
  } else if (then === 'investigate') {
    mind = { act: 'investigate', t: 3, what: mind.what };
    reveal('curioso');
    if (has('curioso') && game.random() < 0.5) observe(game, 'curioso', '{n} parece estar procurando alguma coisa.', 120);
  } else if (then === 'greet') {
    mind = { act: 'greet', t: 3 };
    reveal('carinhoso');
    if (n.afeto < 40) observe(game, 'saudade', '{n} parece estar com saudade de você.', 90);
  } else if (then === 'toy') {
    mind = { act: 'toy', t: 2.5 };
    reveal('brincalhao');
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
      observe(game, 'comeu', '{n} comeu da tigela.', 30);
      game.playSound('sfx_comer');
    }
  } else if (act === 'lookBowl') {
    lastLookBowl = realTime;
    observe(game, 'tigelaVazia', '{n} está olhando para a tigela vazia.', 60);
    emote(game, self, '?', '#f6e3a1');
  } else if (act === 'play') {
    n.diversao = clamp(n.diversao + 30);
    n.energia = clamp(n.energia - 8);
    n.afeto = clamp(n.afeto + 5);
    pet.care.brincadeiras++;
    reveal('brincalhao');
    observe(game, 'brincou', '{n} ficou animado!', 20);
    emote(game, self, '♪', '#ffd166');
  } else if (act === 'toy') {
    const ball = game.entity('bola');
    if (ball && ball.state.push) ball.state.push(60 + game.random() * 120);
    n.diversao = clamp(n.diversao + 8);
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
      emote(game, self, '♥', '#ff8fab');
      if (pet.asleep) {
        if (has('irritavel')) {
          observe(game, 'acordado', '{n} acordou e não parece gostar disso.', 5);
          wake(game, self, true);
          reveal('irritavel');
        } else observe(game, 'carinhoDormindo', '{n} se mexeu um pouco, ainda dormindo.', 10);
        return;
      }
      const recent = realTime - lastPetReal < 6;
      lastPetReal = realTime;
      if (has('irritavel') && (n.energia < 40 || recent)) {
        n.afeto = clamp(n.afeto - 3);
        reveal('irritavel');
        observe(game, 'carinhoRuim', '{n} não parece gostar disso agora.', 2);
        mind = { act: 'sulk', t: 3 };
        return;
      }
      if (recent) {
        observe(game, 'carinhoDemais', '{n} não parece muito interessado.', 2);
        return;
      }
      n.afeto = clamp(n.afeto + (has('carinhoso') ? 22 : 15));
      n.diversao = clamp(n.diversao + 3);
      pet.care.carinhos++;
      if (has('carinhoso')) reveal('carinhoso');
      observe(game, 'carinho', has('carinhoso') ? '{n} parece adorar o carinho.' : '{n} parece gostar do carinho.', 2);
      mind = { act: 'happy', t: 1.2 };
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
      n.fome = clamp(n.fome + 10);
      n.afeto = clamp(n.afeto + 8);
      n.diversao = clamp(n.diversao + 5);
      pet.care.petiscos++;
      observe(game, 'petisco', '{n} parece ter gostado do petisco.', 2);
      game.playSound('sfx_comer');
      emote(game, self, '♥', '#ff8fab');
      mind = { act: 'happy', t: 1.2 };
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
      const wants = n.energia > 20 && (n.diversao < 85 || has('brincalhao')) && !pet.sick;
      if (!wants) {
        observe(game, 'semVontade', '{n} não parece muito interessado.', 5);
        return;
      }
      if (has('brincalhao')) reveal('brincalhao');
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
      if (pet.asleep && pet.lightOn && isNightAt(game.clock.now)) observe(game, 'luz', '{n} parece incomodado com a luz.', 30);
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
  const now = game.clock.now;
  localOffset = ((game.clock.hour * HOUR - (now % DAY)) % DAY + DAY) % DAY;
  const saved = game.storage.get('pet');
  if (saved && saved.version === 1) {
    pet = saved;
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

  checkTimer += dt;
  if (checkTimer >= 1) {
    checkTimer = 0;
    checkObservations(game, self);
    checkEvolution(game, self);
  }
  saveTimer += dt;
  if (saveTimer >= SAVE_EVERY) {
    saveTimer = 0;
    save(game);
  }
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
  // Dois quadros de idle (bebê e jovens).
  if (st.frames.length > 1) s.asset = st.frames[Math.floor(anim * 2 * slow) % 2];
  let sx = 1;
  let sy = 1;
  let rot = 0;
  let y = floorY();
  const act = mind.act;
  const breathe = Math.sin(anim * 2.2 * slow) * 0.025;
  sx = 1 - breathe;
  sy = 1 + breathe;
  if (act === 'walk' || act === 'chase') {
    const hop = Math.abs(Math.sin(anim * (has('brincalhao') ? 12 : 9)));
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
  if (pet.asleep && pet.lightOn && isNightAt(game.clock.now) && observe(game, 'luz', '{n} parece incomodado com a luz.', 60)) return;
  if (awake && Math.min(n.fome, n.energia, n.diversao, n.higiene, n.afeto) > 80 && observe(game, 'feliz', '{n} parece muito feliz!', 180)) {
    emote(game, self, '♪', '#ffd166');
    mind = { act: 'happy', t: 1.5 };
  }
}

function onInteract(self, by, game) {
  self.state.api.carinho();
}
