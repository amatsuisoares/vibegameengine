// Bandeja de comida: o botão "Comida" abre uma carta por comida do catálogo (items/, categoria
// "comida"); clicar numa carta oferece ao pet (game.useItem → onItem do pet). Clicar no painel fecha.
const COLS = 4;
let cards = [];

function onStart(self, game) {
  self.state.toggle = () => (cards.length ? fechar(self) : abrir(self, game));
  self.state.fechar = () => fechar(self);
  self.get('Sprite').visible = false;
}

function abrir(self, game) {
  const foods = game.items.list({ category: 'comida' }).filter((i) => i.id !== 'racao');
  self.get('Sprite').visible = true;
  foods.forEach((item, i) => {
    const x = self.x - 165 + (i % COLS) * 110;
    const y = self.y - 43 + Math.floor(i / COLS) * 86;
    const c = game.spawn('cartaComida', x, y);
    c.get('Text').text = `${item.icon || '?'}\n${item.name}`;
    c.props.item = item.id;
    cards.push(c);
  });
}

function fechar(self) {
  for (const c of cards) c.destroy();
  cards = [];
  self.get('Sprite').visible = false;
}

function onClick(self) {
  fechar(self);
}
