// Arrumação dos brinquedos: todo brinquedo que você TEM (inventário, categoria "brinquedo") fica no quarto
// ou guardado na caixa, e cada um no seu lugar. O arranjo fica em storage.quarto ({ brinquedos: { id:
// { guardado, x } } }) e volta em toda sessão. O prefab de cada um vem do catálogo (items/: a bola rola,
// os outros ficam no chão e podem ser arrastados). A bola vem com o quarto: na primeira vez, entra no inventário.
//   state.alternar(id) -> guarda / põe no quarto (a caixa de brinquedos usa); devolve se ficou no quarto
//   state.mover(id, x) -> um brinquedo arrastado caiu em x
// Um brinquedo que aparece (comprado ou tirado da caixa) é mostrado ao pet, que reage na hora.
const Y = 452;
const MIN_X = 70;
const MAX_X = 890;

const arranjo = (game) => game.storage.get('quarto') || { brinquedos: {} };
const lugar = (a, id) => a.brinquedos[id] || (a.brinquedos[id] = {});

function colocar(game, item, a) {
  const old = game.entity(item.id);
  if (old) return old;
  const saved = lugar(a, item.id).x;
  const x = Math.max(MIN_X, Math.min(MAX_X, saved !== undefined ? saved : Number(item.props.lugar) || 300));
  const toy = game.spawn(item.prefab || 'brinquedo', x, Y, item.id);
  toy.props.item = item.id;
  return toy;
}

function avisarPet(game, id, como) {
  const pet = game.entity('pet');
  if (pet && pet.state.api && pet.state.api.brinquedoNovo) pet.state.api.brinquedoNovo(id, como);
}

function onStart(self, game) {
  const a = arranjo(game);
  if (!a.bolaDada) {
    if (!game.inventory().has('bola')) game.inventory().add('bola', 1, 'quarto');
    a.bolaDada = true;
  }
  for (const e of game.inventory().list({ category: 'brinquedo' })) if (!lugar(a, e.item.id).guardado) colocar(game, e.item, a);
  game.storage.set('quarto', a);

  self.state.alternar = (id) => {
    const b = arranjo(game);
    const l = lugar(b, id);
    const toy = game.entity(id);
    if (toy) {
      l.x = Math.round(toy.x);
      l.guardado = true;
      toy.destroy();
    } else if (game.inventory().has(id)) {
      l.guardado = false;
      colocar(game, game.items.get(id), b);
    }
    game.storage.set('quarto', b);
    if (!toy) avisarPet(game, id, 'voltou');
    return !toy;
  };
  self.state.mover = (id, x) => {
    const b = arranjo(game);
    lugar(b, id).x = Math.round(x);
    game.storage.set('quarto', b);
  };
}

function onEvent(self, ev, game) {
  if (ev.type !== 'purchase') return;
  const item = game.items.get(String(ev.item));
  if (!item || item.category !== 'brinquedo') return;
  const a = arranjo(game);
  lugar(a, item.id).guardado = false;
  colocar(game, item, a);
  game.storage.set('quarto', a);
  avisarPet(game, item.id, 'novo');
}
