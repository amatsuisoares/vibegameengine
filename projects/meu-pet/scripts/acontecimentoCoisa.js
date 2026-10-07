// Algo de um acontecimento na tela (passarinho, borboleta, achado, amostra): clicar avisa o diretor (acontecimentos.js).
function onInteract(self, by, game) {
  const d = game.entity('acontecimentos');
  if (d && d.state.clicou) d.state.clicou(self.id);
}
