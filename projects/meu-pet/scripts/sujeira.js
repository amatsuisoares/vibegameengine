// Sujeira no chão: clicar limpa.
function onInteract(self, by, game) {
  const pet = game.entity('pet');
  if (pet && pet.state.api) pet.state.api.limpar(self.id);
  game.playSound('sfx_limpar');
}
