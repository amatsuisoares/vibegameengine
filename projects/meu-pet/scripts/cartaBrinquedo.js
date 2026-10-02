// Carta da caixa de brinquedos: guarda ou põe no quarto o brinquedo (props.item).
function onClick(self, game) {
  game.playSound('sfx_clique');
  const box = game.entity('caixa');
  if (box && box.state.alternar) box.state.alternar(String(self.props.item));
}
