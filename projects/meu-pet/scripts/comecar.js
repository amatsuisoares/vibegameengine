// Botão "Começar" da tela inicial (o mesmo que apertar Enter).
function onClick(self, game) {
  const title = game.entity('titulo');
  if (title && title.state.start) title.state.start();
}
