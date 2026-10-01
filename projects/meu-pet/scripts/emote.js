// Emote flutuante (z, ♥, ♪, ?, ~): sobe, balança e some. É só um efeito visual, nunca fala.
const DURATION = 1.6;
let life = 0;

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a.toFixed(2)})`;
}

function onUpdate(self, game, dt) {
  life += dt;
  self.y -= 28 * dt;
  self.x += Math.sin(life * 4) * 0.4;
  const a = Math.max(0, 1 - life / DURATION);
  self.get('Text').color = rgba(self.props.color || '#ffffff', a);
  if (life >= DURATION) self.destroy();
}
