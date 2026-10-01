// Sujeira no chão: clicar limpa.
function onClick(self, game) {
  const pet = game.entity('pet');
  if (pet && pet.state.api) pet.state.api.limpar(self.id);
  game.playSound('sfx_limpar');
}
