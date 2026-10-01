import { describe, expect, it } from 'vitest';
import { parseProject, parseScene } from '../src';

const project = (entities: unknown[], extra: Record<string, unknown> = {}) => ({
  config: { name: 'p', startScene: 'main' },
  scenes: { main: { id: 'main', entities, ...extra } },
});

describe('project schema', () => {
  it('fills defaults so minimal data is enough', () => {
    const r = parseProject(project([{ id: 'box', components: { Body: {}, Collider: {} } }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.value.scenes.main.entities[0];
    expect(e.transform).toEqual({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 });
    expect(e.components.Body).toMatchObject({ type: 'dynamic', vx: 0, gravityScale: 1 });
    expect(e.components.Collider).toMatchObject({ width: 32, height: 32, isTrigger: false });
    expect(r.value.config.actions.jump).toContain('Space');
  });

  it('does not share default arrays between entities', () => {
    const r = parseProject(project([
      { id: 'a', components: { Damage: {} } },
      { id: 'b', components: { Damage: {} } },
    ]));
    if (!r.ok) throw new Error(r.errors.join());
    const [a, b] = r.value.scenes.main.entities;
    a.components.Damage!.targetTags.push('x');
    expect(b.components.Damage!.targetTags).toEqual(['player']);
  });

  it('rejects unknown components with a path that names the entity', () => {
    const r = parseProject(project([{ id: 'hero', components: { Jetpack: {} } }]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain('scenes.main.entities[0](hero).components');
    expect(r.errors[0]).toContain('Jetpack');
  });

  it('reports invalid enum values', () => {
    const r = parseProject(project([{ id: 'hero', components: { Body: { type: 'flying' } } }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/entities\[0\]\(hero\)\.components\.Body\.type/);
  });

  it('rejects bad ids', () => {
    const r = parseProject(project([{ id: '1 bad id' }]));
    expect(r.ok).toBe(false);
  });

  it('detects duplicate ids and dangling references', () => {
    const r = parseProject(project([{ id: 'a' }, { id: 'a' }], { camera: { follow: 'ghost' } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('duplicate entity id "a"');
    expect(r.errors.join('\n')).toContain('"ghost" does not exist');
  });

  it('detects a missing start scene and bad Goal scene', () => {
    const raw = {
      config: { name: 'p', startScene: 'nope' },
      scenes: { main: { id: 'main', entities: [{ id: 'g', components: { Goal: { action: 'loadScene', scene: 'level9' } } }] } },
    };
    const r = parseProject(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toContain('config.startScene');
    expect(r.errors.join('\n')).toContain('scene "level9" does not exist');
  });

  it('checks asset declarations', () => {
    const raw = {
      config: {
        name: 'p',
        startScene: 'main',
        assets: [
          { id: 'sheet', type: 'spritesheet', path: 'hero.png' },
          { id: 'evil', type: 'image', path: '../secret.png' },
          { id: 'ok', type: 'spritesheet', path: 'sprites/coin.png', frameWidth: 16, frameHeight: 16 },
        ],
      },
      scenes: { main: { id: 'main' } },
    };
    const r = parseProject(raw);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toContain('config.assets(sheet): spritesheets need frameWidth and frameHeight');
    expect(r.errors[1]).toContain('config.assets(evil).path');
  });

  it('warns about suspicious setups without failing', () => {
    const r = parseScene({ id: 's', entities: [{ id: 'p', components: { Body: {} } }] });
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toContain('without Collider');
  });
});

describe('Interactable', () => {
  const door = (interactable: Record<string, unknown> = {}) => ({ id: 'door', components: { Sprite: {}, Interactable: interactable } });

  it('fills defaults, adds the "interact" action and checks its sound', () => {
    const r = parseProject(project([door()]));
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.value.scenes.main.entities[0].components.Interactable).toEqual({
      action: 'use',
      via: ['click', 'key'],
      key: 'interact',
      actorTags: ['player'],
      range: 32,
      cooldownMs: 0,
      once: false,
      enabled: true,
    });
    expect(r.value.config.actions.interact).toEqual(['E']);
    const bad = parseProject(project([door({ sound: 'nope' })]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toEqual(['scenes.main.entities(door).components.Interactable.sound: audio asset "nope" does not exist']);
  });

  it('warns when the key is an action the project does not define', () => {
    const r = parseProject({ ...project([door({ via: ['key'] })]), config: { name: 'p', startScene: 'main', actions: { left: ['A'] } } });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([expect.stringContaining('Interactable.key: "interact" is not an input action')]);
    expect(parseProject({ ...project([door({ via: ['click'] })]), config: { name: 'p', startScene: 'main', actions: {} } }).warnings).toEqual([]);
  });

  it('rules may target "$entity" only with event and enter triggers', () => {
    const rule = (when: unknown) => ({ id: 'r', when, do: [{ action: 'destroy', target: '$entity' }] });
    expect(parseProject(project([door()], { rules: [rule({ event: 'interact' })] })).ok).toBe(true);
    const r = parseProject(project([door()], { rules: [rule({ start: true })] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('"$entity" only works with "enter" and "event" triggers');
  });
});

describe('StateMachine', () => {
  const guard = (sm: Record<string, unknown>) => ({ id: 'guard', components: { StateMachine: sm } });
  const errors = (sm: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const r = parseProject(project([guard(sm), { id: 'door' }], extra));
    return r.ok ? [] : r.errors;
  };

  it('accepts minimal machines and fills defaults', () => {
    const r = parseProject(project([guard({ initial: 'idle', states: { idle: {} } })]));
    if (!r.ok) throw new Error(r.errors.join());
    expect(r.value.scenes.main.entities[0].components.StateMachine).toEqual({ initial: 'idle', states: { idle: { enter: [], exit: [], transitions: [] } }, transitions: [] });
  });

  it('checks states, transition targets and action targets', () => {
    expect(errors({ initial: 'idle', states: {} })[0]).toContain('needs at least one state');
    expect(
      errors({
        initial: 'idel',
        transitions: [{ to: 'dead' }],
        states: {
          idle: {
            enter: [{ action: 'setEnabled', target: 'door', enabled: false }, { action: 'destroy', target: '$by' }, { action: 'destroy', target: 'ghost' }],
            transitions: [{ to: 'run' }],
          },
        },
      }),
    ).toEqual([
      'scenes.main.entities(guard).components.StateMachine.initial: state "idel" does not exist (states: idle)',
      'scenes.main.entities(guard).components.StateMachine.transitions[0].to: state "dead" does not exist (states: idle)',
      'scenes.main.entities(guard).components.StateMachine.states.idle.transitions[0].to: state "run" does not exist (states: idle)',
      'scenes.main.entities(guard).components.StateMachine.states.idle.enter[1].target: "$by" is not available in states (use "$self" or an entity id)',
      'scenes.main.entities(guard).components.StateMachine.states.idle.enter[2].target: entity "ghost" does not exist',
    ]);
  });

  it('"$self" is for states, not rules; state sounds are checked', () => {
    const rule = { id: 'r', when: { event: 'x' }, do: [{ action: 'destroy', target: '$self' }] };
    expect(errors({ initial: 'a', states: { a: {} } }, { rules: [rule] })).toEqual(['scenes.main.rules(r).do[0].target: "$self" is not a rule target']);
    expect(errors({ initial: 'a', states: { a: { enter: [{ action: 'playSound', asset: 'boom' }] } } })).toEqual([
      'scenes.main.entities(guard).components.StateMachine.states.a.enter[0].asset: audio asset "boom" does not exist',
    ]);
  });
});

describe('UtilityAI', () => {
  it('fills defaults and checks the states its options name', () => {
    const ok = parseProject(project([{ id: 'npc', components: { UtilityAI: { options: { eat: { score: 1 } } } } }]));
    if (!ok.ok) throw new Error(ok.errors.join());
    expect(ok.value.scenes.main.entities[0].components.UtilityAI).toEqual({
      options: { eat: { score: 1, cooldownMs: 0 } },
      select: 'best',
      intervalMs: 500,
      inertia: 0.1,
      noise: 0,
    });
    const noMachine = parseProject(project([{ id: 'npc', components: { UtilityAI: { options: { eat: { score: 1, state: 'eating' } } } } }]));
    expect(noMachine.ok ? [] : noMachine.errors).toEqual(['scenes.main.entities(npc).components.UtilityAI.options.eat.state: the entity has no StateMachine']);
    const wrong = parseProject(
      project([{ id: 'npc', components: { StateMachine: { initial: 'idle', states: { idle: {} } }, UtilityAI: { options: { eat: { score: 1, state: 'eating' } } } } }]),
    );
    expect(wrong.ok ? [] : wrong.errors).toEqual(['scenes.main.entities(npc).components.UtilityAI.options.eat.state: state "eating" does not exist (states: idle)']);
    expect(parseProject(project([{ id: 'npc', components: { UtilityAI: { options: {} } } }])).ok).toBe(false);
  });
});
