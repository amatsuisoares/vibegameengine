import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { evaluateExpr, Game } from '../src';

const box = (id: string, x: number, y: number, size: number, components: EntityInput['components'] = {}, layer = 0): EntityInput => ({
  id,
  transform: { x, y },
  components: { Sprite: { width: size, height: size, layer }, ...components },
});

function room() {
  return Game.fromRaw({
    config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 },
    scenes: {
      main: {
        id: 'main',
        width: 400,
        height: 300,
        vars: { power: 0 },
        entities: [
          { id: 'bg', transform: { x: 200, y: 150 }, components: { Sprite: { width: 400, height: 300, layer: -10 } } },
          box('bed', 100, 200, 60, { Interactable: { action: 'sleep', via: ['click'], cooldownMs: 1000 } }),
          box('lamp', 300, 80, 40, { Interactable: { action: 'light', via: ['click'], condition: 'vars.power > 0' } }),
          box('button', 300, 250, 30, { Script: { src: 'scripts/button.js' } }),
          box('rug', 100, 215, 40, {}, 5), // drawn over the bed, not clickable
        ],
      },
    },
    scripts: {
      'scripts/button.js': "function onClick(self, game) { game.vars.pressed = 1; }\nfunction onUpdate(self, game) { const h = game.input.hovered; game.vars.hover = h ? h.id : ''; }",
    },
  });
}

describe('mouse perception', () => {
  it('says what a click would reach, what is drawn on top and the whole stack', () => {
    const g = room();
    g.perform([{ type: 'mouseMove', x: 90, y: 190 }, { type: 'wait', ms: 20 }]);
    const t = g.mouseTarget();
    expect(t.screen).toEqual({ x: 90, y: 190 });
    expect(t.world).toEqual({ x: 90, y: 190 });
    expect(t.insideViewport).toBe(true);
    expect(t.target).toMatchObject({
      id: 'bed',
      distance: 0,
      clickable: true,
      handlers: ['interactable'],
      screen: { x: 70, y: 170, w: 60, h: 60 },
      interactable: { action: 'sleep', enabled: true, uses: 0, ready: true },
    });
    expect(t.hovered!.id).toBe('bed');
    expect(t.under).toEqual(['bed', 'bg']);
    expect(t.nearest).toBeUndefined();

    // The rug is drawn on top of the bed's lower part: hovered = rug, but a click still reaches the bed.
    g.perform([{ type: 'mouseMove', x: 100, y: 220 }, { type: 'wait', ms: 20 }]);
    const over = g.mouseTarget();
    expect(over.hovered).toMatchObject({ id: 'rug', clickable: false, handlers: [] });
    expect(over.target!.id).toBe('bed');
    expect(over.under).toEqual(['rug', 'bed', 'bg']);
  });

  it('points to the nearest clickable entity when the mouse misses, and explains blocked interactions', () => {
    const g = room();
    g.perform([{ type: 'mouseMove', x: 160, y: 200 }, { type: 'wait', ms: 20 }]);
    const miss = g.mouseTarget();
    expect(miss.target).toBeNull();
    expect(miss.hovered!.id).toBe('bg');
    expect(miss.nearest).toMatchObject({ id: 'bed', distance: 30 });

    g.perform([{ type: 'mouseMove', x: 300, y: 80 }, { type: 'wait', ms: 20 }]);
    expect(g.mouseTarget().target!.interactable).toEqual({ action: 'light', enabled: true, uses: 0, ready: false, blocked: 'condition' });
    g.perform([{ type: 'mouseMove', x: 300, y: 250 }, { type: 'wait', ms: 20 }]);
    expect(g.mouseTarget().target).toMatchObject({ id: 'button', handlers: ['onClick'] });
    expect(g.mouseTarget().target!.interactable).toBeUndefined();

    // After a click the bed cools down: the target says so, with the time left.
    g.perform([{ type: 'click', x: 100, y: 190 }, { type: 'mouseMove', x: 100, y: 190 }, { type: 'wait', ms: 100 }]);
    expect(g.mouseTarget().target!.interactable).toMatchObject({ uses: 1, ready: false, blocked: 'cooldown', cooldownMs: expect.any(Number) });
    expect(g.mouseTarget().lastClick).toMatchObject({ x: 100, y: 190, entity: 'bed' });
  });

  it('records clicks on empty space, has no side effects, and is visible to expressions and scripts', () => {
    const g = room();
    g.perform([{ type: 'click', x: 200, y: 20 }]);
    expect(g.mouseTarget().lastClick).toMatchObject({ x: 200, y: 20, world: { x: 200, y: 20 }, entity: null });
    const events = g.events().length;
    g.mouseTarget();
    expect(g.events().length).toBe(events);

    g.perform([{ type: 'mouseMove', x: 300, y: 250 }, { type: 'wait', ms: 50 }]);
    expect(evaluateExpr("mouse.target == 'button' && mouse.hovered == 'button' && mouse.x == 300", { game: g }).value).toBe(true);
    expect(g.world.vars.hover).toBe('button');
    g.perform([{ type: 'mouseMove', x: 10, y: 10 }, { type: 'wait', ms: 50 }]);
    expect(evaluateExpr('mouse.target', { game: g }).value).toBeNull();
    expect(g.world.vars.hover).toBe('');
  });
});
