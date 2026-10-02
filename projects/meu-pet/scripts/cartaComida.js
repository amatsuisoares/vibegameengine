// Carta da bandeja: oferece a comida (props.item) ao pet; quem decide a reação é o pet (onItem).
// Só sai do inventário se ele comer. Carta sem item = bandeja vazia: abre a Loja.
function onClick(self, game) {
  const tray = game.entity('bandeja');
  if (tray && tray.state.fechar) tray.state.fechar();
  self.destroy(); // mesmo que a bandeja não a conheça (nunca fica uma carta solta)
  game.playSound('sfx_clique');
  const item = self.props.item;
  if (!item) {
    const shop = game.entity('loja');
    if (shop && shop.state.toggle) shop.state.toggle();
    return;
  }
  const r = game.useItem(item, 'pet');
  if (r.result && r.result.consumed) game.inventory().remove(item, 1, 'oferecido');
}
