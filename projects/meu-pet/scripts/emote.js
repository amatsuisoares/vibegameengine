// Emote flutuante (z, ♥, ♪, ?, ~): sobe, balança e some — com tweens da engine. É só um efeito visual, nunca fala.
const DURATION = 1600;

function onStart(self) {
  if (self.props.color) self.get('Text').color = self.props.color;
  self.tween('y', self.y - 45, DURATION, { ease: 'easeOut' });
  self.tween('x', self.x + 3, 250, { from: self.x - 3, yoyo: true, repeat: -1 });
  self.tween('opacity', 0, DURATION, { ease: 'easeIn', onDone: () => self.destroy() });
}
