// Tigela: clicar enche (3 porções). A ração aparece conforme o que sobrou.
function onClick(self, game) {
  const pet = game.entity('pet');
  if (pet && pet.state.api) pet.state.api.encherTigela();
}

function onUpdate(self, game) {
  const pet = game.entity('pet');
  const food = game.entity('racao');
  if (!pet || !pet.state.api || !food) return;
  const portions = pet.state.api.pet.bowl;
  const s = food.get('Sprite');
  s.visible = portions > 0;
  s.height = 4 + portions * 4;
  food.y = self.y - 10 - portions * 2;
}
