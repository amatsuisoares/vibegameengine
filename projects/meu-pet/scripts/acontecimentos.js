// Acontecimentos do quarto (componente Happenings da engine): de vez em quando algo quebra a rotina —
// um passarinho na janela, uma borboleta, um achado, uma amostra grátis, espirros. A engine sorteia
// (o baralho está na cena: um por vez, no relógio, nunca com ele dormindo, com intervalo real); aqui
// fica o que aparece, como cada jeito reage e o que é participar do jeito certo. Nada pune: ignorar só
// perde a chance (e os espirros, se ninguém der remédio, deixam a saúde mais fraca).
//
//   passarinho  pousa na janela e canta; com a cortina aberta ele vai ver (o sensível se assusta e olha
//               de longe) — atende: deixar ele ver (abrir a cortina); clicar espanta
//   borboleta   entra pela janela e voa pelo quarto; o ativo corre atrás, o calmo só olha — atende:
//               clicar nela e ela sai pela janela (correr atrás já diverte)
//   achado      ele fuça debaixo da cama / atrás da planta / num canto e acha algo (moedas ou um item que
//               você não tem) — atende: clicar no achado
//   amostra     uma caixinha na porta com uma comida que ele nunca provou — atende: abrir e oferecer
//   espirros    ele espirra de vez em quando (a saúde ou a limpeza andam baixas) — atende: remédio cedo,
//               que evita a doença (sem remédio, a saúde cai)

let coisa = null; // o que está na tela (passarinho, borboleta, achado, amostra)
let st = {}; // estado do acontecimento atual nesta sessão
let t = 0; // segundos reais desde que ele começou (ou desde que o jogo abriu com ele em curso)
let montado = null; // id do acontecimento já montado na tela

const JANELA = { x: 250, y: 140 };
const PEITORIL = { x: 318, y: 192 };
const LUGARES = [
  { x: 150, onde: 'debaixo da cama' },
  { x: 860, onde: 'atrás da planta' },
  { x: 620, onde: 'num canto do quarto' },
];

const api = (game) => {
  const p = game.entity('pet');
  return p && p.state.api;
};
const cortinaFechada = (game) => !!(game.storage.get('quarto') || {}).cortina;
const perto = (game, x, d = 90) => Math.abs(game.entity('pet').x - x) < d;

function onStart(self, game) {
  self.state.clicou = (id) => clicou(game, self, id);
  // Voltou com um acontecimento em curso (fechou o jogo no meio): monta de novo.
  const cur = self.happenings.current();
  if (cur) montar(game, self, cur, true);
}

function onEvent(self, ev, game) {
  if (ev.entity !== self.id) return;
  if (ev.type === 'happening_start') montar(game, self, ev, false);
  else if (ev.type === 'happening_end') terminar(game, self, ev);
}

function onUpdate(self, game, dt) {
  const cur = self.happenings.current();
  const p = api(game);
  if (!cur || !p) return;
  if (montado !== cur.id) montar(game, self, cur, false); // começou neste frame (o evento chega depois)
  if (!self.happenings.current()) return;
  t += dt;
  if (cur.kind === 'passarinho') passarinho(game, self, p, dt);
  else if (cur.kind === 'borboleta') borboleta(game, self, p, dt, cur);
  else if (cur.kind === 'achado') achado(game, self, p, cur, dt);
  else if (cur.kind === 'espirros') espirros(game, self, p);
  else if (cur.kind === 'amostra' && cur.data.aberta && (p.pet.provou || {})[cur.data.item]) self.happenings.end('provou'); // provou (gostando ou não)
}

// ---------------------------------------------------------------- começo e fim

function mostrar(game, id, glyph, x, y, size, layer) {
  const e = game.spawn('acontecimento', x, y, id);
  const tx = e.get('Text');
  tx.text = glyph;
  tx.fontSize = size;
  tx.layer = layer;
  e.get('Sprite').layer = layer;
  return e;
}

function montar(game, self, ev, voltando) {
  if (montado === ev.id) return;
  montado = ev.id;
  t = 0;
  st = {};
  if (coisa) coisa.destroy();
  coisa = null;
  const p = api(game);
  if (ev.kind === 'passarinho') {
    // Atrás do vidro (camada abaixo das cortinas): com a cortina fechada, só se ouve.
    coisa = mostrar(game, 'passarinho', '🐦', PEITORIL.x, PEITORIL.y, 32, -12);
    coisa.tween('y', PEITORIL.y - 5, 260, { yoyo: true, repeat: -1 });
    if (!voltando) {
      game.playSound('sfx_nota3');
      p.notar('passarinho', cortinaFechada(game) ? 'Tem um passarinho cantando lá fora.' : 'Um passarinho pousou na janela.', 0, 2);
    }
  } else if (ev.kind === 'borboleta') {
    coisa = mostrar(game, 'borboleta', '🦋', JANELA.x, JANELA.y, 34, 30);
    st.alvo = { x: 420, y: 260 };
    if (!voltando) p.notar('borboleta', cortinaFechada(game) ? 'Uma borboleta apareceu no quarto!' : 'Uma borboleta entrou pela janela!', 0, 2);
  } else if (ev.kind === 'achado') {
    const l = LUGARES.find((x) => x.onde === ev.data.onde) || LUGARES[Math.floor(game.random() * LUGARES.length)];
    if (!ev.data.onde) self.happenings.update({ onde: l.onde, x: l.x });
    st.lugar = l;
    if (ev.data.coisa) aparecerAchado(game, self, ev.data);
    else if (!voltando && p.livre()) {
      p.irAte(l.x, 'investigate', 4);
      p.notar('achado', `{n} está fuçando ${l.onde}...`, 0, 1);
    }
  } else if (ev.kind === 'amostra') {
    let item = ev.data.item && game.items.get(ev.data.item);
    if (!item) {
      const provou = p.pet.provou || {};
      const novas = game.items.list({ category: 'comida' }).filter((it) => it.id !== 'racao' && !provou[it.id]);
      const fora = novas.filter((it) => !game.inventory().has(it.id));
      const lista = fora.length ? fora : novas;
      if (!lista.length) return self.happenings.end('nada'); // já provou de tudo
      item = lista[Math.floor(game.random() * lista.length)];
      self.happenings.update({ item: item.id });
    }
    if (!ev.data.aberta) {
      coisa = mostrar(game, 'amostra', '🎁', 880, 456, 38, 9);
      if (!voltando) {
        game.playSound('sfx_clique');
        p.notar('amostra', 'Deixaram uma caixinha de amostra grátis na porta!', 0, 2);
        if (p.livre() && p.traco('curiosidade') > 0.45) p.irAte(830, 'investigate', 3);
      }
    }
  } else if (ev.kind === 'espirros') {
    st.prox = voltando ? 8 : 0;
  }
}

function sumir(e, x, y, ms = 1400) {
  if (!e) return;
  e.get('Interactable').enabled = false;
  if (x !== undefined) e.tween('x', x, ms, { ease: 'easeIn' });
  if (y !== undefined) e.tween('y', y, ms, { ease: 'easeIn' });
  e.tween('Text.opacity', 0, ms, { ease: 'easeIn', onDone: () => e.destroy() });
}

function terminar(game, self, ev) {
  const p = api(game);
  const c = coisa;
  coisa = null;
  if (!p) return c && c.destroy();
  const n = ev.outcome;
  if (ev.kind === 'passarinho') {
    sumir(c, PEITORIL.x + 120, PEITORIL.y - 80);
    if (n === 'visto') {
      if (st.medo) p.notar('passarinhoFim', '{n} olhou o passarinho de longe, meio desconfiado, até ele ir embora.', 0, 2);
      else p.notar('passarinhoFim', '{n} ficou olhando o passarinho até ele voar. Parece encantado.', 0, 2);
      p.premio({ diversao: 8, afeto: 4, vinculo: 0.04, lembrar: 'eventoBom', festa: !st.medo, diario: ['evento:passarinho', 'Viu um passarinho pousar na janela.'] });
      if (st.medo) p.revelar('sensibilidade', 'alto');
      else p.revelar('curiosidade', 'alto', 0.3);
    } else if (n === 'espantado') {
      p.notar('passarinhoFim', 'O passarinho se assustou e voou.', 0, 1);
      if (st.viu && !st.medo) p.reagir('?', '#ffd166');
    } else p.notar('passarinhoFim', cortinaFechada(game) ? 'O canto lá fora parou.' : 'O passarinho foi embora.', 0, 0);
  } else if (ev.kind === 'borboleta') {
    sumir(c, JANELA.x, JANELA.y - 20, 1800);
    const correu = (st.correu || 0) > 4;
    if (n === 'solta') {
      p.notar('borboletaFim', 'A borboleta voltou lá para fora. {n} ficou olhando ela ir.', 0, 2);
      p.premio({ diversao: correu ? 10 : 5, afeto: 3, vinculo: 0.04, lembrar: 'eventoBom', festa: correu, diario: ['evento:borboleta', 'Viu uma borboleta voar pelo quarto e você a soltou pela janela.'] });
    } else if (correu) {
      p.notar('borboletaFim', '{n} correu atrás da borboleta até ela ir embora. Parece ter se divertido.', 0, 1);
      p.premio({ diversao: 8 });
    } else p.notar('borboletaFim', 'A borboleta foi embora.', 0, 0);
    if (correu) p.revelar('atividade', 'alto', 0.3);
  } else if (ev.kind === 'achado') {
    if (n === 'pego') {
      p.premio({ afeto: 3, vinculo: 0.03, lembrar: 'eventoBom', festa: true, diario: ['evento:achado', `Achou ${ev.data.frase} ${ev.data.onde} e você pegou.`] });
      if (c) c.destroy();
    } else {
      sumir(c);
      if (ev.data.coisa) p.notar('achadoFim', '{n} perdeu o interesse no achado, e ele sumiu de novo.', 0, 0);
    }
  } else if (ev.kind === 'amostra') {
    if (n === 'provou') p.premio({ vinculo: 0.03, diario: ['evento:amostra', 'Provou uma amostra grátis que chegou na porta.'] });
    else if (c) {
      sumir(c);
      p.notar('amostraFim', 'Levaram a caixinha da amostra embora.', 0, 0);
    }
  } else if (ev.kind === 'espirros') {
    if (n === 'remedio') {
      p.notar('espirrosFim', '{n} parou de espirrar. Parece bem melhor.', 0, 2);
      p.premio({ saude: 20, vinculo: 0.04, lembrar: 'eventoBom', diario: ['evento:espirros', 'Começou a espirrar e você deu remédio logo.'] });
    } else if (n === 'expired' && !p.pet.sick) {
      p.premio({ saude: -15 });
      p.notar('espirrosFim', '{n} parou de espirrar, mas não parece muito bem.', 0, 1);
    }
  }
  st = {};
}

// ---------------------------------------------------------------- durante

function passarinho(game, self, p, dt) {
  if (Math.floor(t / 3.2) !== Math.floor((t - dt) / 3.2)) {
    const e = game.spawn('emote', PEITORIL.x, PEITORIL.y - 24);
    e.get('Text').text = '♪';
    e.props.color = '#8e7dff';
    if (Math.floor(t / 3.2) % 3 === 0) game.playSound('sfx_nota3');
  }
  if (p.pet.asleep) return;
  if (cortinaFechada(game)) {
    // Só se ouve: ele olha para a cortina (uma pista de que tem algo lá fora).
    if (!st.ouviu && t > 4.5 && p.livre()) { // depois do aviso do começo (o Notifier espaça os avisos)
      st.ouviu = true;
      p.irAte(JANELA.x + 10, 'investigate', 4);
      p.notar('passarinhoOuviu', '{n} está olhando para a cortina... parece ouvir alguma coisa lá fora.', 0, 1);
    }
    return;
  }
  if (!st.viu && p.livre()) {
    st.viu = true;
    if (p.traco('sensibilidade') > 0.75) {
      st.medo = true;
      p.susto();
      p.notar('passarinhoSusto', '{n} se assustou com o passarinho na janela.', 0, 2);
      self.after(1500, () => p.irAte(720, 'idle', 3)); // e se afasta da janela
    } else {
      p.irAte(PEITORIL.x - 30, p.traco('atividade') > 0.65 ? 'happy' : 'investigate', 6);
      if (p.traco('curiosidade') > 0.6) p.reagir('❗', '#ffd166');
    }
  }
  // Ver: perto da janela (o assustado, de longe) com a cortina aberta.
  if (st.viu && (st.medo || perto(game, PEITORIL.x, 120))) {
    st.visto = (st.visto || 0) + dt;
    if (st.visto >= 6) self.happenings.end('visto');
  }
}

function borboleta(game, self, p, dt, cur) {
  if (!coisa) return;
  const a = st.alvo || (st.alvo = { x: 400, y: 250 });
  if (st.saindo) {
    a.x = JANELA.x;
    a.y = JANELA.y;
  }
  const dx = a.x - coisa.x;
  const dy = a.y - coisa.y;
  const d = Math.hypot(dx, dy);
  const v = st.saindo ? 120 : 70;
  if (d < 12) {
    if (st.saindo) return self.happenings.end('solta');
    st.alvo = { x: 150 + game.random() * 650, y: 140 + game.random() * 230 };
  } else {
    coisa.x += (dx / d) * v * dt;
    coisa.y += (dy / d) * v * dt + Math.sin(t * 9) * 40 * dt;
  }
  coisa.get('Text').fontSize = 34 + Math.sin(t * 14) * 4; // batendo as asas
  if (p.pet.asleep || st.saindo) return;
  if (p.traco('atividade') > 0.55) {
    // Corre atrás (e pula).
    st.prox = (st.prox || 0) - dt;
    if (st.prox <= 0 && p.livre()) {
      st.prox = 1.4;
      p.irAte(coisa.x, 'happy', 0.6);
    }
    if (perto(game, coisa.x, 140)) st.correu = (st.correu || 0) + dt;
  } else if (!st.olhou && p.livre()) {
    st.olhou = true;
    p.fazer('investigate', 4, coisa.x);
    p.reagir('?', '#ffd166');
  }
  if (!st.avisou && t > 5) {
    st.avisou = true;
    if (p.traco('atividade') > 0.55) p.notar('borboletaPet', '{n} está correndo atrás da borboleta!', 0, 1);
    else p.notar('borboletaPet', '{n} está olhando a borboleta voar.', 0, 1);
  }
}

function aparecerAchado(game, self, data) {
  coisa = mostrar(game, 'achado', data.icone, data.x, 462, 32, 12);
  coisa.tween('y', 456, 500, { yoyo: true, repeat: -1 });
}

function achado(game, self, p, cur, dt) {
  if (cur.data.coisa) return;
  const l = st.lugar;
  // Ele chega lá e fuça um pouco; se não pode ir (comendo, dormindo...), aparece sozinho.
  if (perto(game, l.x, 80)) st.fucou = (st.fucou || 0) + dt;
  if ((st.fucou || 0) < 2.5 && t < 20) return;
  const fora = game.items.list().filter((it) => (it.category === 'brinquedo' || it.category === 'comida') && it.id !== 'racao' && it.price && !game.inventory().has(it.id));
  const item = fora.length && game.random() < 0.4 ? fora[Math.floor(game.random() * fora.length)] : null;
  const data = item
    ? { coisa: item.id, icone: item.icon || '✨', frase: `${item.props && item.props.artigo === 'a' ? 'uma' : 'um'} ${item.name.toLowerCase()}` }
    : { coisa: 'moedas', icone: '🪙', frase: 'umas moedas' };
  self.happenings.update(data);
  aparecerAchado(game, self, { ...data, x: l.x });
  game.playSound('sfx_guizo');
  if (perto(game, l.x, 80)) {
    p.reagir('❗', '#ffd166');
    p.notar('achou', `{n} achou alguma coisa ${l.onde}!`, 0, 2);
    p.revelar('curiosidade', 'alto', 0.3);
  } else p.notar('achou', `Tem alguma coisa brilhando ${l.onde}.`, 0, 1);
}

function espirros(game, self, p) {
  if (p.pet.sick) return self.happenings.end('doente');
  if (p.pet.asleep || t < st.prox) return;
  st.prox = t + 25 + game.random() * 20;
  p.reagir('💦', '#9ad1ff');
  if (p.livre()) p.fazer('sulk', 0.8);
  st.vezes = (st.vezes || 0) + 1;
  if (st.vezes === 1) p.notar('espirro', '{n} espirrou.', 0, 2);
  else p.notar('espirro', '{n} espirrou de novo. Talvez esteja ficando resfriado.', 0, 1);
}

// ---------------------------------------------------------------- cliques

function clicou(game, self, id) {
  const cur = self.happenings.current();
  const p = api(game);
  if (!cur || !p) return;
  if (id === 'passarinho') self.happenings.end('espantado');
  else if (id === 'borboleta' && !st.saindo) {
    // Você a guia para fora: ela volta para a janela.
    st.saindo = true;
    game.playSound('sfx_clique');
  } else if (id === 'achado' && cur.data.coisa) {
    game.playSound('sfx_guizo');
    if (cur.data.coisa === 'moedas') {
      p.premio({ moedas: 4 });
      p.notar('achadoPego', 'Eram umas moedas! Foram para a sua carteira.', 0, 2);
    } else {
      game.inventory().add(cur.data.coisa, 1, 'achado');
      p.notar('achadoPego', `Era ${cur.data.frase}! Agora é seu.`, 0, 2);
    }
    self.happenings.end('pego');
  } else if (id === 'amostra' && !cur.data.aberta) {
    const item = game.items.get(cur.data.item);
    game.playSound('sfx_clique');
    game.inventory().add(item.id, 1, 'amostra');
    self.happenings.update({ aberta: true });
    if (coisa) coisa.destroy();
    coisa = null;
    p.notar('amostraAberta', `Era uma amostra de ${item.name.toLowerCase()}. Está na sua comida — ${p.pet.name} nunca provou.`, 0, 2);
  }
}
