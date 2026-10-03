// Aba do diário (props.aba: jeito | gostos | historias): clicar troca a aba (game.vars.diarioAba); a ativa fica marcada.
function onUpdate(self, game) {
  const ativa = (game.vars.diarioAba || 'jeito') === self.props.aba;
  const t = self.get('Text');
  t.text = `${ativa ? '● ' : ''}${self.props.nome}`;
  t.color = ativa ? '#b5541c' : '#9a8b7a';
}

function onClick(self, game) {
  game.vars.diarioAba = self.props.aba;
  game.vars.diarioPagina = 0;
  game.playSound('sfx_clique');
}
