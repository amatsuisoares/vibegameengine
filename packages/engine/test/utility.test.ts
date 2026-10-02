import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { evaluateExpr, Game } from '../src';

type AI = NonNullable<NonNullable<EntityInput['components']>['UtilityAI']>;
type SM = NonNullable<NonNullable<EntityInput['components']>['StateMachine']>;

function game(entities: EntityInput[], scripts: Record<string, string> = {}, seed = 1) {
  return Game.fromRaw(
    { config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 }, scenes: { main: { id: 'main', width: 400, height: 300, entities } }, scripts: { 'scripts/needs.js': 'function onUpdate() {}', ...scripts } },
    { seed },
  );
}

/** A creature whose needs (0..100, 100 = satisfied) are Script props; the "needs" script lets them drop over time. */
const creature = (ai: AI, props: Record<string, number> = {}, sm?: SM, src = 'scripts/needs.js'): EntityInput => ({
  id: 'npc',
  transform: { x: 200, y: 150 },
  components: { Sprite: {}, Script: { src, props: { hunger: 80, energy: 80, fun: 80, ...props } }, UtilityAI: ai, ...(sm && { StateMachine: sm }) },
});
const needs = { 'scripts/needs.js': 'function onUpdate(self, game, dt) { self.props.hunger -= 10 * dt; }' };
const needsAI: AI = {
  options: {
    eat: { score: '1 - self.props.hunger / 100' },
    sleep: { score: '1 - self.props.energy / 100' },
    play: { score: '1 - self.props.fun / 100' },
  },
};
const choices = (g: Game) => g.events(0, 'ai_choice').map((e) => e.choice);
const snap = (g: Game) => g.getState({ ids: ['npc'] }).entities[0];

describe('UtilityAI', () => {
  it('chooses the highest score, shows the scores, and changes choice as the needs change', () => {
    const g = game([creature(needsAI, { fun: 40 })], needs);
    g.step(1);
    expect(snap(g).ai).toEqual({ choice: 'play', scores: { eat: 0.202, sleep: 0.2, play: 0.6 } }); // hunger already dropped 1 frame
    expect(g.events(0, 'ai_choice')[0]).toMatchObject({ entity: 'npc', choice: 'play', from: null, score: 0.6 });
    expect(snap(g).props).toMatchObject({ fun: 40 });
    g.advance(5000); // hunger 80 -> 30: eat (0.7) beats play (0.6 + inertia 0.1) once it is clearly higher
    expect(choices(g)).toEqual(['play', 'eat']);
    expect(snap(g).ai!.scores.eat).toBeGreaterThan(0.7);
  });

  it('inertia keeps the current choice against slightly better options', () => {
    const g = game([creature({ ...needsAI, intervalMs: 100 }, { fun: 40, hunger: 41 })], { 'scripts/needs.js': 'function onUpdate(self, game, dt) { self.props.hunger -= 1 * dt; }' });
    g.advance(3000); // eat creeps above play (0.6) but stays within the 0.1 inertia
    expect(choices(g)).toEqual(['play']);
  });

  it('options with a false "when", cooling down, or score <= 0 are left out; with none left the choice stays', () => {
    const ai: AI = {
      intervalMs: 100,
      options: {
        flee: { score: 5, when: 'vars.danger' },
        dash: { score: 2, cooldownMs: 1000 },
        rest: { score: 1 },
        never: { score: 'self.props.hunger - 1000' },
      },
    };
    const g = game([creature(ai)]);
    g.world.vars.danger = false;
    g.step(1);
    expect(snap(g).ai).toEqual({ choice: 'dash', scores: { flee: null, dash: 2, rest: 1, never: -920 } });
    g.advance(200); // still dash (current choice)
    g.world.vars.danger = true;
    g.advance(200);
    expect(snap(g).ai!.choice).toBe('flee');
    g.world.vars.danger = false;
    g.advance(200); // dash stopped being the choice 200 ms ago: cooling down, so rest
    expect(choices(g)).toEqual(['dash', 'flee', 'rest']);

    const none = game([creature({ intervalMs: 100, options: { a: { score: 0 }, b: { score: -1 } } })]);
    none.advance(500);
    expect(snap(none).ai).toEqual({ choice: null, scores: { a: 0, b: -1 } });
    expect(none.events(0, 'ai_choice')).toEqual([]);
  });

  it('cooldown blocks an option for a while after it stops being the choice', () => {
    const ai: AI = { intervalMs: 100, options: { treat: { score: 'vars.want', cooldownMs: 1000 }, idle: { score: 0.5 } } };
    const g = game([creature(ai)]);
    g.world.vars.want = 1;
    g.step(1); // treat
    g.world.vars.want = 0;
    g.advance(200); // idle
    g.world.vars.want = 1;
    g.advance(300); // treat stopped being the choice 400 ms ago: still cooling down (< 1000 ms)
    expect(snap(g).ai!.scores.treat).toBeNull();
    g.advance(700);
    expect(choices(g)).toEqual(['treat', 'idle', 'treat']);
  });

  it('weighted picks in proportion to the scores, reproducibly with the same seed', () => {
    const src = { 'scripts/m.js': "function onUpdate(self, game) { game.vars.picks = (game.vars.picks || '') + self.ai.decide()[0]; }" };
    const run = (seed: number) => {
      const g = game([creature({ select: 'weighted', intervalMs: 0, options: { a: { score: 3 }, b: { score: 1 } } }, {}, undefined, 'scripts/m.js')], src, seed);
      g.step(400);
      return String(g.world.vars.picks);
    };
    const picks = run(7);
    const share = [...picks].filter((c) => c === 'a').length / picks.length;
    expect(share).toBeGreaterThan(0.68);
    expect(share).toBeLessThan(0.82);
    expect(run(7)).toBe(picks);
    expect(run(8)).not.toBe(picks);
  });

  it('decides every intervalMs, only while decideWhen holds', () => {
    const ai: AI = { intervalMs: 1000, decideWhen: 'vars.awake', options: { a: { score: 'vars.a' }, b: { score: 'vars.b' } } };
    const g = game([creature(ai)]);
    Object.assign(g.world.vars, { awake: true, a: 1, b: 0 });
    g.step(1);
    Object.assign(g.world.vars, { a: 0, b: 1 });
    g.advance(500);
    expect(snap(g).ai!.choice).toBe('a'); // next decision at 1 s
    g.advance(600);
    expect(snap(g).ai!.choice).toBe('b');
    Object.assign(g.world.vars, { awake: false, a: 1, b: 0 });
    g.advance(3000);
    expect(snap(g).ai!.choice).toBe('b');
  });
});

describe('UtilityAI with a StateMachine and scripts', () => {
  const sm: SM = { initial: 'idle', states: { idle: {}, eat: {}, nap: {} } };

  it('enters the state with the option name, or the one in "state"', () => {
    const ai: AI = { intervalMs: 100, options: { eat: { score: 'vars.food' }, sleep: { score: 'vars.tired', state: 'nap' } } };
    const g = game([creature(ai, {}, sm)]);
    Object.assign(g.world.vars, { food: 1, tired: 0 });
    g.step(1);
    expect(snap(g).state).toBe('eat');
    Object.assign(g.world.vars, { food: 0, tired: 1 });
    g.advance(200);
    expect(snap(g)).toMatchObject({ state: 'nap', ai: { choice: 'sleep' } });
  });

  it('intervalMs 0 decides only on self.ai.decide(); onDecision sees new choices', () => {
    const script = `
      function onUpdate(self, game) {
        if (game.frame === 10 || game.frame === 20) game.vars.got = self.ai.decide();
        if (game.frame === 15) game.vars.food = 0;
      }
      function onDecision(self, d, game) { game.vars.log = (game.vars.log || '') + d.from + '>' + d.choice + ':' + d.scores.eat + ' '; }`;
    const g = game([creature({ intervalMs: 0, options: { eat: { score: 'vars.food' }, idle: { score: 0.5 } } }, {}, undefined, 'scripts/s.js')], { 'scripts/s.js': script });
    g.world.vars.food = 1;
    g.step(5);
    expect(snap(g).ai!.choice).toBeNull();
    g.step(20);
    expect(g.world.vars).toMatchObject({ got: 'idle', log: 'null>eat:1 eat>idle:0 ' });
  });

  it('a failing score disables that AI with ai_error', () => {
    const g = game([creature({ options: { a: { score: 'nope * 2' } } })]);
    g.step(3);
    expect(g.status).toBe('running');
    expect(g.events(0, 'ai_error')).toEqual([expect.objectContaining({ entity: 'npc', message: expect.stringMatching(/Unknown name "nope"/) })]);
    expect(g.console.read(0, 'error')).toHaveLength(1);
  });

  it('clamp() shapes scores', () => {
    const g = game([creature(needsAI)]);
    expect(evaluateExpr('clamp(150, 0, 100) + clamp(-5, 0, 1)', { game: g }).value).toBe(100);
  });
});

describe('UtilityAI targets (smart objects)', () => {
  /** A cat-like NPC choosing between toys by an expression over each candidate (nothing pet-specific in the engine). */
  const toys: EntityInput[] = [
    { id: 'yarn', tags: ['toy'], transform: { x: 300, y: 150 }, components: { Sprite: {}, Script: { src: 'scripts/needs.js', props: { fun: 3, noisy: false } } } },
    { id: 'bell', tags: ['toy'], transform: { x: 120, y: 150 }, components: { Sprite: {}, Script: { src: 'scripts/needs.js', props: { fun: 5, noisy: true } } } },
    { id: 'box', tags: ['toy'], enabled: false, transform: { x: 100, y: 150 }, components: { Sprite: {}, Script: { src: 'scripts/needs.js', props: { fun: 9, noisy: false } } } },
  ];
  const playAI = (score: string, when?: string): AI => ({ options: { play: { score, targets: { tag: 'toy', ...(when && { when }) } }, rest: { score: 1 } } });

  it('scores each candidate with `target`, picks the best one, and shows it (choice, target, per-option best)', () => {
    const g = game([creature(playAI('target.props.fun - distance(self, target) / 100')), ...toys]);
    g.step(1);
    // yarn: 3 - 1 = 2; bell: 5 - 0.8 = 4.2; box is disabled (never a candidate)
    expect(snap(g).ai).toEqual({ choice: 'play', target: 'bell', scores: { play: 4.2, rest: 1 }, targets: { play: 'bell' } });
    expect(g.events(0, 'ai_choice')[0]).toMatchObject({ entity: 'npc', choice: 'play', target: 'bell' });
  });

  it('targets.when filters candidates; a new target is a new decision; no candidate = option unavailable', () => {
    const g = game(
      [creature({ ...playAI('target.props.fun', '!target.props.noisy'), intervalMs: 100 }, {}, undefined, 'scripts/cat.js'), ...toys],
      { 'scripts/cat.js': "function onDecision(self, d, game) { game.vars.log = (game.vars.log || '') + d.choice + ':' + d.target + ' '; }" },
    );
    g.step(1);
    expect(snap(g).ai!.target).toBe('yarn'); // the bell is noisy
    g.entity('box')!.enabled = true;
    g.advance(200);
    expect(snap(g).ai!.target).toBe('box');
    expect(g.world.vars.log).toBe('play:yarn play:box ');
    for (const t of ['yarn', 'box']) g.entity(t)!.enabled = false;
    g.advance(200);
    expect(snap(g).ai).toMatchObject({ choice: 'rest', scores: { play: null, rest: 1 }, targets: { play: null } });
  });

  it('an error in a target expression names the candidate; `target` outside targets is an error', () => {
    const g = game([creature(playAI('target.props.fun * nope')), ...toys]);
    g.step(1);
    expect(g.events(0, 'ai_error')[0].message).toMatch(/Unknown name "nope"/);
    const h = game([creature({ options: { x: { score: 'target.x' } } })]);
    h.step(1);
    expect(h.events(0, 'ai_error')[0].message).toMatch(/"target" only exists in UtilityAI options with targets/);
  });
});

describe('UtilityAI sharpness', () => {
  it('weighted with sharpness k picks in proportion to score^k: the strongest option dominates more', () => {
    const share = (sharpness: number) => {
      let a = 0;
      for (let seed = 1; seed <= 400; seed++) {
        const g = game([creature({ select: 'weighted', sharpness, options: { a: { score: 3 }, b: { score: 1 } } })], {}, seed);
        g.step(1);
        if (snap(g).ai!.choice === 'a') a++;
      }
      return a / 400;
    };
    expect(share(1)).toBeCloseTo(0.75, 1); // 3 / (3 + 1)
    expect(share(2)).toBeCloseTo(0.9, 1); // 9 / (9 + 1)
  });

  it('weighted also draws the target (∝ score^k): the favorite wins most of the time, not always; targets still shows the best', () => {
    const toys: EntityInput[] = [
      { id: 'yarn', tags: ['toy'], transform: { x: 300, y: 150 }, components: { Sprite: {}, Script: { src: 'scripts/needs.js', props: { fun: 1 } } } },
      { id: 'bell', tags: ['toy'], transform: { x: 120, y: 150 }, components: { Sprite: {}, Script: { src: 'scripts/needs.js', props: { fun: 2 } } } },
      { id: 'rock', tags: ['toy'], transform: { x: 200, y: 150 }, components: { Sprite: {}, Script: { src: 'scripts/needs.js', props: { fun: 0 } } } },
    ];
    let bell = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const g = game([creature({ select: 'weighted', sharpness: 2, options: { play: { score: 'target.props.fun', targets: { tag: 'toy' } } } }), ...toys], {}, seed);
      g.step(1);
      const ai = snap(g).ai!;
      expect(ai.target).not.toBe('rock'); // score 0: never drawn
      expect(ai.targets).toEqual({ play: 'bell' });
      if (ai.target === 'bell') bell++;
    }
    expect(bell / 400).toBeCloseTo(0.8, 1); // 4 / (4 + 1)
  });
});
