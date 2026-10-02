// Brinquedo do chão (props.item, do catálogo): a pelúcia, o chocalho... O pet brinca com ele quando a
// UtilityAI o escolhe (state.mexer). Clicar (e soltar sem arrastar) mexe nele e mostra ao pet; ARRASTAR
// muda de lugar (tag "draggable": a engine o faz seguir o mouse) — ao soltar, cai de volta no chão e o
// lugar fica salvo (brinquedos.js). Por isso o clique só conta quando o botão solta sem ter arrastado.
const Y = 452;
const MIN_X = 70;
const MAX_X = 890;
let apertou = false;
let arrastou = false;

function onStart(self, game) {
  const item = game.items.get(String(self.props.item));
  if (item) self.get('Text').text = item.icon || '?';
  self.state.mexer = () => {
    self.tween('rotation', 0, 500, { from: -25, ease: 'easeOut' });
    self.tween('y', Y, 350, { from: Y - 16, ease: 'easeOut' });
    if (item && item.tags.includes('barulhento')) game.playSound('sfx_guizo');
  };
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
  self.state.mexer();
  const pet = game.entity('pet');
  if (pet && pet.state.api) pet.state.api.brinquedoMostrado(self.id);
}
