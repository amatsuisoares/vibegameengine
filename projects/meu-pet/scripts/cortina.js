// Cortina da janela (duas metades; props.lado: -1 esquerda, 1 direita). Clicar numa metade (ou no vidro da
// janela, ceu.js) abre ou fecha as duas. Fechada, tapa a luz do dia: a janela quase não ilumina (ceu.js) e o
// quarto escurece se a lâmpada estiver apagada; o pet reage pelo jeito dele com a claridade (api.cortina).
// O estado fica em storage.quarto.cortina e volta em toda sessão.
const CX = 250;
const FECHADA = { w: 92, dx: 44 };
const ABERTA = { w: 24, dx: 102 };

const fechada = (game) => !!(game.storage.get('quarto') || {}).cortina;

function onStart(self, game) {
  self.state.alternar = () => alternar(game);
  const alvo = fechada(game) ? FECHADA : ABERTA;
  self.get('Sprite').width = alvo.w;
  self.x = CX + self.props.lado * alvo.dx;
}

function alternar(game) {
  const quarto = game.storage.get('quarto') || { brinquedos: {} };
  quarto.cortina = !quarto.cortina;
  game.storage.set('quarto', quarto);
  game.playSound('sfx_clique');
  const pet = game.entity('pet');
  if (pet && pet.state.api && pet.state.api.cortina) pet.state.api.cortina(quarto.cortina);
}

/** Corre suave até a posição (aberta ou fechada). */
function onUpdate(self, game, dt) {
  const alvo = fechada(game) ? FECHADA : ABERTA;
  const s = self.get('Sprite');
  const k = Math.min(1, dt * 8);
  s.width += (alvo.w - s.width) * k;
  self.x += (CX + self.props.lado * alvo.dx - self.x) * k;
}

function onClick(self, game) {
  alternar(game);
}
