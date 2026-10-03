// Seta do diário (props.dir: -1 volta, 1 avança; 0 = só mostra "página 1/2"). Aparece só quando a aba tem
// mais de uma página (o texto não cabe no papel).
function paginas(game) {
  const pet = game.entity('pet');
  return pet && pet.state.api ? pet.state.api.diarioPaginas() : 1;
}

function onUpdate(self, game) {
  const total = paginas(game);
  const atual = Math.min(game.vars.diarioPagina || 0, total - 1);
  const d = self.props.dir;
  const t = self.get('Text');
  if (total <= 1) t.text = '';
  else if (d === 0) t.text = `${atual + 1}/${total}`;
  else t.text = (d < 0 ? atual > 0 : atual < total - 1) ? (d < 0 ? '◀' : '▶') : '';
}

function onClick(self, game) {
  const total = paginas(game);
  if (!self.props.dir || total <= 1) return;
  const atual = Math.min(game.vars.diarioPagina || 0, total - 1);
  game.vars.diarioPagina = Math.max(0, Math.min(total - 1, atual + self.props.dir));
  game.playSound('sfx_clique');
}
