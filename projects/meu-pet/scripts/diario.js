// Diário: painel com idade, estágio, personalidade percebida e últimas observações.
// Abre/fecha pelo botão "Diário"; clicar no painel fecha.
function onUpdate(self, game) {
  const pet = game.entity('pet');
  const text = game.entity('diarioTexto');
  if (!pet || !pet.state.api || !text) return;
  text.get('Text').text = pet.state.api.diario();
}

function onClick(self, game) {
  for (const id of ['diario', 'diarioTexto', 'botaoNovoPet']) {
    const e = game.entity(id);
    if (e) e.enabled = false;
  }
}
