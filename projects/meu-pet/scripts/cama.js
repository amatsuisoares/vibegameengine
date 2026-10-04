// A cama do quarto: há uma só, a que está em uso (storage.quarto.cama; padrão "camaSimples"). Camas são itens da
// categoria "cama" (a simples vem com o quarto; cestinha, quentinha e fresquinha na loja). Trocar na caixa de Coisas
// muda a cara da cama (cor, travesseiro, enfeite), o conforto que ela põe no quarto (Ambient) e o que o pet acha
// dela (props.item: o pet avalia pelo gosto). Comprar uma cama já a põe em uso. O pet confere a cama nova na hora.
//   state.emUso() -> id da cama em uso
//   state.equipar(id) -> troca (false se você não tem ou já está em uso)
const PADRAO = 'camaSimples';

function arranjo(game) {
  return game.storage.get('quarto') || { brinquedos: {} };
}

function emUso(game) {
  const id = arranjo(game).cama;
  return id && game.inventory().has(id) ? id : PADRAO;
}

function vestir(self, game, id) {
  const item = game.items.get(id);
  if (!item) return;
  const p = item.props || {};
  self.props.item = id;
  self.get('Sprite').color = p.cor || '#7b9acc';
  const amb = self.get('Ambient');
  if (amb) amb.emits.comfort = Number(p.conforto) || 0.6;
  const travesseiro = game.entity('travesseiro');
  if (travesseiro) travesseiro.get('Sprite').color = p.travesseiro || '#eef2fb';
  const enfeite = game.entity('camaEnfeite');
  if (enfeite) enfeite.get('Text').text = p.enfeite || '';
}

function equipar(self, game, id, como) {
  if (!game.inventory().has(id) || (emUso(game) === id && como !== 'novo')) return false;
  const a = arranjo(game);
  a.cama = id;
  game.storage.set('quarto', a);
  vestir(self, game, id);
  const pet = game.entity('pet');
  if (pet && pet.state.api && pet.state.api.brinquedoNovo) pet.state.api.brinquedoNovo(self.id, como);
  return true;
}

function onStart(self, game) {
  if (!game.inventory().has(PADRAO)) game.inventory().add(PADRAO, 1, 'quarto');
  // Saves de quando a cestinha ficava no chão: se ela estava no quarto, vira a cama em uso.
  const a = arranjo(game);
  const velha = a.brinquedos && a.brinquedos.cestinha;
  if (a.cama === undefined && velha && !velha.guardado && game.inventory().has('cestinha')) {
    a.cama = 'cestinha';
    game.storage.set('quarto', a);
  }
  vestir(self, game, emUso(game));
  self.state.emUso = () => emUso(game);
  self.state.equipar = (id) => equipar(self, game, String(id), 'trocou');
}

function onEvent(self, ev, game) {
  if (ev.type !== 'purchase') return;
  const item = game.items.get(String(ev.item));
  if (item && item.category === 'cama') equipar(self, game, item.id, 'novo');
}
