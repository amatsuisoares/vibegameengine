// Diário: painel em abas (jeito, gostos, histórias) com o que você já percebeu do pet (pet.state.api.diario).
// Abre/fecha pelo botão "Diário"; as abas trocam o conteúdo; as setas (diarioSeta.js) trocam a página quando o
// texto não cabe no papel; clicar no resto do painel fecha.
const PARTES = ['diario', 'diarioTexto', 'diarioAba1', 'diarioAba2', 'diarioAba3', 'diarioAnt', 'diarioPag', 'diarioProx', 'botaoNovoPet'];

function onUpdate(self, game) {
  const pet = game.entity('pet');
  const text = game.entity('diarioTexto');
  if (!pet || !pet.state.api || !text) return;
  text.get('Text').text = pet.state.api.diario();
}

function onClick(self, game) {
  for (const id of PARTES) {
    const e = game.entity(id);
    if (e) e.enabled = false;
  }
}
