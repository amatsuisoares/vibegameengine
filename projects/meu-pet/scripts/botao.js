// Botão. props.acao: comida | loja | remedio | diario | velocidade | colecao | novoPet | voltar.
const SPEEDS = [1, 60, 600];
const MOEDA = 'moedas';
let confirmUntil = -1;
let time = 0;

function inside(self, game) {
  const m = game.input.mouseWorld;
  const s = self.get('Sprite');
  return Math.abs(m.x - self.x) <= s.width / 2 && Math.abs(m.y - self.y) <= s.height / 2;
}

function onStart(self) {
  self.state.base = self.get('Sprite').color;
  self.state.label = self.get('Text').text;
}

function onUpdate(self, game, dt) {
  time += dt;
  self.get('Sprite').color = inside(self, game) ? '#5b8def' : self.state.base;
  if (self.props.acao === 'velocidade') self.get('Text').text = `Velocidade ${game.clock.speed}×`;
  if (self.props.acao === 'loja') self.get('Text').text = `Loja · ${game.wallet.get(MOEDA)} 🪙`;
  if (self.props.acao === 'novoPet') {
    const confirming = time < confirmUntil;
    self.get('Text').text = confirming ? 'Tem certeza? Clique de novo' : self.state.label;
    if (confirming) self.get('Sprite').color = '#c2410c';
  }
}

/** Abre/fecha um painel de cartas (bandeja, loja) e fecha o outro. */
function painel(game, id, other) {
  const o = game.entity(other);
  if (o && o.state.fechar) o.state.fechar();
  const p = game.entity(id);
  if (p && p.state.toggle) p.state.toggle();
}

/** Ganhou moedas: "+N 🪙" sobe do botão da loja. */
function onEvent(self, ev, game) {
  if (self.props.acao !== 'loja' || ev.type !== 'currency_change' || ev.currency !== MOEDA || ev.delta <= 0) return;
  const e = game.spawn('emote', self.x, self.y - 6);
  e.get('Text').text = `+${ev.delta} 🪙`;
  e.get('Text').fontSize = 18;
  e.props.color = '#ffd166';
}

/** Mostra ou esconde o diário (painel, texto e o botão de novo pet, que só aparece na fase adulta). */
function toggleDiary(game, open) {
  const pet = game.entity('pet');
  const adult = !!(pet && pet.state.api && pet.state.api.adulto());
  for (const id of ['diario', 'diarioTexto']) {
    const e = game.entity(id);
    if (e) e.enabled = open;
  }
  const novo = game.entity('botaoNovoPet');
  if (novo) novo.enabled = open && adult;
}

function onClick(self, game) {
  const pet = game.entity('pet');
  const api = pet && pet.state.api;
  game.playSound('sfx_clique');
  switch (self.props.acao) {
    case 'comida':
      painel(game, 'bandeja', 'loja');
      break;
    case 'loja':
      painel(game, 'loja', 'bandeja');
      break;
    case 'remedio':
      if (api) api.remedio();
      break;
    case 'diario': {
      const d = game.entity('diario');
      toggleDiary(game, !(d && d.enabled));
      break;
    }
    case 'velocidade': {
      const i = SPEEDS.indexOf(game.clock.speed);
      game.clock.speed = SPEEDS[(i + 1) % SPEEDS.length];
      game.storage.set('config', { speed: game.clock.speed });
      break;
    }
    case 'colecao':
      if (api) api.salvar();
      game.vars.voltarPara = game.scene;
      game.loadScene('colecao');
      break;
    case 'voltar':
      game.loadScene(game.vars.voltarPara || (game.storage.get('pet') ? 'quarto' : 'inicio'));
      break;
    case 'novoPet':
      if (time < confirmUntil) {
        if (api) api.novoPet();
      } else confirmUntil = time + 4;
      break;
  }
}
