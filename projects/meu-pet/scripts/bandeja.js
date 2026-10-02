// Bandeja de comida: o botão "Comida" abre uma carta por comida que você TEM no inventário (com a
// quantidade); clicar numa carta oferece ao pet (game.useItem → onItem do pet), e só se ele comer
// a unidade sai do inventário. Sem comida: uma carta leva à Loja. Clicar no painel fecha.
// As cartas são achadas pela tag no mundo (não numa lista do script): um hot reload que recria a
// cena com a bandeja aberta não deixa carta órfã — ao começar, a bandeja limpa e fecha.
const COLS = 4;
const TAG = 'cartaComida';

function onStart(self, game) {
  self.state.toggle = () => (game.find(TAG).length ? fechar(self, game) : abrir(self, game));
  self.state.fechar = () => fechar(self, game);
  fechar(self, game);
}

function carta(game, self, i, text, item) {
  const c = game.spawn('cartaComida', self.x - 165 + (i % COLS) * 110, self.y - 43 + Math.floor(i / COLS) * 86);
  c.get('Text').text = text;
  c.props.item = item;
}

function abrir(self, game) {
  const owned = game.inventory().list({ category: 'comida' }).filter((e) => e.item.id !== 'racao');
  self.get('Sprite').visible = true;
  if (!owned.length) carta(game, self, 0, '🧺\nVazia: Loja', '');
  owned.forEach((e, i) => carta(game, self, i, `${e.item.icon || '?'} ×${e.count}\n${e.item.name}`, e.item.id));
  // O pet pode lembrar que dali vem coisa boa.
  const pet = game.entity('pet');
  if (pet && pet.state.api && pet.state.api.bandejaAberta) pet.state.api.bandejaAberta();
}

function fechar(self, game) {
  for (const c of game.find(TAG)) c.destroy();
  self.get('Sprite').visible = false;
}

function onClick(self, game) {
  fechar(self, game);
}
