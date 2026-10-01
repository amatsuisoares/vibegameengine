// Lâmpada: clicar acende ou apaga a luz do quarto (o pet dorme melhor no escuro).
function onClick(self, game) {
  const pet = game.entity('pet');
  if (pet && pet.state.api) pet.state.api.alternarLuz();
  game.playSound('sfx_clique');
}

function onUpdate(self, game) {
  const pet = game.entity('pet');
  if (!pet || !pet.state.api) return;
  const on = pet.state.api.pet.lightOn;
  self.get('Sprite').color = on ? '#ffe28a' : '#8c7a5b';
  const glow = game.entity('brilho');
  if (glow) glow.get('Sprite').visible = on;
}
