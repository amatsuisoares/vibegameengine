import { fileURLToPath } from 'node:url';
import { captureHotState, Game, restoreHotState, type GameEvent } from '@vibe/engine';
import type { Project } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { ProjectStore, RuntimeHost } from '../src';
import { createAgentTools } from '../src/tools';

// Regression test of the real game in projects/meu-pet (read only): engine changes must keep it playable.
const MEU_PET = fileURLToPath(new URL('../../../projects/meu-pet', import.meta.url));

function load(): Project {
  const status = new ProjectStore(MEU_PET).validate();
  expect(status.errors).toEqual([]);
  return status.project!;
}

const pick = (events: GameEvent[], type: string) => events.filter((e) => e.type === type);

// Simulations of hours of game time: alone ~1 s each, but slower when the whole suite runs in parallel.
describe('meu-pet (regression)', { timeout: 20_000 }, () => {
  it('names a pet, then every object in the room is an Interactable that reacts to clicks, and an hours-long absence leaves dirt to clean', () => {
    const game = new Game(load(), { seed: 3, clock: { start: '2026-03-10T10:00:00Z' } });
    game.perform([{ type: 'wait', ms: 200 }, { type: 'type', text: 'Mimi\n' }, { type: 'wait', ms: 500 }]);
    expect(game.world.scene.id).toBe('quarto');
    expect(game.world.vars.petName).toBe('Mimi');

    const from = game.frame;
    game.perform([{ type: 'click', entity: 'tigela' }, { type: 'wait', ms: 100 }]);
    expect(game.world.vars.tigela).toBe(3);
    const light = (game.storage.get('pet') as { lightOn: boolean }).lightOn;
    game.perform([{ type: 'click', entity: 'lampada' }, { type: 'wait', ms: 100 }]);
    expect((game.storage.get('pet') as { lightOn: boolean }).lightOn).toBe(!light);
    // Reactions depend on who the pet is: this one is made to love being petted.
    const me = game.entity('pet')!;
    Object.assign(me.components.Traits!.values, { sociabilidade: 0.9, independencia: 0.1, paciencia: 0.8 });
    me.components.Preferences!.values.carinho = { innate: 0.9, learned: 0, n: 0 };
    game.perform([{ type: 'click', entity: 'bola' }, { type: 'wait', ms: 100 }, { type: 'click', entity: 'pet' }, { type: 'wait', ms: 100 }]);
    const events = game.events(from);
    expect(pick(events, 'click').map((e) => e.entity)).toEqual(['tigela', 'lampada', 'bola', 'pet']);
    expect(pick(events, 'interact').map((e) => [e.entity, e.action, e.via])).toEqual([
      ['tigela', 'encher', 'click'],
      ['lampada', 'luz', 'click'],
      ['bola', 'jogar', 'click'],
      ['pet', 'carinho', 'click'],
    ]);
    expect(pick(events, 'sound').map((e) => e.asset)).toEqual(expect.arrayContaining(['sfx_tigela', 'sfx_clique', 'sfx_bola']));
    expect(pick(events, 'spawn').some((e) => e.prefab === 'emote')).toBe(true); // the ♥ of the petting
    const heart = game.world.withTag('emote')[0];
    expect(game.getState({ ids: [heart.id] }).entities[0].tweens!.map((t) => t.prop).sort()).toEqual(['opacity', 'x', 'y']); // floats, sways, fades
    game.perform([{ type: 'wait', ms: 1700 }]);
    expect(game.entity(heart.id)).toBeUndefined(); // gone when faded out

    // Away for a day: hygiene drops and dirt appears; clicking it cleans one.
    game.apply({ op: 'advanceClock', ms: 24 * 3_600_000 });
    game.perform([{ type: 'wait', ms: 1000 }]);
    const dirt = game.world.withTag('sujeira');
    expect(dirt.length).toBeGreaterThan(0);
    game.perform([{ type: 'click', entity: dirt[0].id }, { type: 'wait', ms: 100 }]);
    expect(game.world.withTag('sujeira').length).toBe(dirt.length - 1);
    expect(game.events(0, 'interact').at(-1)).toMatchObject({ entity: dirt[0].id, action: 'limpar' });
    expect(game.events(0, 'particles').at(-1)).toMatchObject({ entity: dirt[0].id, count: 14 }); // a puff of dust
    expect(game.world.particles.particles.some((p) => p.owner === dirt[0].id)).toBe(true); // still settling after the dirt is gone

    game.perform([{ type: 'wait', ms: 60_000 }]);
    expect(game.status).toBe('running');
    expect(game.console.read(0, 'error')).toEqual([]);
    expect(game.events(0, 'script_error')).toEqual([]);

    // The pet's activity is its StateMachine state.
    const pet = game.getState({ ids: ['pet'] }).entities[0];
    expect(pet.state).toBe(game.world.vars.acao);
    const visited = new Set(game.events(0, 'state_change').filter((e) => e.entity === 'pet').map((e) => e.to));
    expect(visited.size).toBeGreaterThan(2);

    // Its weighted choice of activities is a UtilityAI fed by self.props (needs and traits).
    expect(pet.ai!.scores.passear).toBeCloseTo(0.4 + pet.traits!.atividade * 1.5 + 0.5 * (pet.habits?.passear ?? 0), 1); // trait() and habit() in the scores (habits fade a little since the decision)
    expect(pet.props).toMatchObject({ fome: expect.any(Number) });
    expect(Object.keys(pet.traits!).sort()).toEqual(['apetite', 'atividade', 'brincadeira', 'curiosidade', 'independencia', 'paciencia', 'sensibilidade', 'sociabilidade']);
    expect(game.events(0, 'ai_choice').filter((e) => e.entity === 'pet').length).toBeGreaterThan(1);

    // Observations and saving run on engine timers.
    expect(pet.timers!.map((t) => t.id).sort()).toEqual(['observar', 'salvar']);
    expect(game.events(0, 'notification').length).toBeGreaterThan(1);

    // Its idle frames come from the Animator (image frames of the current form, updated when it evolves).
    expect(pet.anim?.clip).toBe('idle');
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      game.step(5);
      seen.add(String(game.entity('pet')!.components.Sprite!.asset));
    }
    const form = String(game.world.vars.estagio); // it grew up during the day away
    expect(form).toMatch(/^juvenil/);
    expect([...seen].sort()).toEqual([`${form}_1`, `${form}_2`]);
  });


  it('a v1 save (yes/no traits) is migrated: traits become axes, signals and everything else are kept', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const v1 = {
      version: 1, name: 'Kuro', born: t - 5 * 3_600_000, stage: 'bebe', traits: ['brincalhao', 'preguicoso'],
      needs: { fome: 66, energia: 77, diversao: 55, higiene: 88, saude: 99, afeto: 44 }, sick: false, asleep: false, lightOn: true, bowl: 2, dirt: 0,
      care: { brincadeiras: 4, carinhos: 1, petiscos: 0, refeicoes: 3, sonecas: 1, limpezas: 0 }, wellbeing: 70, treats: { day: -1, n: 0 },
      revealed: { brincalhao: 3, irritavel: 1 }, cooldowns: {}, notes: [{ t, text: 'Kuro chegou! Observe com atenção.' }], lastSeen: t,
    };
    const colecao = { formas: { bebe: { nome: 'Kuro', em: t } }, pets: [] };
    const game = new Game(load(), { seed: 5, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z' }, storage: { pet: v1, colecao } });
    game.step(2);
    const pet = game.storage.get('pet') as Record<string, unknown>;
    expect(pet).toMatchObject({ version: 2, name: 'Kuro', stage: 'bebe', bowl: 2, care: v1.care, revealed: {} });
    // The old signals became what you know about it (3 signals = observed, 1 = possible), and its diary starts here.
    const known = game.getState({ ids: ['pet'] }).entities[0];
    expect(known.knowledge).toMatchObject({ 'jeito:brincadeira:alto': 'observed', 'jeito:paciencia:baixo': 'possible' });
    expect(known.journal!.last).toEqual(['Começou este diário.']);
    expect(pet.traits).toBeUndefined();
    expect((pet.needs as Record<string, number>).fome).toBeCloseTo(66, 0);
    const individual = game.storage.get('petIndividuo') as { traits: Record<string, number>; preferences: Record<string, unknown> };
    expect(individual.traits).toMatchObject({ brincadeira: 0.85, atividade: 0.15 }); // preguiçoso wins over brincalhão's 0.7
    expect(Object.keys(individual.preferences)).toEqual(expect.arrayContaining(['carinho', 'bola', 'racao', 'escuro']));
    expect(game.storage.get('colecao')).toEqual(colecao);
    game.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 100 }]);
    expect(game.entity('diarioTexto')!.components.Text!.text).toContain('Parece ser brincalhão.');
    expect(game.entity('diarioTexto')!.components.Text!.text).toContain('Talvez seja impaciente.');
    expect(game.console.read(0, 'error')).toEqual([]);

    // The next session loads the same individual (no new draw).
    const next = new Game(load(), { seed: 9, scene: 'quarto', clock: { start: '2026-03-10T10:05:00Z' }, storage: game.storage.snapshot() });
    next.step(2);
    expect(next.getState({ ids: ['pet'] }).entities[0].traits).toEqual(individual.traits);
    expect(next.events(0, 'individual')[0]).toMatchObject({ loaded: true, drawn: [] });
  });

  it('a new pet is a new individual, and two different individuals live their day differently', () => {
    const named = new Game(load(), { seed: 3, clock: { start: '2026-03-10T10:00:00Z' } });
    named.perform([{ type: 'wait', ms: 200 }, { type: 'type', text: 'Mimi\n' }, { type: 'wait', ms: 500 }]);
    const first = named.getState({ ids: ['pet'] }).entities[0].traits!;
    expect((named.storage.get('petIndividuo') as { traits: object }).traits).toEqual(first);

    const t = Date.parse('2026-03-10T10:00:00Z');
    const pet = (name: string) => ({
      version: 2, name, born: t, stage: 'bebe', needs: { fome: 90, energia: 95, diversao: 80, higiene: 95, saude: 100, afeto: 80 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, notes: [], lastSeen: t,
    });
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const live = (name: string, traits: Record<string, number>, preferences: Record<string, unknown>) => {
      const g = new Game(load(), { seed: 11, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z', speed: 60 }, storage: { pet: pet(name), petIndividuo: { version: 1, traits, preferences } } });
      // 3 h of game time, nobody around; the activity is sampled every game minute.
      const time: Record<string, number> = {};
      for (let m = 0; m < 180; m++) {
        g.step(60);
        time[String(g.world.vars.acao)] = (time[String(g.world.vars.acao)] ?? 0) + 1;
      }
      return { time, vars: g.world.vars, errors: g.console.read(0, 'error') };
    };
    const lively = live('Faísca', { atividade: 0.9, sociabilidade: 0.8, curiosidade: 0.9, independencia: 0.2, sensibilidade: 0.3, apetite: 0.8, paciencia: 0.7, brincadeira: 0.9 }, { bola: p(0.8), carinho: p(0.6) });
    const calm = live('Sereno', { atividade: 0.1, sociabilidade: 0.2, curiosidade: 0.1, independencia: 0.9, sensibilidade: 0.6, apetite: 0.2, paciencia: 0.8, brincadeira: 0.1 }, { bola: p(-0.6), carinho: p(-0.2) });
    expect(lively.errors).toEqual([]);
    expect(calm.errors).toEqual([]);
    // Minutes spent: the lively one plays and roams; the calm one mostly rests.
    const busy = (t: Record<string, number>) => (t.toy ?? 0) + (t.play ?? 0) + (t.walk ?? 0) + (t.investigate ?? 0);
    expect(busy(lively.time)).toBeGreaterThan(busy(calm.time) * 1.5);
    expect(calm.time.idle ?? 0).toBeGreaterThan((lively.time.idle ?? 0) * 2);
    expect(Number(lively.vars.afeto)).toBeLessThan(Number(calm.vars.afeto)); // a sociable pet misses you sooner
    expect(Number(lively.vars.fome)).toBeLessThan(Number(calm.vars.fome)); // and a greedy one gets hungry sooner
  });

  it('foods: a pet saved before the catalog only gets the new tastes drawn; the tray lists what you own; a full pet refuses without eating it', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const pet = {
      version: 2, name: 'Mimi', born: t, stage: 'bebe', needs: { fome: 95, energia: 80, diversao: 70, higiene: 90, saude: 100, afeto: 60 }, sick: false,
      asleep: false, lightOn: true, bowl: 0, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 70, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, notes: [], lastSeen: t,
    };
    const old = { version: 1, traits: { atividade: 0.5, sociabilidade: 0.5, curiosidade: 0.5, independencia: 0.5, sensibilidade: 0.5, apetite: 0.5, paciencia: 0.5, brincadeira: 0.5 }, preferences: { carinho: { innate: 0.42, learned: 0, n: 0 } } };
    const game = new Game(load(), { seed: 2, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z' }, storage: { pet, petIndividuo: old } });
    game.step(2);
    const drawn = game.events(0, 'individual')[0].drawn as string[];
    expect(drawn).toEqual(expect.arrayContaining(['fruta', 'laticinio', 'maca', 'peixe']));
    expect(drawn).not.toContain('carinho');
    expect(game.getState({ ids: ['pet'] }).entities[0].prefs!.carinho).toBe(0.42);

    game.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
    const cards = game.world.withTag('carta');
    // The welcome basket: one of each of four foods, in catalog order.
    expect(cards.map((c) => c.components.Script!.props.item)).toEqual(['biscoito', 'cenoura', 'leite', 'maca']);
    expect(cards.map((c) => c.components.Text!.text)).toContain('🍎 ×1\nMaçã');
    game.perform([{ type: 'click', x: 645, y: 349 }, { type: 'wait', ms: 3000 }]); // the apple card
    expect(game.world.withTag('carta')).toEqual([]); // the tray closed
    expect(game.events(0, 'item_used').at(-1)).toMatchObject({ item: 'maca', target: 'pet', category: 'comida' });
    expect(game.events(0, 'notification').at(-1)!.text).toBe('Mimi não parece estar com fome agora.');
    expect(game.events(0, 'reacao')).toEqual([]);
    expect(game.world.withTag('oferta')).toEqual([]);
    expect(game.economy.inventory().count('maca')).toBe(1); // refused: still yours
    expect(game.console.read(0, 'error')).toEqual([]);
  });

  it('economy: a welcome basket once, coins for a new day and for discovering a taste, buying in the shop, food leaves the bag only when eaten', () => {
    const game = new Game(load(), { seed: 4, clock: { start: '2026-03-10T10:00:00Z' } });
    game.perform([{ type: 'wait', ms: 200 }, { type: 'type', text: 'Mimi\n' }, { type: 'wait', ms: 500 }]);
    expect(game.getState().wallet).toEqual({ moedas: 15 });
    expect(game.getState().inventories).toEqual({ default: { maca: 1, cenoura: 1, leite: 1, biscoito: 1, bola: 1, camaSimples: 1 } }); // the ball comes with the room
    expect(game.entity('botaoLoja')!.components.Text!.text).toBe('Loja · 15 🪙');

    // Shop: 7 foods for sale; buy a fish (8) and two carrots (2 each); then not enough for cheese (6 > 3).
    game.perform([{ type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 50 }]);
    const shop = game.world.withTag('cartaLoja');
    expect(shop.map((c) => c.components.Script!.props.item)).toEqual(['banana', 'biscoito', 'caixinhaMusica', 'camaFria', 'camaQuentinha', 'cenoura', 'cestinha', 'chocalho', 'leite', 'maca', 'peixe', 'pelucia', 'queijo']);
    const at = (id: string) => shop.find((c) => c.components.Script!.props.item === id)!;
    for (const id of ['peixe', 'cenoura', 'cenoura', 'queijo']) game.perform([{ type: 'click', x: at(id).x, y: at(id).y }, { type: 'wait', ms: 50 }]);
    expect(game.getState().wallet).toEqual({ moedas: 3 });
    expect(game.economy.inventory().count('cenoura')).toBe(3);
    expect(game.events(0, 'purchase_failed').map((e) => [e.item, e.reason])).toEqual([['queijo', 'funds']]);
    expect(game.entity('lojaInfo')!.components.Text!.text).toMatch(/^Faltam moedas para queijo\..*Você tem 3 🪙$/);

    // A hungry pet, a food it was never offered: +3 for the discovery; the fish leaves the bag only if eaten.
    game.perform([{ type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 50 }]);
    game.apply({ op: 'advanceClock', ms: 4 * 3_600_000 });
    game.perform([{ type: 'wait', ms: 1500 }, { type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
    const fish = game.world.withTag('carta').find((c) => c.components.Script!.props.item === 'peixe')!;
    game.perform([{ type: 'click', x: fish.x, y: fish.y }, { type: 'wait', ms: 4000 }]);
    const reaction = game.events(0, 'reacao').at(-1)!;
    expect(reaction.item).toBe('peixe');
    expect(game.economy.inventory().count('peixe')).toBe(reaction.level === 'hate' ? 1 : 0);
    expect(game.events(0, 'currency_change').some((e) => e.reason === 'descoberta' && e.delta === 3)).toBe(true);

    // The next day: +10 once, no second basket.
    const coins = game.economy.wallet.get('moedas');
    game.apply({ op: 'advanceClock', ms: 24 * 3_600_000 });
    game.perform([{ type: 'wait', ms: 3000 }]);
    expect(game.economy.wallet.get('moedas')).toBe(coins + 10);
    expect(game.events(0, 'currency_change').filter((e) => e.reason === 'cesta')).toHaveLength(1);
    expect(game.console.read(0, 'error')).toEqual([]);
  });

  it('offered food never gets stuck on the floor: interrupted (petting, another food) the pet still eats it; a stray one fades by itself', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const pet = {
      version: 2, name: 'test1', born: t, stage: 'bebe', needs: { fome: 30, energia: 80, diversao: 70, higiene: 90, saude: 100, afeto: 60 }, sick: false,
      asleep: false, lightOn: true, bowl: 0, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 70, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, notes: [], lastSeen: t,
    };
    const individual = { version: 1, traits: { paciencia: 0.8 }, preferences: { cenoura: { innate: 0.5, learned: 0, n: 0 }, maca: { innate: 0.5, learned: 0, n: 0 } } };
    const start = (bag: Record<string, number>) =>
      new Game(load(), {
        seed: 1, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z' },
        storage: { pet, petIndividuo: individual, 'vibe.inventory': { default: bag }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
      });
    const offer = (x: number) => [{ type: 'click' as const, entity: 'botaoPetisco' }, { type: 'wait' as const, ms: 50 }, { type: 'click' as const, x, y: 349 }];

    // Report: a carrot given to "test1" stayed frozen on screen. Petting while it sniffs or eats used to strand it (and it was not eaten).
    for (const during of [300, 1400]) {
      const game = start({ cenoura: 1 });
      game.perform([{ type: 'wait', ms: 500 }, ...offer(315), { type: 'wait', ms: during }, { type: 'click', entity: 'pet' }, { type: 'wait', ms: 3000 }]);
      expect(game.world.withTag('oferta'), `petting after ${during} ms`).toEqual([]);
      expect(game.world.vars.fome).toBeGreaterThan(30); // eaten anyway
      expect(game.economy.inventory().count('cenoura')).toBe(0);
    }

    // A second food while the first is still on the floor: both are eaten, nothing stays.
    const game = start({ cenoura: 1, maca: 1 });
    game.perform([{ type: 'wait', ms: 500 }, ...offer(315), { type: 'wait', ms: 400 }, ...offer(315), { type: 'wait', ms: 5000 }]);
    expect(game.world.withTag('oferta')).toEqual([]);
    expect(game.events(0, 'reacao').map((e) => e.item)).toEqual(['cenoura', 'maca']);
    expect(game.economy.inventory().list({ category: 'comida' })).toEqual([]);
    expect(game.events(0, 'notification').filter((e) => String(e.kind).startsWith('comida:')).map((e) => e.kind)).toEqual(['comida:cenoura', 'comida:maca']);

    // Safety net: a food nobody handles (e.g. recreated by a hot reload) fades out on its own.
    const stray = game.world.spawn('oferta', 300, 450);
    game.perform([{ type: 'wait', ms: 9000 }]);
    expect(game.entity(stray.id)).toBeUndefined();
    expect(game.console.read(0, 'error')).toEqual([]);
  });

  it('card panels never leave a stale card: a hot reload with the tray or the shop open comes back closed and clean', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const pet = {
      version: 2, name: 'test1', born: t, stage: 'bebe', needs: { fome: 30, energia: 80, diversao: 70, higiene: 90, saude: 100, afeto: 60 }, sick: false,
      asleep: false, lightOn: true, bowl: 0, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 70, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, notes: [], lastSeen: t,
    };
    const storage = { pet, 'vibe.inventory': { default: { queijo: 1 } }, 'vibe.wallet': { moedas: 20 }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } };
    const opts = { seed: 1, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z' } };
    const cards = (g: Game) => g.world.withTag('carta').filter((e) => !e.destroyed);
    for (const button of ['botaoPetisco', 'botaoLoja']) {
      const before = new Game(load(), { ...opts, storage });
      before.perform([{ type: 'wait', ms: 500 }, { type: 'click', entity: button }, { type: 'wait', ms: 50 }]);
      expect(cards(before).length, button).toBeGreaterThan(0);
      // Report: the "🧀 ×1 Queijo" card stayed frozen on screen after the game reloaded with the tray open.
      const state = captureHotState(before);
      const after = new Game(load(), { ...opts, storage: before.storage.snapshot() });
      restoreHotState(after, state);
      after.perform([{ type: 'wait', ms: 100 }]);
      expect(cards(after), button).toEqual([]);
      expect(after.entity('bandeja')!.components.Sprite!.visible).toBe(false);
      expect(after.entity('loja')!.components.Sprite!.visible).toBe(false);
      // And it still works afterwards.
      after.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
      expect(cards(after).map((c) => c.components.Text!.text)).toEqual(['🧀 ×1\nQueijo']);
      after.perform([{ type: 'click', x: 315, y: 349 }, { type: 'wait', ms: 4000 }]);
      expect(cards(after)).toEqual([]);
      expect(after.events(0, 'item_used').at(-1)).toMatchObject({ item: 'queijo' });
      expect(after.console.read(0, 'error')).toEqual([]);
    }
  });

  it('need conflict: hungry, tired and bored at once, each personality goes for something else (UtilityAI, weighted, sharpness 2)', () => {
    const t = Date.parse('2026-03-10T14:00:00Z');
    const pet = {
      version: 2, name: 'x', born: t, stage: 'bebe', needs: { fome: 25, energia: 30, diversao: 15, higiene: 90, saude: 100, afeto: 70 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, notes: [], lastSeen: t,
    };
    const base = { atividade: 0.5, sociabilidade: 0.4, curiosidade: 0.4, independencia: 0.5, sensibilidade: 0.5, apetite: 0.5, paciencia: 0.6, brincadeira: 0.5 };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const project = load();
    const firstChoices = (traits: Record<string, number>) => {
      const count: Record<string, number> = {};
      for (let seed = 1; seed <= 30; seed++) {
        const g = new Game(project, {
          seed, scene: 'quarto', clock: { start: '2026-03-10T14:00:00Z' },
          storage: { pet, petIndividuo: { version: 1, traits: { ...base, ...traits }, preferences: { bola: p(0.4), ativo: p(0.2), rola: p(0.2) } }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
        });
        g.step(150);
        const c = String(g.events(0, 'ai_choice').find((e) => e.entity === 'pet')?.choice);
        count[c] = (count[c] ?? 0) + 1;
      }
      return Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
    };
    expect(firstChoices({ brincadeira: 0.95, atividade: 0.8, apetite: 0.2 })).toBe('brincar');
    expect(firstChoices({ atividade: 0.05, brincadeira: 0.2, apetite: 0.3 })).toBe('dormir');
    expect(firstChoices({ apetite: 0.95, brincadeira: 0.2 })).toBe('comer');
  });

  it('toys are UtilityAI targets: with the same toys, each pet picks the ones it likes; owned toys are placed in the room', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const pet = {
      version: 2, name: 'x', born: t, stage: 'bebe', needs: { fome: 95, energia: 95, diversao: 20, higiene: 95, saude: 100, afeto: 95 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, notes: [], lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const traits = { atividade: 0.7, sociabilidade: 0.3, curiosidade: 0.3, independencia: 0.7, sensibilidade: 0.5, apetite: 0.5, paciencia: 0.7, brincadeira: 0.9 };
    const project = load();
    const play = (preferences: Record<string, unknown>) => {
      const g = new Game(project, {
        seed: 5, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z', speed: 60 },
        storage: { pet, petIndividuo: { version: 1, traits, preferences }, 'vibe.inventory': { default: { pelucia: 1, chocalho: 1 } }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
      });
      g.step(2);
      expect(['pelucia', 'chocalho'].map((id) => g.entity(id)?.components.Text?.text)).toEqual(['🧸', '🔔']);
      const targets: Record<string, number> = {};
      for (let m = 0; m < 120; m++) {
        g.step(60);
        const ai = g.getState({ ids: ['pet'] }).entities[0].ai!;
        if (ai.choice === 'brincar' && ai.target) targets[ai.target] = (targets[ai.target] ?? 0) + 1;
      }
      expect(g.console.read(0, 'error')).toEqual([]);
      return targets;
    };
    const quiet = play({ pelucia: p(0.9), macio: p(0.8), silencioso: p(0.8), aconchego: p(0.5), chocalho: p(-0.9), barulhento: p(-1), ativo: p(0), bola: p(-0.5), rola: p(-0.3) });
    const loud = play({ pelucia: p(-0.9), macio: p(-0.6), silencioso: p(-0.5), aconchego: p(-0.5), chocalho: p(0.9), barulhento: p(1), ativo: p(0.6), bola: p(-0.5), rola: p(-0.3) });
    expect(quiet.pelucia ?? 0).toBeGreaterThan((quiet.chocalho ?? 0) * 3);
    expect(loud.chocalho ?? 0).toBeGreaterThan((loud.pelucia ?? 0) * 3);
  });

  it('at 1x speed the favorite toy is obvious within minutes: most of the play time, longer sessions, ♥ and an observation', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const pet = {
      version: 2, name: 'Mimi', born: t, stage: 'bebe', needs: { fome: 80, energia: 90, diversao: 60, higiene: 95, saude: 100, afeto: 80 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, notes: [], lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const traits = { atividade: 0.5, sociabilidade: 0.4, curiosidade: 0.4, independencia: 0.6, sensibilidade: 0.4, apetite: 0.5, paciencia: 0.7, brincadeira: 0.6 };
    const project = load();
    const minutes = (preferences: Record<string, unknown>) => {
      const g = new Game(project, {
        seed: 9, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z', speed: 1 },
        storage: { pet, petIndividuo: { version: 1, traits, preferences }, 'vibe.inventory': { default: { bola: 1, pelucia: 1, chocalho: 1 } }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
      });
      const secs: Record<string, number> = {};
      for (let s = 0; s < 180; s++) {
        g.step(60);
        const st = g.getState({ ids: ['pet'] }).entities[0];
        if (st.state === 'toy') secs[st.ai!.target!] = (secs[st.ai!.target!] ?? 0) + 1;
      }
      expect(g.console.read(0, 'error')).toEqual([]);
      return { secs, g };
    };
    const neutralTags = { ativo: p(0), rola: p(0), macio: p(0), silencioso: p(0), aconchego: p(0), barulhento: p(0) };
    const plush = minutes({ ...neutralTags, pelucia: p(0.9), bola: p(0.3), chocalho: p(0.1) });
    const ball = minutes({ ...neutralTags, pelucia: p(0.1), bola: p(0.9), chocalho: p(0.3) });
    const total = (s: Record<string, number>) => Object.values(s).reduce((a, b) => a + b, 0);
    // 3 real minutes: the favorite takes most of the toy time (and the others still get a turn now and then).
    expect(total(plush.secs)).toBeGreaterThan(30);
    expect(plush.secs.pelucia / total(plush.secs)).toBeGreaterThan(0.6);
    expect(ball.secs.bola / total(ball.secs)).toBeGreaterThan(0.6);
    // It says so (observation) and shows it (♥ over the pet).
    expect(plush.g.events(0, 'notification').map((e) => e.kind)).toContain('favorito:pelucia');
    expect(ball.g.events(0, 'notification').map((e) => e.kind)).toContain('favorito:bola');
    expect(plush.g.events(0, 'spawn').filter((e) => e.prefab === 'emote').length).toBeGreaterThan(3);
  });

  it('toy box: any toy (the ball too) can be stored and put back, the pet reacts on the spot; plush and rattle can be dragged; the layout is saved', () => {
    const game = new Game(load(), { seed: 4, clock: { start: '2026-03-10T10:00:00Z' } });
    game.perform([{ type: 'wait', ms: 200 }, { type: 'type', text: 'Mimi\n' }, { type: 'wait', ms: 500 }]);
    // A fresh room only has the ball (it comes with the room); a toy bought appears on the spot.
    expect(game.world.withTag('brinquedo').map((e) => e.id)).toEqual(['bola']);
    game.economy.wallet.add(30, 'moedas');
    game.perform([{ type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 50 }]);
    const card = (tag: string, item: string) => game.world.withTag(tag).find((c) => c.components.Script!.props.item === item)!;
    game.perform([{ type: 'click', entity: card('cartaLoja', 'pelucia').id }, { type: 'wait', ms: 50 }]);
    expect(game.entity('pelucia')).toBeTruthy();
    expect(game.events(0, 'notification').some((e) => String(e.kind).match(/:pelucia$/))).toBe(true); // the pet went to see it

    // Toy box: one card per toy owned; clicking stores it (leaves the room), clicking again puts it back.
    game.perform([{ type: 'click', entity: 'botaoBrinquedos' }, { type: 'wait', ms: 50 }]);
    expect(game.world.withTag('cartaLoja')).toEqual([]); // the other panels close
    expect(game.world.withTag('cartaBrinquedo').map((c) => c.components.Text!.text)).toEqual(['🛏️ Cama simples\nem uso', '⚽ Bola\nno quarto', '🧸 Pelúcia\nno quarto']);
    game.perform([{ type: 'click', entity: card('cartaBrinquedo', 'bola').id }, { type: 'wait', ms: 50 }]);
    expect(game.entity('bola')).toBeUndefined();
    expect(card('cartaBrinquedo', 'bola').components.Text!.text).toBe('⚽ Bola\nguardado');
    expect(game.economy.inventory().count('bola')).toBe(1); // still yours

    // Dragging the plush moves it; it lands back on the floor and the spot is kept.
    game.perform([{ type: 'click', entity: 'caixa' }, { type: 'wait', ms: 50 }]);
    const from = game.entity('pelucia')!;
    game.perform([{ type: 'drag', from: { x: from.x, y: from.y }, to: { x: 820, y: 300 } }, { type: 'wait', ms: 600 }]);
    expect(Math.round(game.entity('pelucia')!.x)).toBe(820);
    expect(Math.round(game.entity('pelucia')!.y)).toBe(452);
    expect(game.storage.get('quarto')).toMatchObject({ brinquedos: { bola: { guardado: true }, pelucia: { x: 820 } } });

    // Reopening the game keeps the arrangement.
    const again = new Game(load(), { seed: 5, scene: 'quarto', clock: { start: '2026-03-10T10:05:00Z' }, storage: game.storage.snapshot() });
    again.step(2);
    expect(again.entity('bola')).toBeUndefined();
    expect(again.entity('pelucia')!.x).toBe(820);
    expect(again.console.read(0, 'error')).toEqual([]);
    expect(game.console.read(0, 'error')).toEqual([]);
  });

  it('memory: it recognizes a food it hated (turns away at once) or loved (cheers), runs to the tray, distrusts a toy that scared it, and asks for the ball again — kept across sessions', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const pet = {
      version: 2, name: 'Mimi', born: t, stage: 'bebe', needs: { fome: 40, energia: 90, diversao: 50, higiene: 95, saude: 100, afeto: 70 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const individual = {
      version: 1,
      traits: { atividade: 0.5, sociabilidade: 0.7, curiosidade: 0.3, independencia: 0.3, sensibilidade: 0.9, apetite: 0.5, paciencia: 0.8, brincadeira: 0.8 },
      preferences: { maca: p(1), fruta: p(1), fresco: p(0.5), peixe: p(-1), proteina: p(-1), cheiroso: p(-1), salgado: p(-1), chocalho: p(0.5), barulhento: p(0.5), bola: p(0.9) },
    };
    const project = load();
    const game = new Game(project, {
      seed: 2, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z' },
      storage: { pet, petIndividuo: individual, 'vibe.inventory': { default: { maca: 3, peixe: 3, chocalho: 1, bola: 1 } }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
    });
    const card = (item: string) => game.world.withTag('cartaComida').find((c) => c.components.Script!.props.item === item)!.id;
    const offer = (item: string, ms = 4000) => {
      game.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
      game.perform([{ type: 'click', entity: card(item) }, { type: 'wait', ms }]);
    };
    const notes = () => game.events(0, 'notification').map((e) => String(e.kind));
    game.perform([{ type: 'wait', ms: 500 }]);

    // Fish: the first time it sniffs and walks away; the second time it recognizes it and turns away at once.
    offer('peixe');
    expect(notes()).toContain('comida:peixe');
    offer('peixe', 1500);
    expect(notes()).toContain('reconheceu:peixe');
    expect(game.events(0, 'reacao').at(-1)).toMatchObject({ item: 'peixe', lembrou: true });
    expect(game.economy.inventory().count('peixe')).toBe(3); // never eaten

    // Apple: loved; next time it cheers before eating. And opening the tray now brings it running.
    offer('maca');
    offer('maca');
    expect(notes()).toContain('reconheceu:maca');
    game.perform([{ type: 'wait', ms: 15000 }, { type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 200 }]);
    expect(notes()).toContain('bandeja');
    game.perform([{ type: 'click', entity: 'bandeja' }, { type: 'wait', ms: 3000 }]);

    // The rattle scares this very sensitive pet; afterwards it keeps away from it (shown or chosen).
    game.perform([{ type: 'click', entity: 'chocalho' }, { type: 'wait', ms: 2000 }]);
    expect(game.getState({ ids: ['pet'] }).entities[0].memories).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'susto', subject: 'chocalho' })]));
    game.perform([{ type: 'wait', ms: 6000 }, { type: 'click', entity: 'chocalho' }, { type: 'wait', ms: 500 }]);
    expect(notes()).toContain('desconfiado:chocalho');
    expect(game.entity('chocalho')!.components.Script!.props.peso).toBeLessThan(0.2);

    // Ball: after playing it with you, it goes to the ball and looks at you; throwing it then is "exactly what it wanted".
    for (let i = 0; i < 3; i++) game.perform([{ type: 'click', entity: 'bola' }, { type: 'wait', ms: 9000 }]);
    let asked = false;
    for (let s = 0; s < 240 && !asked; s++) {
      game.perform([{ type: 'wait', ms: 1000 }]);
      asked = notes().includes('chamar');
    }
    expect(asked).toBe(true); // within 4 real minutes at 1x
    game.perform([{ type: 'click', entity: 'bola' }, { type: 'wait', ms: 300 }]);
    expect(notes()).toContain('pedidoAtendido');
    expect(game.console.read(0, 'error')).toEqual([]);

    // Kept with the individual: reopening the game it still recognizes the fish.
    const reopened = game.storage.snapshot() as Record<string, { needs: { fome: number } }>;
    reopened.pet.needs.fome = 40; // hungry again, so the offer is not refused for being full
    const again = new Game(project, { seed: 3, scene: 'quarto', clock: { start: '2026-03-10T10:20:00Z' }, storage: reopened });
    again.perform([{ type: 'wait', ms: 500 }, { type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
    const fish = again.world.withTag('cartaComida').find((c) => c.components.Script!.props.item === 'peixe')!.id;
    again.perform([{ type: 'click', entity: fish }, { type: 'wait', ms: 500 }]);
    expect(again.events(0, 'notification').map((e) => e.kind)).toContain('reconheceu:peixe');
  });

  it('diary: nothing is revealed for free — tastes and ways appear only after you could see them, with growing confidence; the story keeps its firsts', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const pet = {
      version: 2, name: 'Mimi', born: t, stage: 'bebe', needs: { fome: 40, energia: 90, diversao: 60, higiene: 95, saude: 100, afeto: 60 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const individual = {
      version: 1,
      traits: { atividade: 0.5, sociabilidade: 0.8, curiosidade: 0.5, independencia: 0.2, sensibilidade: 0.4, apetite: 0.5, paciencia: 0.8, brincadeira: 0.5 },
      preferences: { maca: p(1), fruta: p(1), fresco: p(0.5), peixe: p(-1), proteina: p(-1), cheiroso: p(-1), salgado: p(-1), carinho: p(1), banana: p(1) },
    };
    const game = new Game(load(), {
      seed: 2, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z' },
      storage: { pet, petIndividuo: individual, 'vibe.inventory': { default: { maca: 3, peixe: 1, bola: 1 } }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
    });
    const diary = (tab: string) => {
      game.perform([{ type: 'click', entity: `diarioAba${['jeito', 'gostos', 'historias'].indexOf(tab) + 1}` }, { type: 'wait', ms: 50 }]);
      return game.entity('diarioTexto')!.components.Text!.text;
    };
    const offer = (item: string) => {
      game.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
      const card = game.world.withTag('cartaComida').find((c) => c.components.Script!.props.item === item)!.id;
      game.perform([{ type: 'click', entity: card }, { type: 'wait', ms: 4000 }]);
    };
    game.perform([{ type: 'wait', ms: 500 }, { type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 50 }]);
    expect(diary('gostos')).toContain('Ainda não deu para perceber do que gosta.');
    expect(diary('historias')).toContain('Começou este diário.');
    game.perform([{ type: 'click', entity: 'diario' }, { type: 'wait', ms: 50 }]);

    offer('maca');
    offer('peixe');
    game.perform([{ type: 'click', entity: 'pet' }, { type: 'wait', ms: 3000 }]);
    game.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 50 }]);
    let tastes = diary('gostos');
    expect(tastes).toContain('Talvez adore maçã.'); // once: just a hint
    expect(tastes).toContain('Talvez deteste peixe.');
    expect(tastes).toContain('Talvez adore carinho.');
    expect(tastes).not.toContain('banana'); // loves it, but you never saw it
    const story = diary('historias');
    expect(story).toContain('Dia 1  ·  Provou a maçã pela primeira vez e adorou.');
    expect(story).toContain('Provou o peixe pela primeira vez e recusou na hora.');
    expect(story).toContain('Recebeu o primeiro carinho e adorou.');
    game.perform([{ type: 'click', entity: 'diario' }, { type: 'wait', ms: 50 }]);

    // More of the same: the diary grows surer, the "first time" is still written once.
    offer('maca');
    offer('maca');
    game.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 50 }]);
    tastes = diary('gostos');
    expect(tastes).toContain('Adora maçã.');
    expect(diary('historias').match(/Provou a maçã/g)).toHaveLength(1);
    expect(game.getState({ ids: ['pet'] }).entities[0].knowledge).toMatchObject({ 'gosto:maca:love': 'confirmed', 'gosto:peixe:hate': 'possible' });
    expect(game.events(0, 'discovery').length).toBeGreaterThan(3);
    expect(game.console.read(0, 'error')).toEqual([]);
  });

  it('ambient and sleep: it sleeps in the cosiest spot, sleeps badly with the light on if it likes the dark (and you can see it), naps by day, dances to music or walks away from it', () => {
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const petAt = (iso: string, needs: Record<string, number>, extra: Record<string, unknown> = {}) => {
      const t = Date.parse(iso);
      return {
        version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 90, energia: 80, diversao: 80, higiene: 95, saude: 100, afeto: 80, ...needs }, sick: false,
        asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
        wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t, ...extra,
      };
    };
    const calm = { atividade: 0.1, sociabilidade: 0.3, curiosidade: 0.2, independencia: 0.6, sensibilidade: 0.85, apetite: 0.4, paciencia: 0.8, brincadeira: 0.1 };
    const lively = { atividade: 0.9, sociabilidade: 0.6, curiosidade: 0.5, independencia: 0.4, sensibilidade: 0.2, apetite: 0.5, paciencia: 0.6, brincadeira: 0.8 };
    const project = load();
    const start = (iso: string, pet: unknown, traits: Record<string, number>, preferences: Record<string, unknown>, bag: Record<string, number>, quarto: Record<string, unknown> = {}) =>
      new Game(project, {
        seed: 3, scene: 'quarto', clock: { start: iso },
        storage: { pet, petIndividuo: { version: 1, traits, preferences }, 'vibe.inventory': { default: bag }, quarto: { bolaDada: true, brinquedos: {}, ...quarto }, economia: { cesta: true, dia: Math.floor(Date.parse(iso) / 86_400_000) } },
      });
    const kinds = (g: Game) => g.events(0, 'notification').map((e) => String(e.kind));
    const petOf = (g: Game) => g.getState({ ids: ['pet'] }).entities[0];

    // Night, tired, a dark-loving sensitive pet that likes soft things: it goes to its bed (the basket) and, with the lamp on, sleeps badly.
    const night = start('2026-03-10T23:30:00Z', petAt('2026-03-10T23:30:00Z', { energia: 30 }), calm, { escuro: p(1), macio: p(0.8), cestinha: p(0.6), aconchego: p(0.5) }, { cestinha: 1, bola: 1 }, { cama: 'cestinha' });
    night.perform([{ type: 'wait', ms: 20000 }]);
    const basket = night.entity('cama')!;
    expect(basket.components.Script!.props.item).toBe('cestinha');
    expect(petOf(night).state).toBe('sleep');
    expect(Math.abs(night.entity('pet')!.x - basket.x)).toBeLessThan(60); // lies down by its side
    night.perform([{ type: 'wait', ms: 3000 }]);
    expect(kinds(night)).toContain('dormeMal');
    expect(night.events(0, 'notification').find((e) => e.kind === 'dormeMal')!.text).toContain('a luz');
    const restless = night.events(0, 'spawn').filter((e) => e.prefab === 'emote').length;
    expect(restless).toBeGreaterThan(1);
    // Turn the lamp off: it sleeps well (and recovers faster).
    const e0 = night.world.vars.energia as number;
    night.perform([{ type: 'wait', ms: 60_000 }]);
    const litGain = (night.world.vars.energia as number) - e0;
    night.perform([{ type: 'click', entity: 'lampada' }, { type: 'wait', ms: 3000 }]);
    const e1 = night.world.vars.energia as number;
    night.perform([{ type: 'wait', ms: 60_000 }]);
    expect((night.world.vars.energia as number) - e1).toBeGreaterThan(litGain * 1.4);
    expect(kinds(night)).toContain('dormeBem');
    expect(petOf(night).journal!.last.join(' ')).toContain('Dormiu pela primeira vez na cestinha fofa.');

    // Day: a calm, somewhat tired pet naps in its bed within a few real minutes at 1x.
    const day = start('2026-03-10T14:00:00Z', petAt('2026-03-10T14:00:00Z', { energia: 55 }), calm, { macio: p(0.8), cestinha: p(0.6) }, { cestinha: 1 }, { cama: 'cestinha' });
    let napped = false;
    for (let s = 0; s < 240 && !napped; s++) {
      day.perform([{ type: 'wait', ms: 1000 }]);
      napped = petOf(day).state === 'nap';
    }
    expect(napped).toBe(true);
    expect(Math.abs(day.entity('pet')!.x - day.entity('cama')!.x)).toBeLessThan(60);

    // Music: a lively music lover dances by the box; a sensitive one that dislikes it walks away.
    const box = (prefs: Record<string, unknown>, traits: Record<string, number>) => {
      const g = start('2026-03-10T15:00:00Z', petAt('2026-03-10T15:00:00Z', {}), traits, prefs, { caixinhaMusica: 1 });
      g.perform([{ type: 'wait', ms: 500 }, { type: 'click', entity: 'caixinhaMusica' }, { type: 'wait', ms: 6000 }]);
      return g;
    };
    const fan = box({ musica: p(1), caixinhaMusica: p(0.8) }, lively);
    expect(kinds(fan)).toContain('musicaSim');
    expect(petOf(fan).state).toBe('dance');
    expect(fan.entity('caixinhaMusica')!.components.Ambient!.enabled).toBe(true);
    const shy = box({ musica: p(-1), caixinhaMusica: p(-0.6) }, calm);
    expect(kinds(shy)).toContain('musicaNao');
    expect(Math.abs(shy.entity('pet')!.x - shy.entity('caixinhaMusica')!.x)).toBeGreaterThan(400);
    for (const g of [night, day, fan, shy]) expect(g.console.read(0, 'error')).toEqual([]);
  });

  it('tastes change: the same food many times in a row gets boring (and passes), and food eaten when hungry ends up liked — you see it and the diary follows', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const pet = {
      version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 0, energia: 90, diversao: 80, higiene: 95, saude: 100, afeto: 80 }, sick: false,
      asleep: false, lightOn: true, bowl: 0, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const traits = { atividade: 0.4, sociabilidade: 0.5, curiosidade: 0.4, independencia: 0.5, sensibilidade: 0.4, apetite: 0.5, paciencia: 0.8, brincadeira: 0.4 };
    const start = (preferences: Record<string, unknown>, bag: Record<string, number>, storage: Record<string, unknown> = {}, iso = '2026-03-10T10:00:00Z') =>
      new Game(load(), {
        seed: 4, scene: 'quarto', clock: { start: iso },
        storage: { pet, petIndividuo: { version: 1, traits, preferences }, 'vibe.inventory': { default: bag }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) }, ...storage },
      });
    const offer = (g: Game, item: string) => {
      g.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
      const card = g.world.withTag('cartaComida').find((c) => c.components.Script!.props.item === item)!.id;
      g.perform([{ type: 'click', entity: card }, { type: 'wait', ms: 4000 }]);
      return g.events(0, 'reacao').at(-1)!;
    };
    const neutralTags = { fruta: p(0), doce: p(0), fresco: p(0), vegetal: p(0), crocante: p(0), comida: p(0) };

    // Boredom: a loved apple, again and again — after a few it is "getting a bit tired of it"; hours later it is loved again.
    const bored = start({ ...neutralTags, maca: p(1), fruta: p(1), doce: p(1), fresco: p(1) }, { maca: 8 });
    bored.perform([{ type: 'wait', ms: 500 }]);
    const levels = [0, 1, 2, 3, 4].map(() => offer(bored, 'maca').level);
    expect(levels[0]).toBe('love');
    expect(levels.at(-1)).not.toBe('love');
    expect(bored.events(0, 'notification').map((e) => e.kind)).toContain('enjoou:maca');
    const later = start({}, { maca: 3 }, { petIndividuo: bored.storage.get('petIndividuo') }, '2026-03-10T16:00:00Z'); // 6 hours later
    later.perform([{ type: 'wait', ms: 500 }]);
    expect(offer(later, 'maca').level).toBe('love');
    expect(later.storage.get('petIndividuo')).toMatchObject({ preferences: { maca: { innate: 1 } } }); // the taste itself never moved down

    // Hunger teaches: a carrot it does not care about, eaten while hungry, becomes liked.
    const hungry = start({ ...neutralTags, cenoura: p(0.1) }, { cenoura: 8 });
    hungry.perform([{ type: 'wait', ms: 500 }]);
    expect(offer(hungry, 'cenoura').level).toBe('neutral');
    for (let i = 0; i < 4; i++) offer(hungry, 'cenoura');
    expect(hungry.events(0, 'preference_change')).toEqual([expect.objectContaining({ entity: 'pet', subject: 'cenoura', from: 'neutral', to: 'like' })]);
    expect(hungry.events(0, 'notification').find((e) => e.kind === 'mudou:cenoura')!.text).toBe('Mimi parece ter começado a gostar de cenoura.');
    hungry.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'diarioAba2' }, { type: 'wait', ms: 50 }]);
    expect(hungry.entity('diarioTexto')!.components.Text!.text).toMatch(/(Gosta de|gostar de) cenoura\./);
    expect(hungry.entity('diarioTexto')!.components.Text!.text).not.toMatch(/ligar muito para cenoura/);
    hungry.perform([{ type: 'click', entity: 'diarioAba3' }, { type: 'wait', ms: 50 }]);
    expect(hungry.entity('diarioTexto')!.components.Text!.text).toContain('Começou a gostar de cenoura.');
    for (const g of [bored, later, hungry]) expect(g.console.read(0, 'error')).toEqual([]);
  });

  it('you can see what it dislikes: the lamp gets a reaction any time (♥ / 💢 / ❗ by its taste for the dark), and refusing shows 💢', () => {
    const t = Date.parse('2026-03-10T14:00:00Z');
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const pet = {
      version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 50, energia: 90, diversao: 80, higiene: 95, saude: 100, afeto: 80 }, sick: false,
      asleep: false, lightOn: true, bowl: 0, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const traits = { atividade: 0.4, sociabilidade: 0.5, curiosidade: 0.4, independencia: 0.5, sensibilidade: 0.4, apetite: 0.5, paciencia: 0.8, brincadeira: 0.4 };
    const start = (preferences: Record<string, unknown>) =>
      new Game(load(), {
        seed: 6, scene: 'quarto', clock: { start: '2026-03-10T14:00:00Z' },
        storage: { pet, petIndividuo: { version: 1, traits, preferences }, 'vibe.inventory': { default: { peixe: 1 } }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
      });
    const glyphs = (g: Game) => g.world.withTag('emote').map((e) => e.components.Text!.text);
    const lamp = (g: Game) => {
      g.perform([{ type: 'click', entity: 'lampada' }, { type: 'wait', ms: 100 }]);
      return { signs: glyphs(g), note: g.events(0, 'notification').at(-1)?.text };
    };

    const owl = start({ escuro: p(0.8) });
    owl.perform([{ type: 'wait', ms: 500 }]);
    expect(lamp(owl)).toEqual({ signs: expect.arrayContaining(['♥']), note: 'Mimi parece gostar do quarto mais escuro.' }); // off, in the afternoon
    owl.perform([{ type: 'wait', ms: 2000 }]);
    expect(lamp(owl)).toEqual({ signs: expect.arrayContaining(['💢']), note: 'Mimi apertou os olhos com a luz. Parece preferir o escuro.' });

    const sunny = start({ escuro: p(-0.8) });
    sunny.perform([{ type: 'wait', ms: 500 }]);
    expect(lamp(sunny)).toEqual({ signs: expect.arrayContaining(['❗']), note: 'Mimi não parece gostar do escuro.' });

    const calm = start({ escuro: p(0) });
    calm.perform([{ type: 'wait', ms: 500 }]);
    expect(lamp(calm).signs).toEqual([]); // does not care: no reaction

    // Diary: the taste for the dark is something you saw.
    owl.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'diarioAba2' }, { type: 'wait', ms: 50 }]);
    expect(owl.entity('diarioTexto')!.components.Text!.text).toContain('ficar no escuro.');

    // Refusing a hated food: 💢.
    const picky = start({ peixe: p(-1), proteina: p(-1), cheiroso: p(-1), salgado: p(-1) });
    picky.perform([{ type: 'wait', ms: 500 }, { type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
    const card = picky.world.withTag('cartaComida')[0].id;
    picky.perform([{ type: 'click', entity: card }, { type: 'wait', ms: 1100 }]);
    expect(glyphs(picky)).toContain('💢');
    for (const g of [owl, sunny, calm, picky]) expect(g.console.read(0, 'error')).toEqual([]);
  });

  it('curtain: each pet has its way with brightness — dark (curtain closed, light off), light (open, on), normal (bright awake, dark asleep), indifferent — reacts on the spot and is happier when it is right', () => {
    const t = Date.parse('2026-03-10T14:00:00Z');
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const pet = {
      version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 80, energia: 90, diversao: 80, higiene: 95, saude: 100, afeto: 50 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const traits = (sensibilidade: number) => ({ atividade: 0.4, sociabilidade: 0.5, curiosidade: 0.4, independencia: 0.5, sensibilidade, apetite: 0.5, paciencia: 0.8, brincadeira: 0.4 });
    const start = (escuro: number, sens: number, quarto: Record<string, unknown> = {}) =>
      new Game(load(), {
        seed: 7, scene: 'quarto', clock: { start: '2026-03-10T14:00:00Z' },
        storage: { pet, petIndividuo: { version: 1, traits: traits(sens), preferences: { escuro: p(escuro) } }, 'vibe.inventory': { default: {} }, quarto: { bolaDada: true, brinquedos: {}, ...quarto }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
      });
    const click = (g: Game, id: string) => {
      g.perform([{ type: 'click', entity: id }, { type: 'wait', ms: 150 }]);
      return { signs: g.world.withTag('emote').map((e) => e.components.Text!.text), note: g.events(0, 'notification').at(-1)?.text };
    };

    // Prefers the dark: closing the curtain pleases it; the window stops lighting the room and the room darkens.
    const owl = start(0.8, 0.5);
    owl.perform([{ type: 'wait', ms: 500 }]);
    expect(click(owl, 'cortinaE')).toEqual({ signs: expect.arrayContaining(['♥']), note: 'Mimi parece gostar da cortina fechada.' });
    owl.perform([{ type: 'wait', ms: 1000 }]);
    expect(owl.storage.get('quarto')).toMatchObject({ cortina: true });
    expect(owl.entity('janela')!.components.Ambient!.emits.light).toBeLessThan(0.1);
    expect(owl.entity('cortinaE')!.components.Sprite!.width).toBeGreaterThan(80); // drawn closed
    owl.perform([{ type: 'click', entity: 'lampada' }, { type: 'wait', ms: 1000 }]);
    expect(owl.entity('noite')!.components.Sprite!.opacity).toBeGreaterThan(0.5); // dark afternoon
    // Just right for it: within a minute and a half at 1x it shows it is at ease, and it grows fonder over time.
    let ok = false;
    for (let s = 0; s < 100 && !ok; s++) {
      owl.perform([{ type: 'wait', ms: 1000 }]);
      ok = owl.events(0, 'notification').some((e) => e.kind === 'quartoBom');
    }
    expect(ok).toBe(true);

    // Prefers light: closing the curtain is not welcome.
    const sunny = start(-0.8, 0.5);
    sunny.perform([{ type: 'wait', ms: 500 }]);
    expect(click(sunny, 'janela')).toEqual({ signs: expect.arrayContaining(['❗']), note: 'Mimi não parece gostar do quarto mais escuro.' });

    // Normal: the curtain alone does not matter while the lamp is on; a dark room while awake does.
    const normal = start(0, 0.5);
    normal.perform([{ type: 'wait', ms: 500 }]);
    expect(click(normal, 'cortinaE').signs).toEqual([]);
    expect(click(normal, 'lampada')).toEqual({ signs: expect.arrayContaining(['💢']), note: 'Mimi não parece gostar do quarto escuro agora.' });
    normal.perform([{ type: 'wait', ms: 2000 }]);
    expect(click(normal, 'cortinaD')).toEqual({ signs: expect.arrayContaining(['♥']), note: 'Mimi parece mais à vontade com o quarto claro.' });

    // Indifferent (not sensitive): nothing.
    const easy = start(0, 0.2);
    easy.perform([{ type: 'wait', ms: 500 }]);
    expect(click(easy, 'cortinaE').signs).toEqual([]);
    expect(click(easy, 'lampada').signs).toEqual([]);

    // Happier over time: an hour in the room it likes vs in the room it does not.
    const afeto = (quarto: Record<string, unknown>, lightOn: boolean) => {
      const g = new Game(load(), {
        seed: 7, scene: 'quarto', clock: { start: '2026-03-10T14:00:00Z', speed: 60 },
        storage: { pet: { ...pet, lightOn }, petIndividuo: { version: 1, traits: traits(0.5), preferences: { escuro: p(0.8) } }, 'vibe.inventory': { default: {} }, quarto: { bolaDada: true, brinquedos: {}, ...quarto }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
      });
      g.perform([{ type: 'wait', ms: 60_000 }]);
      return g.world.vars.afeto as number;
    };
    expect(afeto({ cortina: true }, false)).toBeGreaterThan(afeto({ cortina: false }, true) + 2);
    for (const g of [owl, sunny, normal, easy]) expect(g.console.read(0, 'error')).toEqual([]);
  });

  it('a full diary splits into pages that fit the paper (◂ 1/2 ▸), and a new pet starts from scratch: no items, coins or room of the previous one', () => {
    const t = Date.parse('2026-03-10T10:00:00Z');
    const pet = {
      version: 2, name: 'Velho', born: t - 40 * 3_600_000, stage: 'adulto1a', needs: { fome: 80, energia: 90, diversao: 80, higiene: 95, saude: 100, afeto: 80 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const seen = (key: string) => [key, { evidence: 4, first: t, last: t }];
    const subjects = ['maca', 'banana', 'leite', 'queijo', 'peixe', 'cenoura', 'biscoito', 'racao', 'bola', 'pelucia', 'chocalho', 'cestinha', 'caixinhaMusica', 'carinho', 'escuro', 'musica'];
    const knowledge = Object.fromEntries(subjects.map((s) => seen(`gosto:${s}:like`)));
    const game = new Game(load(), {
      seed: 8, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z' },
      storage: {
        pet, petIndividuo: { version: 1, traits: { paciencia: 0.8 }, preferences: {}, knowledge },
        'vibe.inventory': { default: { maca: 3, pelucia: 1, bola: 1 } }, 'vibe.wallet': { moedas: 57 }, quarto: { bolaDada: true, brinquedos: {}, cortina: true },
        economia: { cesta: true, dia: Math.floor(t / 86_400_000) }, config: { speed: 1 },
      },
    });
    const text = () => game.entity('diarioTexto')!.components.Text!.text;
    game.perform([{ type: 'wait', ms: 300 }, { type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'diarioAba2' }, { type: 'wait', ms: 50 }]);
    expect(game.entity('diarioPag')!.components.Text!.text).toBe('1/2');
    const first = text();
    expect(first.split('\n').length).toBeLessThanOrEqual(16); // title + blank + 14 lines: fits the paper
    expect(game.entity('diarioAnt')!.components.Text!.text).toBe('');
    game.perform([{ type: 'click', entity: 'diarioProx' }, { type: 'wait', ms: 50 }]);
    expect(game.entity('diarioPag')!.components.Text!.text).toBe('2/2');
    expect(text()).not.toBe(first);
    expect(first + text()).toContain('Parece gostar de ficar no escuro.');
    game.perform([{ type: 'click', entity: 'diarioAba1' }, { type: 'wait', ms: 50 }]);
    expect(game.entity('diarioPag')!.components.Text!.text).toBe(''); // one page: no arrows

    // New pet: confirm twice, name it; the collection keeps the old one, everything else starts over.
    game.perform([{ type: 'click', entity: 'botaoNovoPet' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'botaoNovoPet' }, { type: 'wait', ms: 300 }]);
    expect(game.world.scene.id).toBe('inicio');
    game.perform([{ type: 'type', text: 'Novo\n' }, { type: 'wait', ms: 500 }]);
    expect(game.world.scene.id).toBe('quarto');
    expect(game.getState().inventories).toEqual({ default: { maca: 1, cenoura: 1, leite: 1, biscoito: 1, bola: 1, camaSimples: 1 } }); // the welcome basket and the ball
    expect(game.getState().wallet).toEqual({ moedas: 15 });
    expect(game.storage.get('quarto')).not.toMatchObject({ cortina: true });
    expect((game.storage.get('colecao') as { pets: { nome: string }[] }).pets.map((p) => p.nome)).toEqual(['Velho']);
    expect(game.console.read(0, 'error')).toEqual([]);
  });

  it('evolution comes from its history: what it did and how it was cared for pick the form, the diary says why (and shows where it is heading)', () => {
    const t = Date.parse('2026-03-10T14:00:00Z');
    const H = 3_600_000;
    const base = (stage: string, ageH: number, extra: Record<string, unknown> = {}) => ({
      version: 2, name: 'Mimi', born: t - ageH * H, stage, needs: { fome: 80, energia: 90, diversao: 80, higiene: 95, saude: 100, afeto: 80 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t, ...extra,
    });
    const slots = (v: number) => [0, 0, 0, 0, v, v, 0, 0];
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const grow = (pet: unknown, individual: Record<string, unknown>) => {
      const g = new Game(load(), {
        seed: 9, scene: 'quarto', clock: { start: '2026-03-10T14:00:00Z' },
        storage: { pet, petIndividuo: { version: 1, traits: { paciencia: 0.8 }, preferences: {}, ...individual }, 'vibe.inventory': { default: {} }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) } },
      });
      g.perform([{ type: 'wait', ms: 300 }]);
      const before = g.storage.get('pet') as { stage: string };
      const diary = () => {
        g.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'diarioAba1' }, { type: 'wait', ms: 50 }]);
        const text = g.entity('diarioTexto')!.components.Text!.text;
        g.perform([{ type: 'click', entity: 'diario' }, { type: 'wait', ms: 50 }]);
        return text;
      };
      const rumo = diary();
      g.apply({ op: 'advanceClock', ms: 0.05 * H });
      g.perform([{ type: 'wait', ms: 1500 }]);
      expect(g.console.read(0, 'error')).toEqual([]);
      return { from: before.stage, to: (g.storage.get('pet') as { stage: string }).stage, rumo, story: g.getState({ ids: ['pet'] }).entities[0].journal!.last[0], note: g.events(0, 'notification').find((e) => e.kind === 'evolucao')?.text };
    };

    // A baby that spent its days playing and exploring grows into the active line; one that rested and got petting, the calm line.
    const lively = grow(base('bebe', 11.98, { care: { brincadeiras: 6, carinhos: 1, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 } }), { routine: { values: { brincar: slots(6), explorar: slots(4), descansar: slots(1) } } });
    expect(lively.rumo).toContain('parece que vai crescer ativo');
    expect(lively).toMatchObject({ from: 'bebe', to: 'juvenil1' });
    expect(lively.story).toBe('Cresceu: agora é jovem. Passou a infância brincando e explorando o quarto.');
    expect(lively.note).toBe('Mimi cresceu! Passou a infância brincando e explorando o quarto.');
    const gentle = grow(base('bebe', 11.98, { care: { brincadeiras: 0, carinhos: 8, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 } }), { routine: { values: { descansar: slots(5), procurar: slots(3), brincar: slots(1) } } });
    expect(gentle.rumo).toContain('parece que vai crescer calmo e carinhoso');
    expect(gentle).toMatchObject({ to: 'juvenil2' });
    expect(gentle.story).toBe('Cresceu: agora é jovem. Passou a infância recebendo carinho e descansando.');

    // A young one well cared for, close to you and that tasted many foods becomes the best adult; a neglected one, the last.
    const loved = grow(
      base('juvenil1', 35.98, { wellbeing: 90, provou: { maca: 'love', cenoura: 'like', leite: 'neutral', peixe: 'hate', banana: 'like' }, care: { brincadeiras: 10, carinhos: 10, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 } }),
      { Memory: undefined, memory: [{ type: 'carinho', subject: 'voce', tags: [], valence: 1, importance: 0.9, t, last: t, count: 6 }] },
    );
    expect(loved.rumo).toContain('Está crescendo muito bem cuidado.');
    expect(loved).toMatchObject({ from: 'juvenil1', to: 'adulto1a' });
    expect(loved.story).toBe('Cresceu: agora é adulto. Foi muito bem cuidado, confia muito em você e come de tudo um pouco.');
    const neglected = grow(base('juvenil2', 35.98, { wellbeing: 25, provou: {} }), {});
    expect(neglected).toMatchObject({ to: 'adulto3b' });
    expect(neglected.story).toBe('Cresceu: agora é adulto. Passou por uns apertos, se acostumou a ficar sozinho e quase só conheceu ração.');
  });

  it('a calm pet shows itself too: low traits are seen (glances from afar, full sooner, lukewarm about petting) and reach the diary', () => {
    const t = Date.parse('2026-03-10T14:00:00Z');
    const pet = {
      version: 2, name: 'Sereno', born: t - 3_600_000, stage: 'bebe', needs: { fome: 85, energia: 90, diversao: 80, higiene: 95, saude: 100, afeto: 70 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const g = new Game(load(), {
      seed: 5, scene: 'quarto', clock: { start: '2026-03-10T14:00:00Z' },
      storage: {
        pet,
        petIndividuo: { version: 1, traits: { atividade: 0.4, sociabilidade: 0.15, curiosidade: 0.1, independencia: 0.5, sensibilidade: 0.5, apetite: 0.1, paciencia: 0.6, brincadeira: 0.4 }, preferences: { carinho: p(0), maca: p(0.5) } },
        'vibe.inventory': { default: { maca: 1 } }, 'vibe.wallet': { moedas: 40 }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
      },
    });
    g.perform([{ type: 'wait', ms: 500 }]);
    const texts = () => g.events(0, 'notification').map((e) => String(e.text));

    // Something new in the room: a pet with little curiosity only glances at it.
    g.perform([{ type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 80 }]);
    const card = g.world.withTag('cartaLoja').find((c) => c.components.Script!.props.item === 'cestinha')!;
    g.perform([{ type: 'click', entity: card.id }, { type: 'wait', ms: 80 }, { type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 4000 }]);
    expect(texts()).toContain('Sereno olhou a cestinha fofa de longe e continuou o que estava fazendo.');
    // Little appetite: not that hungry (85) and it already says no (twice: one sign is not enough for the diary).
    for (let i = 0; i < 2; i++) {
      g.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 80 }]);
      g.perform([{ type: 'click', entity: g.world.withTag('cartaComida')[0].id }, { type: 'wait', ms: 3000 }]);
    }
    expect(texts()).toContain('Sereno não parece estar com fome agora.');
    // Reserved: petting is fine, nothing more.
    g.perform([{ type: 'click', entity: 'pet' }, { type: 'wait', ms: 7000 }, { type: 'click', entity: 'pet' }, { type: 'wait', ms: 3000 }]);
    expect(texts()).toContain('Sereno aceitou o carinho, sem muita empolgação.');

    g.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 80 }, { type: 'click', entity: 'diarioAba1' }, { type: 'wait', ms: 80 }]);
    const jeito = g.entity('diarioTexto')!.components.Text!.text;
    expect(jeito).toContain('Talvez seja pouco curioso.');
    expect(jeito).toContain('Talvez seja de pouco apetite.');
    expect(jeito).toContain('Talvez seja reservado.');
    expect(g.console.read(0, 'error')).toEqual([]);
  });

  it('beds: one bed in use, swapped in the Coisas box or by buying one; it sleeps better in the one it likes and on the floor if it hates it', () => {
    const day = '2026-03-10T14:00:00Z';
    const night = '2026-03-10T23:00:00Z';
    const t = Date.parse(day);
    const petAt = (iso: string, energia: number) => ({ ...pet, needs: { ...pet.needs, energia }, lastSeen: Date.parse(iso) });
    const pet = {
      version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 90, energia: 90, diversao: 80, higiene: 95, saude: 100, afeto: 80 }, sick: false,
      asleep: false, lightOn: false, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const traits = { atividade: 0.3, sociabilidade: 0.5, curiosidade: 0.6, independencia: 0.5, sensibilidade: 0.5, apetite: 0.5, paciencia: 0.7, brincadeira: 0.4 };
    const prefs = { quentinho: p(1), camaQuentinha: p(0.6), fresquinho: p(-1), camaFria: p(-0.8), macio: p(0.3), escuro: p(0) };
    const start = (iso: string, storage: Record<string, unknown> = {}) =>
      new Game(load(), {
        seed: 3, scene: 'quarto', clock: { start: iso },
        storage: { pet: petAt(iso, iso === day ? 90 : 30), petIndividuo: { version: 1, traits, preferences: prefs }, 'vibe.inventory': { default: {} }, 'vibe.wallet': { moedas: 60 }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) }, ...storage },
      });
    const g = start(day);
    g.perform([{ type: 'wait', ms: 300 }]);
    const cama = () => g.entity('cama')!;
    const kinds = () => g.events(0, 'notification').map((e) => String(e.kind));
    const card = (tag: string, item: string) => g.world.withTag(tag).find((c) => c.components.Script!.props.item === item)!;
    expect(cama().components.Script!.props.item).toBe('camaSimples'); // comes with the room
    expect(g.economy.inventory().count('camaSimples')).toBe(1);

    // Buying a bed puts it in use at once (the bed changes look), and the pet goes to try it.
    g.perform([{ type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 50 }]);
    g.perform([{ type: 'click', entity: card('cartaLoja', 'camaQuentinha').id }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 9000 }]);
    expect(cama().components.Script!.props.item).toBe('camaQuentinha');
    expect(cama().components.Sprite!.color).toBe('#c4614e');
    expect(g.entity('camaEnfeite')!.components.Text!.text).toBe('🧣');
    expect(g.world.withTag('lugarDeDormir')).toHaveLength(1); // still one bed
    expect(g.events(0, 'notification').map((e) => e.text)).toContain('Mimi deitou na cama quentinha para experimentar. Parece ter gostado!');

    // The Coisas box lists the beds: the one in use, and the others to swap to.
    g.perform([{ type: 'click', entity: 'botaoBrinquedos' }, { type: 'wait', ms: 50 }]);
    expect(g.world.withTag('cartaBrinquedo').map((c) => c.components.Text!.text)).toEqual(['🧣 Cama quentinha\nem uso', '🛏️ Cama simples\nusar esta']);
    g.perform([{ type: 'click', entity: card('cartaBrinquedo', 'camaSimples').id }, { type: 'wait', ms: 50 }]);
    expect(cama().components.Script!.props.item).toBe('camaSimples');
    expect(card('cartaBrinquedo', 'camaQuentinha').components.Text!.text).toBe('🧣 Cama quentinha\nusar esta');
    g.perform([{ type: 'click', entity: 'caixa' }, { type: 'wait', ms: 50 }]);

    // A bed it hates: it sniffs and walks away...
    g.perform([{ type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 50 }]);
    g.perform([{ type: 'click', entity: card('cartaLoja', 'camaFria').id }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 9000 }]);
    expect(g.events(0, 'notification').map((e) => e.text)).toContain('Mimi cheirou a cama fresquinha e se afastou.');
    expect(cama().components.Script!.props.item).toBe('camaFria');
    // ...and at bedtime it sleeps on the floor, away from it.
    const floor = start(night, { 'vibe.inventory': { default: { camaSimples: 1, camaFria: 1 } }, quarto: { bolaDada: true, brinquedos: {}, cama: 'camaFria' } });
    expect(floor.waitUntil((x) => (x.storage.get('pet') as { asleep: boolean }).asleep, 120_000).ok).toBe(true);
    floor.perform([{ type: 'wait', ms: 2000 }]);
    expect(floor.events(0, 'notification').map((e) => e.text)).toContain('Mimi preferiu dormir no chão, longe da cama fresquinha.');
    expect(Math.abs(floor.entity('pet')!.x - floor.entity('cama')!.x)).toBeGreaterThan(300);

    // In the warm bed it loves it sleeps well, recovering more than in the plain one.
    const sleepGain = (bed: string) => {
      const s = start(night, { 'vibe.inventory': { default: { camaSimples: 1, camaQuentinha: 1 } }, quarto: { bolaDada: true, brinquedos: {}, cama: bed } });
      s.waitUntil((x) => (x.storage.get('pet') as { asleep: boolean }).asleep, 120_000);
      s.perform([{ type: 'wait', ms: 3000 }]);
      const energia = () => (s.storage.get('pet') as { needs: { energia: number } }).needs.energia;
      const e0 = energia();
      s.clock.speed = 60; // an hour of sleep
      s.perform([{ type: 'wait', ms: 60_000 }]);
      expect(Math.abs(s.entity('pet')!.x - s.entity('cama')!.x)).toBeLessThan(60);
      return energia() - e0;
    };
    expect(sleepGain('camaQuentinha')).toBeGreaterThan(sleepGain('camaSimples') * 1.15);

    // The bed in use is kept with the save.
    const again = new Game(load(), { seed: 4, scene: 'quarto', clock: { start: '2026-03-11T08:00:00Z' }, storage: g.storage.snapshot() });
    again.step(2);
    expect(again.entity('cama')!.components.Script!.props.item).toBe('camaFria');
    for (const x of [g, floor, again]) expect(x.console.read(0, 'error')).toEqual([]);
  });

  it('bond: what you do for it builds a bond slowly (capped per day), a new level shows and goes to the diary, and the adult form weighs it', () => {
    const iso = '2026-03-10T14:00:00Z';
    const t = Date.parse(iso);
    const pet = {
      version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 15, energia: 90, diversao: 80, higiene: 95, saude: 50, afeto: 60 }, sick: true,
      asleep: false, lightOn: true, bowl: 0, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const g = new Game(load(), {
      seed: 2, scene: 'quarto', clock: { start: iso },
      storage: {
        pet, petIndividuo: { version: 1, traits: { atividade: 0.4, sociabilidade: 0.8, curiosidade: 0.5, independencia: 0.3, sensibilidade: 0.4, apetite: 0.6, paciencia: 0.8, brincadeira: 0.5 }, preferences: { carinho: p(1), maca: p(1), banana: p(1), leite: p(1), fruta: p(1), laticinio: p(1) } },
        'vibe.inventory': { default: { maca: 1, banana: 1, leite: 1 } }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
      },
    });
    const bond = () => g.getState({ ids: ['pet'] }).entities[0].bonds?.voce?.value ?? 0.2;
    g.perform([{ type: 'wait', ms: 500 }]);
    expect(bond()).toBe(0.2);
    const diary = () => {
      g.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'diarioAba1' }, { type: 'wait', ms: 50 }]);
      const text = g.entity('diarioTexto')!.components.Text!.text;
      g.perform([{ type: 'click', entity: 'diario' }, { type: 'wait', ms: 50 }]);
      return text;
    };
    expect(diary()).toContain('Com você\n· Ainda está se acostumando com você.');

    // Petting it likes: up, but a day of petting only goes so far.
    for (let i = 0; i < 6; i++) g.perform([{ type: 'click', entity: 'pet' }, { type: 'wait', ms: 7000 }]);
    const afterPetting = bond();
    expect(afterPetting).toBeGreaterThan(0.26);
    expect(afterPetting).toBeLessThanOrEqual(0.2801);
    // Medicine when it is sick and foods it loves add their part.
    g.perform([{ type: 'click', entity: 'botaoRemedio' }, { type: 'wait', ms: 1000 }]);
    for (let i = 0; i < 3; i++) {
      g.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 80 }]);
      g.perform([{ type: 'click', entity: g.world.withTag('cartaComida')[0].id }, { type: 'wait', ms: 6000 }]);
    }
    expect(bond()).toBeGreaterThan(0.35);
    expect(g.events(0, 'relationship_level')).toMatchObject([{ entity: 'pet', subject: 'voce', from: 0, level: 1 }]);
    expect(g.events(0, 'notification').map((e) => e.text)).toContain('Mimi parece gostar cada vez mais da sua companhia.');
    expect(g.getState({ ids: ['pet'] }).entities[0].journal!.last).toContain('Passou a gostar da sua companhia.');
    expect(diary()).toContain('Com você\n· Gosta da sua companhia.');
    expect(g.console.read(0, 'error')).toEqual([]);
  });

  it('desires: soon after you arrive it wants a food (thought balloon + observation); giving it what it wanted pleases it, a wrong guess does not count, an ignored one passes', () => {
    const iso = '2026-03-10T14:00:00Z';
    const t = Date.parse(iso);
    const pet = {
      version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 50, energia: 95, diversao: 80, higiene: 95, saude: 100, afeto: 60 }, sick: false,
      asleep: false, lightOn: true, bowl: 0, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const g = new Game(load(), {
      seed: 5, scene: 'quarto', clock: { start: iso },
      storage: {
        pet, petIndividuo: { version: 1, traits: { atividade: 0.8, sociabilidade: 0.5, curiosidade: 0.5, independencia: 0.2, sensibilidade: 0.3, apetite: 0.7, paciencia: 0.1, brincadeira: 0.5 }, preferences: { peixe: p(1), crocante: p(0.9), biscoito: p(0.6), maca: p(0.3) } },
        'vibe.inventory': { default: { maca: 2, biscoito: 1 } }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
      },
    });
    const script = () => (g as unknown as { scriptRunner: { api: { entity(e: unknown): { state: Record<string, unknown>; desires: { cancel(r: string): unknown } } } } }).scriptRunner.api.entity(g.entity('pet'));
    const api = () => script().state.api as { desejar(p?: unknown): { kind: string; subject?: string; data: { tipo: string; icone: string } } | null; desejo(): unknown; pet: { needs: Record<string, number> } };
    const desires = () => script().desires;
    const balloon = () => g.entity('balao')!.components.Sprite!.opacity;
    const offer = (item: string) => {
      g.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 80 }]);
      g.perform([{ type: 'click', entity: g.world.withTag('cartaComida').find((c) => c.components.Script!.props.item === item)!.id }, { type: 'wait', ms: 6000 }]);
    };
    const notes = () => g.events(0, 'notification').map((e) => e.text as string);

    // Within the first minute of the visit it wants something to eat: a thought balloon with what, and an observation.
    g.perform([{ type: 'wait', ms: 20_000 }]);
    expect(g.events(0, 'desire_start')).toEqual([]);
    expect(balloon()).toBe(0);
    g.perform([{ type: 'wait', ms: 45_000 }]);
    const first = g.events(0, 'desire_start');
    expect(first).toMatchObject([{ entity: 'pet', kind: 'comida' }]);
    expect(balloon()).toBeGreaterThan(0.9);
    expect(g.entity('balaoIcone')!.components.Text!.text).toBe((first[0].data as { icone: string }).icone);
    expect(notes().some((n) => /^Mimi (parece com vontade de|parece querer|está farejando o ar)/.test(n))).toBe(true);
    expect(g.getState({ ids: ['pet'] }).entities[0].desires).toMatchObject([{ kind: 'comida' }]);
    desires().cancel('*');

    // It wants fish, which you do not have: buy it and give it — even full, it eats what it was craving.
    expect(api().desejar({ tipo: 'especifica', item: 'peixe' })).toMatchObject({ subject: 'peixe', data: { tipo: 'especifica', icone: '🐟' } });
    expect(notes().at(-1)).toBe('Mimi parece com vontade de comer peixe.');
    g.economy.inventory().add('peixe', 1);
    api().pet.needs.fome = 95;
    const bondBefore = g.getState({ ids: ['pet'] }).entities[0].bonds?.voce?.value ?? 0.2;
    offer('peixe');
    expect(g.events(0, 'desire_fulfilled')).toMatchObject([{ entity: 'pet', subject: 'peixe', by: 'comeu', trigger: { item: 'peixe' } }]);
    expect(notes()).toContain('Mimi estava mesmo com vontade de comer peixe! Parece muito feliz.');
    expect((g.getState({ ids: ['pet'] }).entities[0].bonds!.voce.value) - bondBefore).toBeGreaterThan(0.07);
    expect(g.getState({ ids: ['pet'] }).entities[0].journal!.last).toContain('Estava com vontade de comer peixe e você deu.');
    g.perform([{ type: 'wait', ms: 1000 }]);
    expect(balloon()).toBe(0);

    // "Something crunchy": an apple is not it (it eats and keeps wanting); the biscuit is.
    api().pet.needs.fome = 40;
    api().desejar({ tipo: 'tag', tag: 'crocante' });
    expect(notes().at(-1)).toBe('Mimi parece querer algo crocante.');
    offer('maca');
    expect(g.events(0, 'desire_fulfilled')).toHaveLength(1);
    expect(api().desejo()).toMatchObject({ subject: 'crocante' });
    offer('biscoito');
    expect(g.events(0, 'desire_fulfilled').at(-1)).toMatchObject({ subject: 'crocante', trigger: { item: 'biscoito' } });
    expect(notes()).toContain('Era isso! Mimi queria algo crocante, e o biscoito caiu muito bem.');
    g.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'diarioAba2' }, { type: 'wait', ms: 50 }]);
    expect(g.entity('diarioTexto')!.components.Text!.text).toMatch(/(adore|goste|gostar de) coisas crocantes/);
    g.perform([{ type: 'click', entity: 'diario' }, { type: 'wait', ms: 50 }]);

    // Ignored, it passes (an impatient one gives up sooner): no punishment, just the chance gone.
    api().desejar({ tipo: 'novidade' });
    expect(notes().at(-1)).toBe('Mimi está farejando o ar, curioso. Parece querer provar algo novo.');
    g.apply({ op: 'advanceClock', ms: 25 * 60_000 });
    g.perform([{ type: 'wait', ms: 170_000 }]);
    expect(g.events(0, 'desire_expired')).toMatchObject([{ entity: 'pet', data: { tipo: 'novidade' } }]);
    expect(notes()).toContain('Mimi parou de farejar o ar.');
    expect(g.console.read(0, 'error')).toEqual([]);
    expect(g.events(0, 'script_error')).toEqual([]);
  });

  it('desires beyond food: a toy, playing with you, petting, being left alone, the room — each fulfilled its own way; who it is shapes what it wants', () => {
    const iso = '2026-03-10T14:00:00Z';
    const t = Date.parse(iso);
    const pet = {
      version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 70, energia: 95, diversao: 50, higiene: 95, saude: 100, afeto: 60 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const make = (traits: Record<string, number>, prefs: Record<string, ReturnType<typeof p>>) =>
      new Game(load(), {
        seed: 6, scene: 'quarto', clock: { start: iso },
        storage: {
          pet: structuredClone(pet), petIndividuo: { version: 1, traits: { atividade: 0.5, sociabilidade: 0.5, curiosidade: 0.5, independencia: 0.5, sensibilidade: 0.5, apetite: 0.5, paciencia: 0.5, brincadeira: 0.5, ...traits }, preferences: prefs },
          'vibe.inventory': { default: { bola: 1, pelucia: 1 } }, quarto: { bolaDada: true, brinquedos: { pelucia: { guardado: true } } }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
        },
      });
    type Api = { desejar(p?: unknown): unknown; desejo(): { kind: string } | null; vontades(): Record<string, number> };
    const apiOf = (g: Game) => (g as unknown as { scriptRunner: { api: { entity(e: unknown): { state: { api: Api } } } } }).scriptRunner.api.entity(g.entity('pet')).state.api;
    const notesOf = (g: Game) => g.events(0, 'notification').map((e) => e.text as string);

    // Who it is shapes what it wants: the independent one thinks of being alone, the cuddly one of you.
    const loner = make({ independencia: 0.95, sociabilidade: 0.1 }, { carinho: p(-0.5) });
    const cuddly = make({ independencia: 0.1, sociabilidade: 0.95 }, { carinho: p(1) });
    loner.perform([{ type: 'wait', ms: 300 }]);
    cuddly.perform([{ type: 'wait', ms: 300 }]);
    expect(apiOf(loner).vontades().quieto).toBeGreaterThan(0);
    expect(apiOf(loner).vontades().carinho).toBeUndefined();
    expect(apiOf(cuddly).vontades().carinho).toBeGreaterThan(0);
    expect(apiOf(cuddly).vontades().quieto).toBeUndefined();

    const g = make({ independencia: 0.9, sociabilidade: 0.6, sensibilidade: 0.7 }, { carinho: p(1), pelucia: p(1), bola: p(0.8), escuro: p(1) });
    g.perform([{ type: 'wait', ms: 300 }]);
    const api = apiOf(g);
    const done = () => g.events(0, 'desire_fulfilled').map((e) => e.kind);

    // A toy it likes, put away in the box: it looks at the box; taking it out is what it wanted.
    api.desejar({ tipo: 'brinquedo', item: 'pelucia' });
    expect(notesOf(g).at(-1)).toBe('Mimi está olhando para a caixa de coisas... parece querer a pelúcia.');
    g.perform([{ type: 'wait', ms: 50 }]);
    expect(g.entity('balaoIcone')!.components.Text!.text).toBe('🧸');
    g.perform([{ type: 'click', entity: 'botaoBrinquedos' }, { type: 'wait', ms: 80 }]);
    g.perform([{ type: 'click', entity: g.world.withTag('cartaBrinquedo').find((c) => c.components.Script!.props.item === 'pelucia')!.id }, { type: 'wait', ms: 80 }, { type: 'click', entity: 'caixa' }, { type: 'wait', ms: 1000 }]);
    expect(done()).toEqual(['brinquedo']);
    expect(notesOf(g)).toContain('Mimi queria mesmo a pelúcia! Foi direto brincar.');

    // Playing with you: throwing the ball is it.
    api.desejar({ tipo: 'brincar' });
    expect(notesOf(g).at(-1)).toBe('Mimi foi buscar a bola e está olhando para você. Parece querer brincar.');
    g.perform([{ type: 'wait', ms: 3000 }, { type: 'click', entity: 'bola' }, { type: 'wait', ms: 500 }]);
    expect(done()).toEqual(['brinquedo', 'brincar']);
    expect(notesOf(g)).toContain('Era isso! Mimi queria brincar com você.');

    // Petting, when it comes to lean on you.
    g.perform([{ type: 'wait', ms: 4000 }]);
    api.desejar({ tipo: 'carinho' });
    expect(notesOf(g).at(-1)).toBe('Mimi veio se encostar em você. Parece querer carinho.');
    g.perform([{ type: 'wait', ms: 2000 }, { type: 'click', entity: 'pet' }, { type: 'wait', ms: 300 }]);
    expect(done()).toEqual(['brinquedo', 'brincar', 'carinho']);

    // Being left alone: petting it then breaks it; leaving it be is what it wanted.
    g.perform([{ type: 'wait', ms: 8000 }]);
    api.desejar({ tipo: 'quieto' });
    expect(notesOf(g).at(-1)).toBe('Mimi foi para um canto. Parece querer ficar sozinho um pouco.');
    g.perform([{ type: 'wait', ms: 4000 }, { type: 'click', entity: 'pet' }, { type: 'wait', ms: 300 }]);
    expect(api.desejo()).toBeNull();
    expect(notesOf(g).at(-1)).toBe('Mimi queria ficar quieto um pouco e se afastou.');
    expect(g.events(0, 'desire_cancelled').map((e) => e.kind)).toEqual(['quieto']);
    api.desejar({ tipo: 'quieto' });
    const bondBefore = g.getState({ ids: ['pet'] }).entities[0].bonds!.voce.value;
    for (let i = 0; i < 4; i++) g.perform([{ type: 'wait', ms: 46_000 }]);
    expect(g.events(0, 'desire_expired').map((e) => e.kind)).toEqual(['quieto']);
    expect(notesOf(g)).toContain('Mimi voltou do canto, tranquilo. Parece agradecer o espaço que você deu.');
    expect(g.getState({ ids: ['pet'] }).entities[0].bonds!.voce.value).toBeGreaterThan(bondBefore);

    // The room: it likes the dark and squints at the bright room — light off is half of it, the curtain the rest.
    api.desejar({ tipo: 'ambiente', subject: 'luz' });
    expect(notesOf(g).at(-1)).toBe('Mimi está apertando os olhos com a claridade e olhando para a cortina.');
    g.perform([{ type: 'wait', ms: 50 }]);
    expect(g.entity('balaoIcone')!.components.Text!.text).toBe('🌙');
    g.perform([{ type: 'click', entity: 'lampada' }, { type: 'wait', ms: 1500 }]);
    expect(api.desejo()).toMatchObject({ kind: 'ambiente' });
    g.perform([{ type: 'click', entity: 'cortinaE' }, { type: 'wait', ms: 1500 }]);
    expect(api.desejo()).toBeNull();
    expect(notesOf(g)).toContain('Mimi parece aliviado: era assim que queria o quarto.');
    expect(g.getState({ ids: ['pet'] }).entities[0].journal!.count).toBeGreaterThanOrEqual(5);
    expect(g.console.read(0, 'error')).toEqual([]);
    expect(g.events(0, 'script_error')).toEqual([]);
  });

  it('sleeping with the light on follows its way with light: one that likes light (even a sensitive one) is not bothered by it; one that likes the dark sleeps badly', () => {
    const iso = '2026-03-10T23:30:00Z';
    const t = Date.parse(iso);
    const sleeper = (escuro: number) => {
      const g = new Game(load(), {
        seed: 3, scene: 'quarto', clock: { start: iso },
        storage: {
          pet: {
            version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 80, energia: 40, diversao: 60, higiene: 95, saude: 100, afeto: 60 }, sick: false,
            asleep: true, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
            wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
          },
          petIndividuo: { version: 1, traits: { atividade: 0.5, sociabilidade: 0.5, curiosidade: 0.5, independencia: 0.5, sensibilidade: 0.9, apetite: 0.5, paciencia: 0.6, brincadeira: 0.5 }, preferences: { escuro: { innate: escuro, learned: 0, n: 0 } } },
          economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
        },
      });
      g.perform([{ type: 'wait', ms: 30_000 }]);
      return g.events(0, 'notification').map((e) => e.text as string);
    };
    const likesLight = sleeper(-0.8);
    expect(likesLight.some((n) => /incomodado com a luz|claridade/.test(n))).toBe(false);
    expect(sleeper(0.8)).toContain('Mimi está dormindo mal: parece incomodado com a luz.');
  });

  it('waking it up: one poke while it sleeps only stirs it; poking again and again wakes it, grumpy for a while, and it stays awake long enough to eat', () => {
    const iso = '2026-03-10T23:30:00Z';
    const t = Date.parse(iso);
    const g = new Game(load(), {
      seed: 3, scene: 'quarto', clock: { start: iso },
      storage: {
        pet: {
          version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 25, energia: 50, diversao: 60, higiene: 95, saude: 100, afeto: 60 }, sick: false,
          asleep: true, lightOn: false, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
          wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
        },
        petIndividuo: { version: 1, traits: { atividade: 0.5, sociabilidade: 0.5, curiosidade: 0.5, independencia: 0.5, sensibilidade: 0.5, apetite: 0.5, paciencia: 0.8, brincadeira: 0.5 }, preferences: { carinho: { innate: 0.8, learned: 0, n: 0 } } },
        economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
      },
    });
    const notes = () => g.events(0, 'notification').map((e) => e.text as string);
    const bond = () => g.entity('pet')!.components.Relationship!.values.voce?.value ?? 0.2; // never met: the initial bond
    g.perform([{ type: 'wait', ms: 500 }]);
    expect(g.world.vars.dormindo).toBe(true);
    const before = bond();

    // A patient pet only stirs at the first pokes...
    g.perform([{ type: 'click', entity: 'pet' }, { type: 'wait', ms: 600 }]);
    expect(notes()).toContain('Mimi se mexeu um pouco, ainda dormindo.');
    g.perform([{ type: 'click', entity: 'pet' }, { type: 'wait', ms: 600 }, { type: 'click', entity: 'pet' }, { type: 'wait', ms: 600 }]);
    expect(notes()).toContain('Mimi resmungou e se encolheu, ainda dormindo.');
    expect(g.world.vars.dormindo).toBe(true);
    // ...and the fourth in a row wakes it, grumpy: the bond drops a little.
    g.perform([{ type: 'click', entity: 'pet' }, { type: 'wait', ms: 300 }]);
    expect(g.world.vars.dormindo).toBe(false);
    expect(notes()).toContain('Mimi acordou e não parece gostar disso.');
    expect(bond()).toBeLessThan(before);

    // Still upset: petting now is turned down.
    g.perform([{ type: 'wait', ms: 3000 }, { type: 'click', entity: 'pet' }, { type: 'wait', ms: 300 }]);
    expect(notes()).toContain('Mimi ainda parece chateado por ter sido acordado.');

    // Sleepy at night, but it stays up long enough to go to the bowl and eat.
    g.perform([{ type: 'wait', ms: 40_000 }]);
    expect(g.world.vars.dormindo).toBe(false);
    expect(g.world.vars.fome as number).toBeGreaterThan(25);
    // A couple of minutes later, still night and tired, it goes back to bed.
    g.perform([{ type: 'wait', ms: 60_000 }, { type: 'wait', ms: 60_000 }, { type: 'wait', ms: 20_000 }]);
    expect(g.world.vars.dormindo).toBe(true);
    expect(g.console.read(0, 'error')).toEqual([]);
    expect(g.events(0, 'script_error')).toEqual([]);
  });

  it('happenings: a bird, a butterfly, a find, a free sample, sneezes — each shows up in the room, the pet reacts its way, and taking part the right way pays off', () => {
    const iso = '2026-03-10T14:00:00Z';
    const t = Date.parse(iso);
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const make = (needs: Record<string, number> = {}, traits: Record<string, number> = {}, inventory: Record<string, number> = { bola: 1 }) => {
      const g = new Game(load(), {
        seed: 4, scene: 'quarto', clock: { start: iso },
        storage: {
          pet: {
            version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 70, energia: 95, diversao: 50, higiene: 95, saude: 100, afeto: 60, ...needs }, sick: false,
            asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
            wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t, provou: { maca: true },
          },
          petIndividuo: { version: 1, traits: { atividade: 0.5, sociabilidade: 0.5, curiosidade: 0.8, independencia: 0.3, sensibilidade: 0.3, apetite: 0.6, paciencia: 0.6, brincadeira: 0.5, ...traits }, preferences: { carinho: p(0.5) } },
          'vibe.inventory': { default: inventory }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
        },
      });
      g.perform([{ type: 'wait', ms: 300 }]);
      return g;
    };
    type Hap = { start(kind: string): unknown; current(): { kind: string; data: Record<string, unknown> } | null; candidates(): { id: string }[] };
    const hap = (g: Game) => (g as unknown as { scriptRunner: { api: { entity(e: unknown): { happenings: Hap } } } }).scriptRunner.api.entity(g.entity('acontecimentos')).happenings;
    const notes = (g: Game) => g.events(0, 'notification').map((e) => e.text as string);
    const ended = (g: Game) => g.events(0, 'happening_end').map((e) => `${e.kind}:${e.outcome}`);
    const story = (g: Game) => g.getState({ ids: ['pet'] }).entities[0].journal!.last.join(' | ');
    const bond = (g: Game) => g.entity('pet')!.components.Relationship!.values.voce?.value ?? 0.2;

    // What can come depends on the hour and on how it is: sneezes only when health or cleanliness are low.
    expect(hap(make()).candidates().map((c) => c.id)).toEqual(['passarinho', 'borboleta', 'achado', 'amostra', 'vendedor']);
    expect(hap(make({ saude: 55 })).candidates().map((c) => c.id)).toContain('espirros');

    // A bird at the window: with the curtain open the curious pet goes to see it.
    let g = make();
    hap(g).start('passarinho');
    g.perform([{ type: 'wait', ms: 50 }]);
    expect(notes(g).at(-1)).toBe('Um passarinho pousou na janela.');
    expect(g.entity('passarinho')).toBeTruthy();
    g.perform([{ type: 'wait', ms: 15_000 }]);
    expect(ended(g)).toEqual([]); // it stays a while: at 1× you get to see it too
    g.perform([{ type: 'wait', ms: 15_000 }]);
    expect(ended(g)).toEqual(['passarinho:visto']);
    expect(notes(g)).toContain('Mimi ficou olhando o passarinho até ele voar. Parece encantado.');
    expect(story(g)).toContain('Viu um passarinho pousar na janela.');
    expect(bond(g)).toBeGreaterThan(0.2);
    // With the curtain closed it is only heard: the pet looks at the curtain; opening it lets it see.
    g = make();
    g.perform([{ type: 'click', entity: 'cortinaE' }, { type: 'wait', ms: 3000 }]);
    hap(g).start('passarinho');
    g.perform([{ type: 'wait', ms: 6000 }]);
    expect(notes(g)).toContain('Tem um passarinho cantando lá fora.');
    expect(notes(g)).toContain('Mimi está olhando para a cortina... parece ouvir alguma coisa lá fora.');
    expect(ended(g)).toEqual([]);
    g.perform([{ type: 'click', entity: 'cortinaE' }, { type: 'wait', ms: 30_000 }]);
    expect(ended(g)).toEqual(['passarinho:visto']);

    // A butterfly: clicking it guides it back out of the window.
    g = make();
    hap(g).start('borboleta');
    g.perform([{ type: 'wait', ms: 50 }]);
    expect(notes(g).at(-1)).toBe('Uma borboleta entrou pela janela!');
    g.perform([{ type: 'wait', ms: 2000 }, { type: 'click', entity: 'borboleta' }, { type: 'wait', ms: 8000 }]);
    expect(ended(g)).toEqual(['borboleta:solta']);
    expect(notes(g)).toContain('A borboleta voltou lá para fora. Mimi ficou olhando ela ir.');

    // A find: it digs somewhere and something shows up; clicking it is yours.
    g = make();
    hap(g).start('achado');
    g.perform([{ type: 'wait', ms: 50 }]);
    g.perform([{ type: 'wait', ms: 25_000 }]);
    const found = hap(g).current()!.data;
    expect(found.coisa).toBeTruthy();
    const coinsBefore = g.economy.wallet.get('moedas');
    g.perform([{ type: 'click', entity: 'achado' }, { type: 'wait', ms: 300 }]);
    expect(ended(g)).toEqual(['achado:pego']);
    if (found.coisa === 'moedas') expect(g.economy.wallet.get('moedas')).toBeGreaterThan(coinsBefore);
    else expect(g.economy.inventory().has(String(found.coisa))).toBe(true);

    // A free sample at the door: a food it never tried; opening it puts it with your food, eating it ends it well.
    g = make({ fome: 40 });
    hap(g).start('amostra');
    g.perform([{ type: 'wait', ms: 50 }]);
    const sample = String(hap(g).current()!.data.item);
    expect(sample).not.toBe('maca'); // it already tried apples
    expect(notes(g).at(-1)).toBe('Deixaram uma caixinha de amostra grátis na porta!');
    g.perform([{ type: 'click', entity: 'amostra' }, { type: 'wait', ms: 300 }]);
    expect(g.economy.inventory().has(sample)).toBe(true);
    g.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
    g.perform([{ type: 'click', entity: g.world.withTag('cartaComida').find((c) => c.components.Script!.props.item === sample)!.id }, { type: 'wait', ms: 6000 }]);
    expect(ended(g)).toEqual(['amostra:provou']);

    // Sneezes: medicine early keeps it from getting sick.
    g = make({ saude: 55 });
    hap(g).start('espirros');
    g.perform([{ type: 'wait', ms: 50 }]);
    g.perform([{ type: 'wait', ms: 500 }]);
    expect(notes(g)).toContain('Mimi espirrou.');
    g.perform([{ type: 'click', entity: 'botaoRemedio' }, { type: 'wait', ms: 300 }]);
    expect(ended(g)).toEqual(['espirros:remedio']);
    expect(notes(g)).toContain('Mimi parou de espirrar. Parece bem melhor.');
    expect(g.world.vars.saude as number).toBeGreaterThanOrEqual(70);
    expect(g.console.read(0, 'error')).toEqual([]);
    expect(g.events(0, 'script_error')).toEqual([]);
  });

  it('more happenings: a storm and a nightmare (comfort the scared one), a mess (clean up, then play), a peddler (a rare toy for a few hours), a gift (accept it)', () => {
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const make = (iso: string, o: { needs?: Record<string, number>; traits?: Record<string, number>; asleep?: boolean; bond?: number } = {}) => {
      const t = Date.parse(iso);
      const g = new Game(load(), {
        seed: 4, scene: 'quarto', clock: { start: iso },
        storage: {
          pet: {
            version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 80, energia: o.asleep ? 50 : 95, diversao: 60, higiene: 95, saude: 100, afeto: 60, ...o.needs }, sick: false,
            asleep: !!o.asleep, lightOn: !o.asleep, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
            wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
          },
          petIndividuo: {
            version: 1, traits: { atividade: 0.5, sociabilidade: 0.6, curiosidade: 0.5, independencia: 0.3, sensibilidade: 0.3, apetite: 0.5, paciencia: 0.6, brincadeira: 0.5, ...o.traits }, preferences: { carinho: p(-0.5), bola: p(0.6) },
            ...(o.bond !== undefined && { relationship: { voce: { value: o.bond, peak: o.bond, t } } }),
          },
          'vibe.inventory': { default: { bola: 1 } }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
        },
      });
      g.perform([{ type: 'wait', ms: 300 }]);
      return g;
    };
    type Hap = { start(kind: string): unknown; current(): { kind: string; data: Record<string, unknown> } | null; candidates(): { id: string }[] };
    const hap = (g: Game) => (g as unknown as { scriptRunner: { api: { entity(e: unknown): { happenings: Hap } } } }).scriptRunner.api.entity(g.entity('acontecimentos')).happenings;
    const start = (g: Game, kind: string) => (hap(g).start(kind), g.perform([{ type: 'wait', ms: 50 }]));
    const notes = (g: Game) => g.events(0, 'notification').map((e) => e.text as string);
    const ended = (g: Game) => g.events(0, 'happening_end').map((e) => `${e.kind}:${e.outcome}`);
    const story = (g: Game) => g.getState({ ids: ['pet'] }).entities[0].journal!.last.join(' | ');

    // Night: the storm can come even while it sleeps; the nightmare only then.
    expect(hap(make('2026-03-10T23:30:00Z', { asleep: true })).candidates().map((c) => c.id)).toEqual(['tempestade', 'pesadelo']);

    // A storm and a sensitive pet: the thunder wakes it, it hides and trembles; two comforts (curtain + light) calm it.
    let g = make('2026-03-10T23:30:00Z', { asleep: true, traits: { sensibilidade: 0.85 } });
    start(g, 'tempestade');
    g.perform([{ type: 'wait', ms: 3000 }]);
    expect(g.world.vars.dormindo).toBe(false);
    expect(notes(g)).toContain('Mimi se assustou com o trovão e está tremendo.');
    g.perform([{ type: 'click', entity: 'cortinaE' }, { type: 'wait', ms: 500 }, { type: 'click', entity: 'lampada' }, { type: 'wait', ms: 6000 }]);
    expect(ended(g)).toEqual(['tempestade:acalmou']);
    expect(story(g)).toContain('Teve medo da tempestade e você ficou com ele.');
    g.perform([{ type: 'wait', ms: 15_000 }]);
    expect(g.world.vars.dormindo).toBe(true); // back to bed
    // A calm one sleeps through it.
    g = make('2026-03-10T23:30:00Z', { asleep: true, traits: { sensibilidade: 0.2 } });
    start(g, 'tempestade');
    g.perform([{ type: 'wait', ms: 7000 }]);
    expect(g.world.vars.dormindo).toBe(true);
    expect(notes(g)).toContain('Mimi nem acordou com a tempestade.');

    // A nightmare: it wakes up scared; a pet calms it (even one that does not like petting) and it goes back to sleep.
    g = make('2026-03-11T02:00:00Z', { asleep: true, traits: { sensibilidade: 0.7 } });
    start(g, 'pesadelo');
    expect(notes(g)).toContain('Mimi acordou assustado no meio da noite, tremendo.');
    expect(g.world.vars.dormindo).toBe(false);
    g.perform([{ type: 'wait', ms: 1500 }, { type: 'click', entity: 'pet' }, { type: 'wait', ms: 300 }]);
    expect(ended(g)).toEqual(['pesadelo:consolado']);
    g.perform([{ type: 'wait', ms: 12_000 }]);
    expect(g.world.vars.dormindo).toBe(true);

    // A mess: bored and impatient, it knocks the vase over; clean the dirt, then play with it.
    g = make('2026-03-10T14:00:00Z', { needs: { diversao: 30 }, traits: { paciencia: 0.2 } });
    expect(hap(g).candidates().map((c) => c.id)).toContain('bagunca');
    start(g, 'bagunca');
    for (let i = 0; i < 9 && !hap(g).current()!.data.caido; i++) g.perform([{ type: 'wait', ms: 5000 }]);
    expect(notes(g)).toContain('Mimi derrubou o vaso da planta! Tem terra no chão.');
    const dirt = hap(g).current()!.data.sujeiras as string[];
    expect(dirt.length).toBe(2);
    for (const id of dirt) g.perform([{ type: 'click', entity: id }, { type: 'wait', ms: 300 }]);
    g.perform([{ type: 'wait', ms: 1000 }]);
    expect(hap(g).current()!.data.limpo).toBe(true);
    g.perform([{ type: 'click', entity: 'bola' }, { type: 'wait', ms: 500 }]);
    expect(ended(g)).toEqual(['bagunca:arrumado']);
    expect(g.entity('vaso')!.rotation).toBeCloseTo(0, 1);

    // A peddler: a rare toy shows in the shop only while it is here; buying it ends it well.
    g = make('2026-03-10T14:00:00Z');
    const shopItems = () => g.world.withTag('cartaLoja').map((c) => String(c.components.Script!.props.item));
    g.perform([{ type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 100 }]);
    expect(shopItems()).not.toContain('ioio');
    expect(shopItems()).not.toContain('bolhas');
    g.perform([{ type: 'click', x: 480, y: 370 }, { type: 'wait', ms: 100 }]); // an empty spot of the panel closes it
    start(g, 'vendedor');
    const rare = String(hap(g).current()!.data.item);
    expect(['ioio', 'bolhas']).toContain(rare);
    expect(notes(g).at(-1)).toMatch(/^Um vendedor passou e deixou (uma novidade|novidades) na loja: /);
    g.economy.wallet.add(40, 'moedas');
    g.perform([{ type: 'click', entity: 'vendedor' }, { type: 'wait', ms: 100 }]); // the ✨ opens the shop
    expect(shopItems()).toContain(rare);
    g.perform([{ type: 'click', entity: g.world.withTag('cartaLoja').find((c) => c.components.Script!.props.item === rare)!.id }, { type: 'wait', ms: 300 }]);
    expect(ended(g)).toEqual(['vendedor:comprou']);
    expect(g.economy.inventory().has(rare)).toBe(true);
    expect(story(g)).toMatch(/de um vendedor que passou\./);
    // The peddler only passes by (it does not hold the turn of the others); the offer stays for 3 hours, then leaves.
    g = make('2026-03-10T10:00:00Z');
    start(g, 'vendedor');
    const offered = String(hap(g).current()!.data.item);
    g.apply({ op: 'advanceClock', ms: 15 * 60_000 });
    g.perform([{ type: 'wait', ms: 95_000 }]);
    expect(hap(g).current()).toBeNull();
    expect(ended(g)).toEqual(['vendedor:expired']);
    expect(g.entity('vendedor')).toBeTruthy(); // the ✨ is still there
    g.perform([{ type: 'click', entity: 'vendedor' }, { type: 'wait', ms: 100 }]);
    expect(shopItems()).toContain(offered);
    g.perform([{ type: 'click', x: 480, y: 370 }, { type: 'wait', ms: 100 }]);
    g.apply({ op: 'advanceClock', ms: 3 * 3_600_000 });
    g.perform([{ type: 'wait', ms: 3000 }]);
    expect(g.entity('vendedor')).toBeUndefined();
    expect(notes(g)).toContain('As novidades do vendedor saíram da loja.');
    g.perform([{ type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 100 }]);
    expect(shopItems()).not.toContain(offered);
    expect(shopItems()).not.toContain('pocaoCarinho');

    // Sometimes the peddler brings potions too (always, when you already have every rare toy): one brings it closer to
    // you, the other makes it standoffish. They go through the food tray; it drinks at once and you see it.
    g = make('2026-03-10T10:00:00Z');
    g.economy.inventory().add('ioio', 1);
    g.economy.inventory().add('bolhas', 1);
    start(g, 'vendedor');
    expect(notes(g).at(-1)).toBe('Um vendedor passou e deixou uma novidade na loja: 🧪 umas poções estranhas, só por algumas horas.');
    g.economy.wallet.add(60, 'moedas');
    g.perform([{ type: 'click', entity: 'vendedor' }, { type: 'wait', ms: 100 }]);
    expect(shopItems()).toEqual(expect.arrayContaining(['pocaoCarinho', 'pocaoBirra']));
    const buy = (id: string) => g.perform([{ type: 'click', entity: g.world.withTag('cartaLoja').find((c) => c.components.Script!.props.item === id)!.id }, { type: 'wait', ms: 300 }]);
    buy('pocaoCarinho');
    buy('pocaoBirra');
    expect(ended(g)).toEqual(['vendedor:comprou']);
    g.perform([{ type: 'click', x: 480, y: 370 }, { type: 'wait', ms: 100 }]);
    const bondNow = () => g.entity('pet')!.components.Relationship!.values.voce?.value ?? 0.2;
    const drink = (id: string) => {
      g.perform([{ type: 'click', entity: 'botaoPetisco' }, { type: 'wait', ms: 50 }]);
      g.perform([{ type: 'click', entity: g.world.withTag('cartaComida').find((c) => c.components.Script!.props.item === id)!.id }, { type: 'wait', ms: 2000 }]);
    };
    const b0 = bondNow();
    drink('pocaoCarinho');
    const b1 = bondNow();
    expect(b1).toBeGreaterThan(b0 + 0.08);
    expect(notes(g)).toContain('Mimi bebeu a poção, ficou todo brilhante e veio se aconchegar perto de você.');
    expect(story(g)).toContain('Bebeu uma poção do carinho e ficou mais pertinho de você.');
    expect(g.economy.inventory().has('pocaoCarinho')).toBe(false);
    drink('pocaoBirra');
    expect(bondNow()).toBeLessThan(b1 - 0.1);
    expect(notes(g)).toContain('Mimi bebeu a poção, fez careta e se afastou um pouco de você.');
    // The offer still lasts after you bought one of each (more can be bought), and leaves after 3 hours.
    expect(g.entity('vendedor')).toBeTruthy();

    // A gift, when it trusts you: it fetches something and leaves it near you; clicking it accepts.
    expect(hap(make('2026-03-10T14:00:00Z')).candidates().map((c) => c.id)).not.toContain('presente');
    g = make('2026-03-10T14:00:00Z', { bond: 0.7 });
    expect(hap(g).candidates().map((c) => c.id)).toContain('presente');
    start(g, 'presente');
    for (let i = 0; i < 10 && !hap(g).current()!.data.entregue; i++) g.perform([{ type: 'wait', ms: 3000 }]);
    expect(notes(g).some((n) => /^Mimi trouxe (uma flor|uma folhinha|uma pena) e deixou perto de você\.$/.test(n))).toBe(true);
    g.perform([{ type: 'click', entity: 'presente' }, { type: 'wait', ms: 300 }]);
    expect(ended(g)).toEqual(['presente:aceito']);
    expect(notes(g)).toContain('Mimi parece muito contente por você ter aceitado o presente.');
    expect(g.console.read(0, 'error')).toEqual([]);
    expect(g.events(0, 'script_error')).toEqual([]);
  });

  it('happenings come by themselves at 1×: none in the first minutes, then now and then while it is awake', () => {
    const iso = '2026-03-10T10:00:00Z';
    const t = Date.parse(iso);
    const g = new Game(load(), {
      seed: 8, scene: 'quarto', clock: { start: iso },
      storage: {
        pet: {
          version: 2, name: 'Mimi', born: t - 3_600_000, stage: 'bebe', needs: { fome: 90, energia: 100, diversao: 80, higiene: 95, saude: 100, afeto: 80 }, sick: false,
          asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
          wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
        },
        economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
      },
    });
    for (let i = 0; i < 4; i++) g.perform([{ type: 'wait', ms: 59_000 }]);
    expect(g.events(0, 'happening_start')).toEqual([]); // the first 4 minutes belong to the pet
    for (let i = 0; i < 40; i++) g.perform([{ type: 'wait', ms: 59_000 }]);
    expect(g.events(0, 'happening_start').length).toBeGreaterThanOrEqual(1);
    expect(g.events(0, 'happening_start').length).toBeLessThanOrEqual(4);
    expect(g.events(0, 'script_error')).toEqual([]);
  });

  it('balance at 1×: two opposite pets over an hour and a half (a desire soon after you arrive, a few happenings, few words), sneezes say little, and coming back does not pour notes', { timeout: 180_000 }, () => {
    const fresh = (traits: Record<string, number>, iso: string) => {
      const t = Date.parse(iso);
      return {
        pet: {
          version: 2, name: 'Mimi', born: t - 4 * 3_600_000, stage: 'bebe', needs: { fome: 70, energia: 80, diversao: 60, higiene: 90, saude: 100, afeto: 60 }, sick: false,
          asleep: false, lightOn: true, bowl: 1, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
          wellbeing: 70, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t - 6 * 3_600_000,
        },
        petIndividuo: { version: 1, traits },
        economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
      } as Record<string, unknown>;
    };
    // Plays at 1× in 10 s steps, keeping every event of interest (the game keeps only the latest ones).
    const visit = (storage: Record<string, unknown>, iso: string, minutes: number, care = false) => {
      const g = new Game(load(), { seed: 11, scene: 'quarto', clock: { start: iso }, storage });
      const seen: GameEvent[] = [];
      let from = 0;
      for (let i = 0; i < minutes * 6; i++) {
        g.perform([{ type: 'wait', ms: 10_000 }]);
        if (care && (g.world.vars.tigela as number) < 2) g.perform([{ type: 'click', entity: 'tigela' }, { type: 'wait', ms: 50 }]);
        if (care) for (const d of g.world.withTag('sujeira')) g.perform([{ type: 'click', entity: d.id }, { type: 'wait', ms: 50 }]);
        seen.push(...g.events(from).filter((e) => ['notification', 'desire_start', 'happening_start', 'script_error'].includes(e.type)));
        from = g.frame;
      }
      return { g, seen: [...new Map(seen.map((e) => [`${e.frame}/${e.type}/${e.kind}/${e.text}`, e])).values()] };
    };
    const secs = (e: GameEvent) => e.frame / 60;
    const social = { sociabilidade: 0.9, atividade: 0.85, curiosidade: 0.9, sensibilidade: 0.8, paciencia: 0.15, independencia: 0.1, brincadeira: 0.85, apetite: 0.7 };
    const loner = { sociabilidade: 0.1, atividade: 0.15, curiosidade: 0.15, sensibilidade: 0.1, paciencia: 0.9, independencia: 0.9, brincadeira: 0.15, apetite: 0.3 };
    const asks: Record<string, string[]> = {};
    for (const [who, traits] of Object.entries({ social, loner })) {
      const { seen } = visit(fresh(traits, '2026-03-10T09:00:00Z'), '2026-03-10T09:00:00Z', 90);
      expect(seen.filter((e) => e.type === 'script_error')).toEqual([]);
      const desires = seen.filter((e) => e.type === 'desire_start');
      expect(secs(desires[0])).toBeLessThan(120); // it was waiting for you
      expect(desires.length).toBeGreaterThanOrEqual(3);
      asks[who] = desires.map((e) => String(e.kind));
      const happenings = seen.filter((e) => e.type === 'happening_start');
      expect(happenings.length).toBeGreaterThanOrEqual(3); // the peddler does not hold the turn for hours
      expect(happenings.length).toBeLessThanOrEqual(6);
      expect(secs(happenings[0])).toBeGreaterThanOrEqual(240);
      const notes = seen.filter((e) => e.type === 'notification');
      expect(notes.length).toBeLessThanOrEqual(45); // ~one every two minutes on average
      for (let m = 0; m < 90; m += 10) expect(notes.filter((e) => secs(e) >= m * 60 && secs(e) < (m + 10) * 60).length).toBeLessThanOrEqual(9);
    }
    // Opposite pets want opposite things: the loner asks to be left alone, the social one never does.
    expect(asks.loner).toContain('quieto');
    expect(asks.social).not.toContain('quieto');

    // Coming back the next morning: the summary first, the needs wait a little, and it does not repeat that it missed you.
    const evening = visit(fresh(social, '2026-03-10T18:00:00Z'), '2026-03-10T18:00:00Z', 15, true);
    const morning = visit(evening.g.storage.snapshot(), '2026-03-11T08:00:00Z', 10);
    const back = morning.seen.filter((e) => e.type === 'notification');
    expect(back[0].text).toMatch(/^Você ficou fora por 14 h\. .*sentir sua falta|^Você ficou fora por 14 h\. .*sentido sua falta/);
    const needs = ['fome', 'cansaco', 'tedio', 'saudade', 'sujo', 'tigelaVazia'];
    expect(back.filter((e) => secs(e) < 20 && needs.includes(String(e.kind)))).toEqual([]);
    expect(back.some((e) => secs(e) >= 20 && e.kind === 'sujo')).toBe(true); // then it does say it
    expect(back.filter((e) => e.kind === 'saudade')).toEqual([]);

    // Sneezes: the first two say so, then it is only the 💦 (and one reminder).
    const g = new Game(load(), { seed: 5, scene: 'quarto', clock: { start: '2026-03-10T10:00:00Z' }, storage: fresh(social, '2026-03-10T10:00:00Z') });
    g.perform([{ type: 'wait', ms: 300 }]);
    (g as unknown as { scriptRunner: { api: { entity(e: unknown): { happenings: { start(k: string): unknown } } } } }).scriptRunner.api.entity(g.entity('acontecimentos')).happenings.start('espirros');
    let from = 0;
    const sneezes: string[] = [];
    for (let i = 0; i < 60; i++) {
      g.perform([{ type: 'wait', ms: 10_000 }]);
      sneezes.push(...g.events(from, 'notification').filter((e) => e.kind === 'espirro').map((e) => String(e.text)));
      from = g.frame;
    }
    expect(sneezes.length).toBeGreaterThanOrEqual(2);
    expect(sneezes.length).toBeLessThanOrEqual(3);
  });

  it('minigames: Brincar opens Pega-pega or Caixinhas with who the pet is, and the room comes back with fun, clues about its tastes, coins and a diary page', () => {
    const t = Date.parse('2026-03-10T14:00:00Z');
    const pet = {
      version: 2, name: 'Mimi', born: t - 5 * 3_600_000, stage: 'bebe', needs: { fome: 80, energia: 90, diversao: 40, higiene: 95, saude: 100, afeto: 60 }, sick: false,
      asleep: false, lightOn: true, bowl: 3, dirt: 0, care: { brincadeiras: 0, carinhos: 0, petiscos: 0, refeicoes: 0, sonecas: 0, limpezas: 0 },
      wellbeing: 80, treats: { day: -1, n: 0 }, revealed: {}, cooldowns: {}, lastSeen: t,
    };
    const p = (v: number) => ({ innate: v, learned: 0, n: 0 });
    const g = new Game(load(), {
      seed: 4, scene: 'quarto', clock: { start: '2026-03-10T14:00:00Z' },
      storage: {
        pet,
        petIndividuo: { version: 1, traits: { atividade: 0.9, curiosidade: 0.85, paciencia: 0.8, brincadeira: 0.8 }, preferences: { maca: p(0.9), peixe: p(-0.9), queijo: p(0.4) } },
        'vibe.inventory': { default: {} }, quarto: { bolaDada: true, brinquedos: {} }, economia: { cesta: true, dia: Math.floor(t / 86_400_000) },
      },
    });
    g.perform([{ type: 'wait', ms: 300 }]);
    const coins = () => g.economy.wallet.get('moedas');
    const before = coins();
    g.entity('pet')!.x = 300;

    // Brincar → Pega-pega: the minigame gets the pet's form, its way and what it thinks of each food.
    g.perform([{ type: 'click', entity: 'botaoJogos' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'jogoPegar' }, { type: 'wait', ms: 100 }]);
    expect(g.world.scene.id).toBe('pegar');
    const params = g.minigame!.params as { nome: string; quadros: string[]; jeito: Record<string, number>; comidas: { id: string; nivel: string }[] };
    expect(params).toMatchObject({ nome: 'Mimi', quadros: ['bebe_1', 'bebe_2'], jeito: { atividade: 0.9 } });
    expect(params.comidas.find((c) => c.id === 'maca')!.nivel).toBe('love');
    expect(params.comidas.find((c) => c.id === 'peixe')!.nivel).toBe('hate');
    expect(g.entity('pet')!.components.Sprite!.asset).toBe('bebe_1');

    // Playing at 1x: the mouse follows whatever is falling lowest, so the pet catches most things.
    for (let f = 0; f < 60 * 34 && !g.world.vars.fim; f += 4) {
      const falling = g.world.withTag('queda').filter((e) => !e.destroyed).sort((a, b) => b.y - a.y)[0];
      if (falling) g.apply({ op: 'mouseMove', x: falling.x, y: 300 });
      g.step(4);
    }
    expect(g.world.vars.fim).toBe(true);
    expect(g.world.vars.pontos as number).toBeGreaterThan(15);
    const resumo = g.entity('resumo')!.components.Text!.text;
    expect(resumo).toMatch(/^Mimi pegou (bastante coisa|um montão de coisas)/);
    expect(resumo).toContain('Ficou feliz com: ');
    expect(resumo).toMatch(/\+\d 🪙/);
    expect(g.events(0, 'spawn').filter((e) => e.prefab === 'emote').length).toBeGreaterThan(3); // ♥ and 💢 as it catches
    g.perform([{ type: 'click', entity: 'botaoVoltarJogo' }, { type: 'wait', ms: 200 }]);

    // Back in the room, as it was: fun up, a memory of playing with you, clues, coins and a diary page.
    expect(g.world.scene.id).toBe('quarto');
    expect(g.entity('pet')).toBeDefined();
    const end = g.events(0, 'minigame_end')[0];
    expect(end).toMatchObject({ scene: 'pegar', from: 'quarto', result: { jogo: 'pegar' } });
    const after = g.storage.get('pet') as { needs: Record<string, number>; care: { brincadeiras: number }; jogos: Record<string, { vezes: number }> };
    expect(after.needs.diversao).toBeGreaterThan(60);
    expect(after.care.brincadeiras).toBe(1);
    expect(after.jogos.pegar.vezes).toBe(1);
    expect(coins()).toBe(before + (end.result as { moedas: number }).moedas);
    expect((end.result as { moedas: number }).moedas).toBeGreaterThan(0);
    const snap = g.getState({ ids: ['pet'] }).entities[0];
    expect(snap.memories!.some((m) => m.type === 'brincouComVoce')).toBe(true);
    expect(snap.journal!.last[0]).toBe('Brincou de Pega-pega com você pela primeira vez.');
    expect(g.events(0, 'notification').map((e) => e.text)).toContain('Mimi adorou brincar de Pega-pega com você!');
    expect(snap.knowledge).toMatchObject({ 'gosto:maca:love': 'possible' }); // a clue about its tastes, without feeding it
    expect(snap.knowledge).toMatchObject({ 'jeito:atividade:alto': 'possible' }); // a fast one: you see it in the game

    // Caixinhas: the treat goes in a box, they shuffle, you point; a curious pet sniffs near the right one first.
    g.perform([{ type: 'wait', ms: 2000 }, { type: 'click', entity: 'botaoJogos' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'jogoCaixinhas' }, { type: 'wait', ms: 100 }]);
    expect(g.world.scene.id).toBe('caixinhas');
    const sniffed: boolean[] = [];
    for (let round = 0; round < 3; round++) {
      expect(g.waitUntil((x) => x.world.vars.fase === 'escolher', 20_000).ok).toBe(true);
      g.perform([{ type: 'wait', ms: 2500 }]); // give it time to sniff
      const right = g.entity(`cx${g.world.vars.premio}`)!;
      sniffed.push(Math.abs(g.entity('pet')!.x - right.x) < Math.abs(480 - right.x) || right.x === 480);
      g.perform([{ type: 'click', entity: right.id }]);
    }
    expect(sniffed).toEqual([true, true, true]);
    expect(g.waitUntil((x) => x.world.vars.fase === 'fim', 20_000).ok).toBe(true);
    expect(g.entity('resumo')!.components.Text!.text).toContain('✅ ✅ ✅');
    expect(g.entity('resumo')!.components.Text!.text).toContain('Mimi farejou por perto antes de você escolher.');
    g.perform([{ type: 'click', entity: 'botaoVoltarJogo' }, { type: 'wait', ms: 200 }]);
    expect(g.world.scene.id).toBe('quarto');
    const box = g.events(0, 'minigame_end')[1];
    expect(box).toMatchObject({ result: { jogo: 'caixinhas', pontos: 3, farejou: true } });
    expect(box.result).not.toHaveProperty('reacoes'); // a toy bone only for the game: no tastes, no food
    const boxFrame = g.events(0, 'minigame_start')[1].frame;
    expect(g.events(boxFrame, 'spawn').filter((e) => e.prefab === 'emote').length).toBeGreaterThan(0);
    const known = g.getState({ ids: ['pet'] }).entities[0].knowledge!;
    expect(known).toMatchObject({ 'jeito:curiosidade:alto': 'possible' });
    expect(g.console.read(0, 'error')).toEqual([]);

    // A sick pet does not want to play (a tired one goes to sleep, and a sleeping one is asleep).
    const saved = g.storage.snapshot() as { pet: { sick: boolean } };
    saved.pet.sick = true;
    const sick = new Game(load(), { seed: 4, scene: 'quarto', clock: { start: g.clock.iso }, storage: saved });
    sick.perform([{ type: 'wait', ms: 300 }, { type: 'click', entity: 'botaoJogos' }, { type: 'wait', ms: 50 }, { type: 'click', entity: 'jogoPegar' }, { type: 'wait', ms: 100 }]);
    expect(sick.world.scene.id).toBe('quarto');
    expect(sick.events(0, 'notification').map((e) => e.text)).toContain('Mimi não está se sentindo bem para brincar.');
  });

  it('verify_game plays a scenario of the real game and reports PASS per check', async () => {
    const store = new ProjectStore(MEU_PET);
    const r = await createAgentTools().call(
      'verify_game',
      {
        scenario: 'cleaning the dirt puffs dust and removes it',
        screenshot: false,
        clock: { speed: 3600 },
        steps: [
          { type: 'type', text: 'Bolinha' },
          { type: 'click', entity: 'botaoComecar' },
          { type: 'assert', name: 'in the room', expr: "scene == 'quarto'" },
          { type: 'waitUntil', name: 'dirt appeared', expr: "count('sujeira') > 0", maxMs: 30000 },
          { type: 'click', entity: 'sujeira1' },
          { type: 'wait', ms: 150 },
        ],
        assertions: [
          { name: 'dirt cleaned', expr: "!exists('sujeira1')" },
          { name: 'dust puffed', assert: 'eventOccurred', event: 'particles', match: { entity: 'sujeira1', count: 14 } },
          { name: 'the pet has a state', assert: 'entity', id: 'pet', field: 'state', notEquals: null },
          { assert: 'scene', is: 'quarto' },
        ],
      },
      { store, author: 'agent', host: new RuntimeHost(store) },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.result).toMatchObject({
      passed: true,
      report: ['PASS in the room', 'PASS dirt appeared', 'PASS dirt cleaned', 'PASS dust puffed', 'PASS the pet has a state', 'PASS scene is "quarto"'],
      errors: [],
    });
  });

  it('every playbook saved in the project passes (run_playbooks)', async () => {
    const store = new ProjectStore(MEU_PET);
    const r = await createAgentTools().call('run_playbooks', {}, { store, author: 'agent', host: new RuntimeHost(store) });
    if (!r.ok) throw new Error(r.error);
    const board = r.result as { passed: boolean; results: { id: string; passed: boolean; failures?: string[] }[] };
    expect(board.results.length).toBeGreaterThanOrEqual(4);
    expect(board.results.filter((p) => !p.passed)).toEqual([]);
  });

  it('a failing verification of the real game comes with a diagnosis', async () => {
    const store = new ProjectStore(MEU_PET);
    const r = await createAgentTools().call(
      'verify_game',
      {
        scenario: 'the pet falls asleep right after a pat (it does not)',
        screenshot: false,
        clock: { speed: 600 },
        steps: [{ type: 'type', text: 'Bolinha' }, { type: 'click', entity: 'botaoComecar' }, { type: 'wait', ms: 500 }, { type: 'click', entity: 'pet' }, { type: 'wait', ms: 100 }],
        assertions: [{ assert: 'state', id: 'pet', is: 'sleep' }, { assert: 'variable', var: 'energia', gte: 95 }],
      },
      { store, author: 'agent', host: new RuntimeHost(store) },
    );
    if (!r.ok) throw new Error(r.error);
    const v = r.result as { passed: boolean; diagnosis: { likelySystems: { system: string; why: string[] }[]; failures: { variables?: Record<string, { writtenBy: unknown }> }[] } };
    expect(v.passed).toBe(false);
    expect(v.diagnosis.likelySystems.slice(0, 3).map((g) => g.system)).toEqual(['state machine', 'script scripts/pet.js', 'utility AI']);
    expect(v.diagnosis.failures[1].variables!.energia.writtenBy).toEqual(['scripts/pet.js']);
  });
});
