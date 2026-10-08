// Caixa de coisas: o botão "Coisas" abre uma carta por brinquedo, coisa do quarto ou cama que você tem; clicar numa
// carta guarda (sai do quarto) ou põe de volta (brinquedos.js); numa cama, troca a cama em uso (cama.js: só uma). A caixa fica aberta para arrumar
// vários; clicar no painel fecha. Como a bandeja, acha as cartas pela tag e começa fechada.
const COLS = 4;
const TAG = 'cartaBrinquedo';

function onStart(self, game) {
  self.state.toggle = () => (game.find(TAG).length ? fechar(self, game) : abrir(self, game));
  self.state.fechar = () => fechar(self, game);
  self.state.alternar = (id) => {
    const item = game.items.get(id);
    if (item && item.category === 'cama') {
      const cama = game.entity('cama');
      if (cama && cama.state.equipar) cama.state.equipar(id);
    } else {
      const box = game.entity('brinquedos');
      if (box && box.state.alternar) box.state.alternar(id);
    }
    atualizar(game);
  };
  fechar(self, game);
}

function atualizar(game) {
  for (const c of game.find(TAG)) {
    const item = game.items.get(String(c.props.item));
    const cama = game.entity('cama');
    const ehCama = item.category === 'cama';
    const noQuarto = ehCama ? !!cama && !!cama.state.emUso && cama.state.emUso() === item.id : !!game.entity(item.id);
    c.get('Text').text = `${item.icon || '?'} ${item.name}\n${ehCama ? (noQuarto ? 'em uso' : 'usar esta') : noQuarto ? 'no quarto' : 'guardado'}`;
    c.get('Sprite').color = noQuarto ? '#fffaf0' : '#b9b3a6';
  }
}

function abrir(self, game) {
  self.get('Sprite').visible = true;
  [...game.inventory().list({ category: 'cama' }), ...game.inventory().list({ category: 'brinquedo' }), ...game.inventory().list({ category: 'ambiente' })].forEach((e, i) => {
    const c = game.spawn('cartaBrinquedo', self.x - 165 + (i % COLS) * 110, self.y - 50 + Math.floor(i / COLS) * 86);
    c.props.item = e.item.id;
  });
  atualizar(game);
  const info = game.entity('caixaInfo');
  if (info) info.get('Text').text = `${game.input.touch ? 'Toque' : 'Clique'} para guardar ou pôr no quarto; numa cama, para usar essa. Arraste os brinquedos para mudar de lugar.`;
}

function fechar(self, game) {
  for (const c of game.find(TAG)) c.destroy();
  self.get('Sprite').visible = false;
  const info = game.entity('caixaInfo');
  if (info) info.get('Text').text = '';
}

function onClick(self, game) {
  fechar(self, game);
}
