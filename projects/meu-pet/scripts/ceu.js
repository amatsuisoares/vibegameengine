// Janela: o céu acompanha a hora do relógio do jogo; à noite o quarto escurece (menos com a luz acesa).
// Também atualiza o relógio no canto da tela.

/** Quão "noite" está: 0 de dia, 1 de madrugada, com transições ao entardecer e amanhecer. */
function nightness(h) {
  if (h >= 7 && h < 18) return 0;
  if (h >= 18 && h < 20) return (h - 18) / 2;
  if (h >= 5 && h < 7) return 1 - (h - 5) / 2;
  return 1;
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

function onUpdate(self, game) {
  const h = game.clock.hour;
  const n = nightness(h);
  self.get('Sprite').color = mix('#8fd3ff', '#14183a', n);

  const astro = game.entity('astro');
  if (astro) {
    const s = astro.get('Sprite');
    s.color = n > 0.5 ? '#f2f2e6' : '#ffd23f';
    s.width = s.height = n > 0.5 ? 26 : 34;
    // Atravessa a janela ao longo do dia (ou da noite).
    const t = n > 0.5 ? (((h + 6) % 24) / 13) : (h - 6) / 13;
    astro.x = self.x - 70 + Math.max(0, Math.min(1, t)) * 140;
    astro.y = self.y + 25 - Math.sin(Math.max(0, Math.min(1, t)) * Math.PI) * 45;
  }

  const pet = game.entity('pet');
  const lightOn = pet && pet.state.api ? pet.state.api.pet.lightOn : true;
  const overlay = game.entity('noite');
  if (overlay) overlay.get('Sprite').opacity = n * (lightOn ? 0.18 : 0.6) + (lightOn ? 0 : 0.1);

  const clock = game.entity('relogio');
  if (clock) {
    const hh = String(Math.floor(h)).padStart(2, '0');
    const mm = String(Math.floor((h % 1) * 60)).padStart(2, '0');
    const speed = game.clock.speed;
    clock.get('Text').text = `${hh}:${mm}${speed > 1 ? `  ·  ${speed}×` : ''}`;
  }
}
