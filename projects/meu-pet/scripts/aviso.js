// Mostra as observações do jogo ("Mimi parece estar com fome."; evento "notification" do game.notify)
// uma de cada vez, numa faixa no topo.
const SHOW = 5; // segundos reais por aviso
let queue = [];
let current = null;
let timer = 0;

function onEvent(self, ev) {
  if (ev.type !== 'notification') return;
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
    // Com outro esperando, este fica menos (o que acabou de acontecer não chega atrasado).
    const show = queue.length ? Math.min(SHOW, Math.max(timer, 2.5)) : SHOW;
    const fadeIn = Math.min(1, timer / 0.3);
    const fadeOut = Math.min(1, (show - timer) / 0.6);
    const a = Math.max(0, Math.min(fadeIn, fadeOut));
    text.text = current.text;
    text.color = `rgba(255, 255, 255, ${a.toFixed(2)})`;
    if (panel) {
      panel.get('Sprite').visible = true;
      panel.get('Sprite').opacity = 0.55 * a;
    }
    if (timer >= show) current = null;
  } else {
    text.text = '';
    if (panel) panel.get('Sprite').visible = false;
  }
}
