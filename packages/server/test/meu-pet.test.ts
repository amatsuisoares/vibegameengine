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

describe('meu-pet (regression)', () => {
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
    expect(pet.ai!.scores.passear).toBeCloseTo(1 + pet.traits!.atividade * 2 + pet.traits!.curiosidade, 2); // trait() in the scores
    expect(pet.props).toMatchObject({ fome: expect.any(Number) });
    expect(Object.keys(pet.traits!).sort()).toEqual(['apetite', 'atividade', 'brincadeira', 'curiosidade', 'independencia', 'paciencia', 'sensibilidade', 'sociabilidade']);
    expect(game.events(0, 'ai_choice').filter((e) => e.entity === 'pet').length).toBeGreaterThan(1);

    // Observations and saving run on engine timers.
    expect(pet.timers!.map((t) => t.id).sort()).toEqual(['observar', 'salvar']);
    expect(game.events(0, 'observacao').length).toBeGreaterThan(1);

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
    expect(pet).toMatchObject({ version: 2, name: 'Kuro', stage: 'bebe', bowl: 2, care: v1.care, revealed: { 'brincadeira:alto': 3, 'paciencia:baixo': 1 } });
    expect(pet.traits).toBeUndefined();
    expect((pet.needs as Record<string, number>).fome).toBeCloseTo(66, 0);
    const individual = game.storage.get('petIndividuo') as { traits: Record<string, number>; preferences: Record<string, unknown> };
    expect(individual.traits).toMatchObject({ brincadeira: 0.85, atividade: 0.15 }); // preguiçoso wins over brincalhão's 0.7
    expect(Object.keys(individual.preferences)).toEqual(expect.arrayContaining(['carinho', 'bola', 'racao', 'escuro']));
    expect(game.storage.get('colecao')).toEqual(colecao);
    game.perform([{ type: 'click', entity: 'botaoDiario' }, { type: 'wait', ms: 100 }]);
    expect(game.entity('diarioTexto')!.components.Text!.text).toContain('Parece ser: brincalhão');
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
      g.advance(150_000); // 2.5 h of game time, nobody around
      const choices: Record<string, number> = {};
      for (const e of g.events(0, 'ai_choice')) if (e.entity === 'pet') choices[String(e.choice)] = (choices[String(e.choice)] ?? 0) + 1;
      const states = new Set(g.events(0, 'state_change').filter((e) => e.entity === 'pet').map((e) => String(e.to)));
      return { choices, states, vars: g.world.vars, errors: g.console.read(0, 'error') };
    };
    const lively = live('Faísca', { atividade: 0.9, sociabilidade: 0.8, curiosidade: 0.9, independencia: 0.2, sensibilidade: 0.3, apetite: 0.8, paciencia: 0.7, brincadeira: 0.9 }, { bola: p(0.8), carinho: p(0.6) });
    const calm = live('Sereno', { atividade: 0.1, sociabilidade: 0.2, curiosidade: 0.1, independencia: 0.9, sensibilidade: 0.6, apetite: 0.2, paciencia: 0.8, brincadeira: 0.1 }, { bola: p(-0.6), carinho: p(-0.2) });
    expect(lively.errors).toEqual([]);
    expect(calm.errors).toEqual([]);
    const moving = (c: Record<string, number>) => (c.passear ?? 0) + (c.investigar ?? 0) + (c.brincar ?? 0);
    // ai_choice counts changes of choice (seed 11: lively moves 18 times and idles once; calm 10 and 11).
    expect(moving(lively.choices)).toBeGreaterThan(moving(calm.choices) * 1.5);
    expect(calm.choices.parado ?? 0).toBeGreaterThan((lively.choices.parado ?? 0) * 3);
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
    expect(game.events(0, 'observacao').at(-1)!.text).toBe('Mimi não parece estar com fome agora.');
    expect(game.events(0, 'reacao')).toEqual([]);
    expect(game.world.withTag('oferta')).toEqual([]);
    expect(game.economy.inventory().count('maca')).toBe(1); // refused: still yours
    expect(game.console.read(0, 'error')).toEqual([]);
  });

  it('economy: a welcome basket once, coins for a new day and for discovering a taste, buying in the shop, food leaves the bag only when eaten', () => {
    const game = new Game(load(), { seed: 4, clock: { start: '2026-03-10T10:00:00Z' } });
    game.perform([{ type: 'wait', ms: 200 }, { type: 'type', text: 'Mimi\n' }, { type: 'wait', ms: 500 }]);
    expect(game.getState().wallet).toEqual({ moedas: 15 });
    expect(game.getState().inventories).toEqual({ default: { maca: 1, cenoura: 1, leite: 1, biscoito: 1 } });
    expect(game.entity('botaoLoja')!.components.Text!.text).toBe('Loja · 15 🪙');

    // Shop: 7 foods for sale; buy a fish (8) and two carrots (2 each); then not enough for cheese (6 > 3).
    game.perform([{ type: 'click', entity: 'botaoLoja' }, { type: 'wait', ms: 50 }]);
    const shop = game.world.withTag('cartaLoja');
    expect(shop.map((c) => c.components.Script!.props.item)).toEqual(['banana', 'biscoito', 'cenoura', 'leite', 'maca', 'peixe', 'queijo']);
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
    expect(game.economy.inventory().size).toBe(0);
    expect(game.events(0, 'observacao').filter((e) => String(e.kind).startsWith('comida:')).map((e) => e.kind)).toEqual(['comida:cenoura', 'comida:maca']);

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
