// Comida oferecida, no chão. Quem a tira é o pet (ao comer ou recusar); isto é só uma rede de
// segurança: se ninguém tirar (hot reload, save slot recriando a cena), ela some sozinha.
const VIDA = 8000;

function onStart(self) {
  self.after(VIDA, () => self.tween('opacity', 0, 400, { onDone: () => self.destroy() }), 'sumir');
}
