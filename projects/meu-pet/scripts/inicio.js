// Tela inicial: com um pet salvo, vai direto ao quarto; senão, digite o nome e aperte Enter.
const MAX = 14;
let name = '';
let blink = 0;

function onStart(self, game) {
  if (game.storage.get('pet')) game.loadScene('quarto');
}

function start(game) {
  const clean = name.trim();
  if (!clean) {
    game.emit('nomeVazio');
    return;
  }
  game.storage.set('novoPet', { nome: clean });
  game.loadScene('quarto');
}

function onUpdate(self, game, dt) {
  blink += dt;
  for (const ch of game.input.text) {
    if (ch === '\b') name = name.slice(0, -1);
    else if (ch === '\n') return start(game);
    else if (name.length < MAX && ch >= ' ') name += ch;
  }
  const field = game.entity('campoNome');
  if (field) field.get('Text').text = name + (Math.floor(blink * 2) % 2 ? '|' : ' ');
  const hint = game.entity('dicaNome');
  if (hint) hint.get('Text').color = name.trim() ? '#ffffff' : '#9aa3c7';
  self.state.start = () => start(game);
}
