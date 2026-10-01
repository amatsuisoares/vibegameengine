// Mostra as observações do jogo ("Mimi parece estar com fome.") uma de cada vez, numa faixa no topo.
const SHOW = 5; // segundos reais por aviso
let queue = [];
let current = null;
let timer = 0;

function onEvent(self, ev) {
  if (ev.type !== 'observacao') return;
  if (current && current.text === ev.text) return;
  if (queue.some((q) => q.text === ev.text)) return;
  queue.push({ text: ev.text });
  if (queue.length > 3) queue.shift(); // se muita coisa acontecer junto, fica só o mais recente
}

function onUpdate(self, game, dt) {
  const text = self.get('Text');
  const panel = game.entity('avisoFundo');
  if (!current && queue.length) {
    current = queue.shift();
    timer = 0;
  }
  if (current) {
    timer += dt;
    const fadeIn = Math.min(1, timer / 0.3);
    const fadeOut = Math.min(1, (SHOW - timer) / 0.6);
    const a = Math.max(0, Math.min(fadeIn, fadeOut));
    text.text = current.text;
    text.color = `rgba(255, 255, 255, ${a.toFixed(2)})`;
    if (panel) {
      panel.get('Sprite').visible = true;
      panel.get('Sprite').opacity = 0.55 * a;
    }
    if (timer >= SHOW) current = null;
  } else {
    text.text = '';
    if (panel) panel.get('Sprite').visible = false;
  }
}
