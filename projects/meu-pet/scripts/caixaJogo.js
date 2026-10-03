// Caixa (ou tampa) do minigame Caixinhas: o clique vira a escolha (props.i = qual caixa).
function onClick(self, game) {
  const jogo = game.entity('jogo');
  if (jogo && jogo.state.escolher) jogo.state.escolher(self.props.i);
}
