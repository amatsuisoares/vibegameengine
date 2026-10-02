// Carta da bandeja: oferece a comida (props.item) ao pet; quem decide a reação é o pet (onItem).
function onClick(self, game) {
  const tray = game.entity('bandeja');
  if (tray && tray.state.fechar) tray.state.fechar();
  game.playSound('sfx_clique');
  game.useItem(self.props.item, 'pet');
}
