import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';

function table() {
  const card: EntityInput = { id: 'card', tags: ['draggable'], transform: { x: 100, y: 100 }, components: { Sprite: { width: 40, height: 60, layer: 2 } } };
  return Game.fromRaw({
    config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 },
    scenes: {
      main: {
        id: 'main',
        width: 400,
        height: 300,
        entities: [
          card,
          { id: 'slot', transform: { x: 300, y: 200 }, components: { Sprite: { width: 80, height: 80 } } },
          { id: 'button', transform: { x: 300, y: 50 }, components: { Sprite: { width: 40, height: 30 }, Script: { src: 'scripts/b.js' } } },
        ],
      },
    },
    scripts: {
      'scripts/b.js': [
        'function onClick(self, game) { game.vars.clicks = (game.vars.clicks || 0) + 1; }',
        'function onUpdate(self, game) {',
        '  if (game.input.doubleClicked) game.vars.doubles = (game.vars.doubles || 0) + 1;',
        '  const d = game.input.drag;',
        '  if (d) game.vars.dragging = d.entity + "@" + Math.round(d.x);',
        '}',
      ].join('\n'),
    },
  });
}

describe('mouse control and gestures', () => {
  it('a double click is two clicks, the second marked clicks: 2', () => {
    const g = table();
    g.perform([{ type: 'doubleClick', x: 300, y: 50 }, { type: 'wait', ms: 50 }]);
    expect(g.events(0, 'click').map((e) => e.clicks ?? 1)).toEqual([1, 2]);
    expect(g.world.vars).toMatchObject({ clicks: 2, doubles: 1 });
    expect(g.mouseTarget().lastClick).toMatchObject({ entity: 'button', clicks: 2 });

    // Two clicks far apart in time are not a double click.
    g.perform([{ type: 'click', x: 300, y: 50 }, { type: 'wait', ms: 500 }, { type: 'click', x: 300, y: 50 }, { type: 'wait', ms: 50 }]);
    expect(g.events(0, 'click').map((e) => e.clicks ?? 1)).toEqual([1, 2, 1, 1]);
  });

  it('dragging a "draggable" entity moves it and reports where it was dropped', () => {
    const g = table();
    g.perform([{ type: 'drag', from: { x: 100, y: 100 }, to: { x: 300, y: 200 }, ms: 300 }, { type: 'wait', ms: 50 }]);
    const card = g.entity('card')!;
    expect([card.x, card.y]).toEqual([300, 200]);
    expect(g.events(0, 'drag_start')).toEqual([expect.objectContaining({ entity: 'card', x: 100, y: 100 })]);
    expect(g.events(0, 'drag_end')).toEqual([expect.objectContaining({ entity: 'card', x: 300, y: 200, drop: 'slot' })]);
    expect(g.events(0, 'click')).toEqual([]); // the card is not clickable: a drag is not a click on it
  });

  it('an entity drawn only by its Text is picked at its Text layer: an emoji in front of a sprite takes the click and the drag', () => {
    const g = Game.fromRaw({
      config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 },
      scenes: {
        main: {
          id: 'main',
          width: 400,
          height: 300,
          entities: [
            { id: 'toy', tags: ['draggable', 'clickable'], transform: { x: 100, y: 100 }, components: { Text: { text: '🧸', layer: 8 }, Collider: { width: 40, height: 40, isTrigger: true } } },
            { id: 'pet', tags: ['clickable'], transform: { x: 120, y: 100 }, components: { Sprite: { width: 120, height: 120, layer: 5 } } },
          ],
        },
      },
    });
    g.perform([{ type: 'click', x: 100, y: 100 }, { type: 'wait', ms: 20 }]);
    expect(g.events(0, 'click').map((e) => e.entity)).toEqual(['toy']);
    expect(g.mouseTarget().under?.[0]).toBe('toy');
    g.perform([{ type: 'drag', from: { x: 100, y: 100 }, to: { x: 250, y: 100 } }, { type: 'wait', ms: 20 }]);
    expect(g.entity('toy')!.x).toBe(250);
  });

  it('keeps the grab offset, reports drags of other things, and scripts see the drag in progress', () => {
    const g = table();
    // Grab the card 10 px right of its center and move by (+50, +20): it keeps the offset.
    g.perform([{ type: 'drag', from: { x: 110, y: 100 }, to: { x: 160, y: 120 } }]);
    expect([g.entity('card')!.x, g.entity('card')!.y]).toEqual([150, 120]);

    // Dragging the (non-draggable) button: events, but it does not move.
    g.perform([{ type: 'mouseMove', x: 300, y: 50 }, { type: 'mouseDown' }, { type: 'wait', ms: 20 }, { type: 'mouseMove', x: 340, y: 60 }, { type: 'wait', ms: 20 }]);
    expect(g.mouseTarget().drag).toMatchObject({ entity: 'button', startX: 300, startY: 50, x: 340, y: 60 });
    expect(g.world.vars.dragging).toBe('button@340');
    g.perform([{ type: 'mouseUp' }, { type: 'wait', ms: 20 }]);
    expect(g.entity('button')!.x).toBe(300);
    expect(g.events(0, 'drag_end').at(-1)).toMatchObject({ entity: 'button', drop: null });
    expect(g.mouseTarget().drag).toBeUndefined();

    // A tiny wobble while clicking is still a click, not a drag.
    const before = g.events(0, 'drag_start').length;
    g.perform([{ type: 'mouseMove', x: 300, y: 50 }, { type: 'mouseDown' }, { type: 'wait', ms: 20 }, { type: 'mouseMove', x: 302, y: 51 }, { type: 'mouseUp' }, { type: 'wait', ms: 20 }]);
    expect(g.events(0, 'drag_start').length).toBe(before);
  });

  it('moves the mouse over an entity and drags between entities', () => {
    const g = table();
    g.perform([{ type: 'mouseMove', entity: 'button' }, { type: 'wait', ms: 20 }]);
    expect(g.mouseTarget().target!.id).toBe('button');
    g.perform([{ type: 'drag', from: { entity: 'card' }, to: { entity: 'slot' } }, { type: 'wait', ms: 20 }]);
    expect(g.events(0, 'drag_end')).toEqual([expect.objectContaining({ entity: 'card', drop: 'slot' })]);
  });
});
