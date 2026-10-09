// Name screen of the exported-app tests: type a name and press Enter (on a phone, a tap opens the keyboard).
// The name is saved (game.storage) and the next session starts straight in the room.
const MAX = 14;
let name = '';

function onStart(self, game) {
  if (game.storage.get('pet')) game.loadScene('sala');
}

function onUpdate(self, game) {
  for (const ch of game.input.text) {
    if (ch === '\b') name = name.slice(0, -1);
    else if (ch === '\n' && name.trim()) {
      game.storage.set('pet', { name: name.trim() });
      game.emit('nomeado');
      game.loadScene('sala');
      return;
    } else if (ch >= ' ' && name.length < MAX) name += ch;
  }
  game.entity('campoNome').get('Text').text = `${name}|`;
  game.entity('dicaNome').get('Text').text = game.input.touch ? 'Toque na tela para digitar o nome' : 'Digite o nome e aperte Enter';
}
