// Coleção ("pokédex"): as 9 formas (descobertas mostram o desenho e quem a revelou; as outras, "?")
// e a lista dos pets que já passaram por aqui.
const FORMS = [
  ['bebe', 'Bebê', 'bebe_1'],
  ['juvenil1', 'Jovem 1', 'juvenil1_1'],
  ['juvenil2', 'Jovem 2', 'juvenil2_1'],
  ['adulto1a', 'Adulto 1A', 'adulto1a'],
  ['adulto2a', 'Adulto 2A', 'adulto2a'],
  ['adulto3a', 'Adulto 3A', 'adulto3a'],
  ['adulto1b', 'Adulto 1B', 'adulto1b'],
  ['adulto2b', 'Adulto 2B', 'adulto2b'],
  ['adulto3b', 'Adulto 3B', 'adulto3b'],
];
const LABEL = Object.fromEntries(FORMS.map(([id, label]) => [id, label]));

function onStart(self, game) {
  const c = game.storage.get('colecao') || { formas: {}, pets: [] };
  let found = 0;
  FORMS.forEach(([id, label, asset], i) => {
    const x = 105 + (i % 3) * 150;
    const y = 135 + Math.floor(i / 3) * 135;
    game.spawn('carta', x, y);
    const seen = c.formas[id];
    if (seen) {
      found++;
      const fig = game.spawn('figura', x, y - 8);
      const s = fig.get('Sprite');
      s.asset = asset;
      if (id === 'bebe') s.width = s.height = 180; // o bebê ocupa pouco do desenho
      const name = game.spawn('rotulo', x, y + 50);
      name.get('Text').text = `${label} · ${seen.nome}`;
    } else {
      const q = game.spawn('rotulo', x, y - 8);
      q.get('Text').text = '?';
      q.get('Text').fontSize = 44;
      q.get('Text').color = '#6f6799';
      const name = game.spawn('rotulo', x, y + 50);
      name.get('Text').text = '???';
    }
  });

  const counter = game.entity('contador');
  if (counter) counter.get('Text').text = `${found} de ${FORMS.length} formas descobertas`;

  const list = game.entity('listaPets');
  if (list) {
    const pets = c.pets.slice().reverse();
    const lines = pets.length
      ? pets.slice(0, 12).map((p) => `${p.nome} — ${LABEL[p.forma] || p.forma} · ${p.dias} ${p.dias === 1 ? 'dia' : 'dias'}${p.jeito && p.jeito.length ? ` · ${p.jeito.join(', ')}` : ''}`)
      : ['Nenhum pet ainda.', '', 'Quando um pet chegar à fase adulta,', 'você pode começar com um novo pelo Diário', 'e ele fica guardado aqui.'];
    list.get('Text').text = lines.join('\n');
  }
}
