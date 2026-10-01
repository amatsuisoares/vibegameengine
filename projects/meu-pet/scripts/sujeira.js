// Sujeira no chão: clicar limpa.
function onInteract(self, by, game) {
  self.particles.burst(14); // poeira (ParticleEmitter do prefab); as partículas ficam depois que a sujeira some
  const pet = game.entity('pet');
  if (pet && pet.state.api) pet.state.api.limpar(self.id);
  game.playSound('sfx_limpar');
}
