import { fileURLToPath } from 'node:url';
import { Game, type GameEvent } from '@vibe/engine';
import type { Project } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { ProjectStore } from '../src';

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
    expect(pet.ai!.scores.passear).toBe(3);
    expect(pet.props).toMatchObject({ fome: expect.any(Number), brincalhao: expect.any(Boolean) });
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
});
