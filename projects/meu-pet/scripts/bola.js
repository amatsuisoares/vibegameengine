// Bola: clicar joga a bola pelo quarto; ela rola com atrito e quica nas paredes.
// O pet empurra pela função self.state.push(v).
const FLOOR = 458;
const MIN_X = 70;
const MAX_X = 890;
let vx = 0;
let vy = 0;

function onStart(self) {
  self.state.vx = 0;
  self.state.push = (v) => {
    vx += v;
    if (self.y >= FLOOR) vy = -120;
  };
}

function onUpdate(self, game, dt) {
  vx *= Math.pow(0.35, dt);
  if (Math.abs(vx) < 5) vx = 0;
  self.x += vx * dt;
  if (self.x < MIN_X) {
    self.x = MIN_X;
    vx = Math.abs(vx) * 0.6;
  } else if (self.x > MAX_X) {
    self.x = MAX_X;
    vx = -Math.abs(vx) * 0.6;
  }
  vy += 1100 * dt;
  self.y += vy * dt;
  if (self.y >= FLOOR) {
    self.y = FLOOR;
    vy = Math.abs(vy) > 90 ? -Math.abs(vy) * 0.45 : 0;
  }
  self.rotation += vx * dt * 3;
  self.state.vx = vx;
}

function onInteract(self, by, game) {
  const dir = self.x < 480 ? 1 : -1;
  vx = dir * (280 + game.random() * 220);
  vy = -420;
  game.playSound('sfx_bola');
  const pet = game.entity('pet');
  if (pet && pet.state.api) pet.state.api.bolaJogada(self.x);
}
