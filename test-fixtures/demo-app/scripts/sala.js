// The room: greets the saved pet (vars.petName is what the tests wait for).
function onStart(self, game) {
  const pet = game.storage.get('pet');
  game.vars.petName = pet ? pet.name : '';
  self.get('Text').text = `Olá, ${game.vars.petName}!`;
}
