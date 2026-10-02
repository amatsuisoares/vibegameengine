// Loja: o botão "Loja" abre uma carta por item à venda (o preço está no catálogo, items/); clicar
// compra uma unidade com moedas (game.shop.buy) e ela vai para o inventário. Clicar no painel fecha.
// Como a bandeja, acha as cartas pela tag no mundo: ao começar (também depois de um hot reload), fecha.
const MOEDA = 'moedas';
const COLS = 6;
const TAG = 'cartaLoja';

function onStart(self, game) {
  self.state.toggle = () => (game.find(TAG).length ? fechar(self, game) : abrir(self, game));
  self.state.fechar = () => fechar(self, game);
  self.state.comprar = (id) => comprar(self, game, id);
  fechar(self, game);
}

// Brinquedos (não consumíveis) só se compra uma vez: depois a carta diz que já é seu (no quarto ou na caixa).
const jaTem = (game, item) => !item.consumable && game.inventory().count(item.id) > 0;
const texto = (game, item) =>
  `${item.icon || '?'} ${item.name}\n${jaTem(game, item) ? 'já é seu' : `${item.price} 🪙 · tem ${game.inventory().count(item.id)}`}`;

function info(game, msg) {
  const t = game.entity('lojaInfo');
  if (t) t.get('Text').text = msg ? `${msg}     Você tem ${game.wallet.get(MOEDA)} 🪙` : '';
}

function abrir(self, game) {
  self.get('Sprite').visible = true;
  game.shop.list().forEach((item, i) => {
    const c = game.spawn('cartaLoja', self.x - 262 + (i % COLS) * 105, self.y - 65 + Math.floor(i / COLS) * 90);
    c.get('Text').text = texto(game, item);
    c.props.item = item.id;
  });
  info(game, 'Clique para comprar.');
}

function comprar(self, game, id) {
  const item = game.items.get(id);
  if (jaTem(game, item)) {
    info(game, `${item.name} já é seu (veja em Brinquedos).`);
    return;
  }
  const r = game.shop.buy(id, { currency: MOEDA });
  if (r.ok) {
    game.playSound('sfx_tigela');
    info(game, `Comprou: ${item.name}.`);
  } else info(game, r.reason === 'funds' ? `Faltam moedas para ${item.name.toLowerCase()}.` : 'Isso não está à venda.');
  for (const c of game.find(TAG)) c.get('Text').text = texto(game, game.items.get(c.props.item));
}

function fechar(self, game) {
  for (const c of game.find(TAG)) c.destroy();
  self.get('Sprite').visible = false;
  info(game, '');
}

function onClick(self, game) {
  fechar(self, game);
}
