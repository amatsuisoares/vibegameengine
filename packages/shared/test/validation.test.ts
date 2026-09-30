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
