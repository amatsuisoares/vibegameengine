// Carta da loja: compra uma unidade do item (props.item).
function onClick(self, game) {
  game.playSound('sfx_clique');
  const shop = game.entity('loja');
  if (shop && shop.state.comprar) shop.state.comprar(self.props.item);
}
