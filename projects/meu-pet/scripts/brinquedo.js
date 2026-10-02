// Objeto do chão (props.item, do catálogo): brinquedos (pelúcia, chocalho) e coisas do quarto (cestinha,
// caixinha de música). ARRASTAR muda de lugar (tag "draggable": a engine o faz seguir o mouse) — ao soltar,
// cai de volta no chão e o lugar fica salvo (brinquedos.js); por isso o clique só conta quando o botão
// solta sem ter arrastado. Clicar: um brinquedo mexe e é mostrado ao pet; a caixinha liga/desliga a música.
// O que o objeto põe no ambiente (componente Ambient: conforto, música, ruído) vem das props do item.
const Y = 452;
const MIN_X = 70;
const MAX_X = 890;
const NOTAS = ['sfx_nota1', 'sfx_nota2', 'sfx_nota3', 'sfx_nota2'];
let apertou = false;
let arrastou = false;
let nota = 0;

function onStart(self, game) {
  const item = game.items.get(String(self.props.item));
  if (item) self.get('Text').text = item.icon || '?';
  const amb = self.get('Ambient');
  if (amb && item) {
    const p = item.props;
    amb.emits = {};
    for (const [k, prop] of [['comfort', 'conforto'], ['music', 'musica'], ['noise', 'ruido']]) if (p[prop]) amb.emits[k] = Number(p[prop]);
    if (p.raio) amb.radius = Number(p.raio);
  }
  self.state.mexer = () => {
    self.tween('rotation', 0, 500, { from: -25, ease: 'easeOut' });
    self.tween('y', Y, 350, { from: Y - 16, ease: 'easeOut' });
    if (item && item.tags.includes('barulhento') && !item.props.musica) game.playSound('sfx_guizo');
  };
  if (item && item.props.musica) {
    // Música: lembra se estava tocando (storage.quarto.musica).
    const quarto = game.storage.get('quarto') || {};
    tocar(self, game, !!quarto.musica, false);
  }
}

/** Liga/desliga a caixinha: Ambient ligado = música e um pouco de ruído pelo quarto; o pet reage. */
function tocar(self, game, on, avisar) {
  self.get('Ambient').enabled = on;
  self.props.tocando = on;
  const quarto = game.storage.get('quarto') || { brinquedos: {} };
  quarto.musica = on;
  game.storage.set('quarto', quarto);
  if (on) {
    self.every(700, () => {
      game.playSound(NOTAS[nota++ % NOTAS.length]);
      const e = game.spawn('emote', self.x + (game.random() - 0.5) * 30, self.y - 30);
      e.get('Text').text = nota % 2 ? '♪' : '♫';
      e.props.color = '#8e7dff';
    }, 'musica');
  } else self.cancel('musica');
  const pet = game.entity('pet');
  if (avisar && pet && pet.state.api && pet.state.api.musica) pet.state.api.musica(on, self.id);
}

function onClick(self) {
  apertou = true;
  arrastou = false;
}

function onUpdate(self, game) {
  if (!apertou) return;
  const drag = game.input.drag;
  if (drag && drag.entity === self.id) arrastou = true;
  if (game.input.mouseDown('left')) return;
  apertou = false;
  if (arrastou) {
    self.x = Math.max(MIN_X, Math.min(MAX_X, self.x));
    self.tween('y', Y, 300, { ease: 'easeOut' });
    const box = game.entity('brinquedos');
    if (box && box.state.mover) box.state.mover(self.id, self.x);
    return;
  }
  const item = game.items.get(String(self.props.item));
  if (item && item.props.musica) return tocar(self, game, !self.props.tocando, true);
  self.state.mexer();
  if (!item || item.category !== 'brinquedo') return;
  const pet = game.entity('pet');
  if (pet && pet.state.api) pet.state.api.brinquedoMostrado(self.id);
}
