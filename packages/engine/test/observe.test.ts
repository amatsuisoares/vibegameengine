import { describe, expect, it } from 'vitest';
import { Game } from '../src';

const game = () =>
  Game.fromRaw({
    config: { name: 't', startScene: 'main', gravity: 0, width: 400, height: 300 },
    scenes: {
      main: {
        id: 'main',
        width: 2000,
        height: 300,
        camera: { follow: 'hero' },
        entities: [
          { id: 'hero', tags: ['player'], transform: { x: 100, y: 150 }, components: { Sprite: { width: 20, height: 40 }, Collider: { width: 20, height: 40 } } },
          { id: 'near', transform: { x: 390, y: 150 }, components: { Sprite: { width: 40, height: 40 } } },
          { id: 'far', transform: { x: 1500, y: 150 }, components: { Sprite: { width: 40, height: 40 } } },
          { id: 'label', transform: { x: 50, y: 20 }, components: { Text: { text: 'hi' } } },
          { id: 'hidden', enabled: false, transform: { x: 120, y: 150 }, components: { Sprite: { width: 10, height: 10 } } },
          { id: 'invisible', transform: { x: 140, y: 150 }, components: { Sprite: { width: 10, height: 10, visible: false } } },
          { id: 'faded', transform: { x: 160, y: 150 }, components: { Sprite: { width: 10, height: 10, opacity: 0 } } },
          { id: 'wall', transform: { x: 180, y: 150 }, components: { Sprite: { width: 10, height: 10, visible: false }, Collider: { width: 10, height: 10 } } },
          { id: 'empty', transform: { x: 60, y: 60 }, components: { Text: { text: '' } } },
        ],
      },
    },
  });

describe('getState onScreen', () => {
  it('lists only active entities inside the viewport, with their box on screen', () => {
    const g = game();
    g.step(1);
    const s = g.getState({ onScreen: true });
    // far is off screen, hidden is disabled, invisible/faded/empty are not drawn; the invisible wall still counts.
    expect(s.entities.map((e) => e.id)).toEqual(['hero', 'near', 'label', 'wall']);
    expect(s.entities[0].screen).toEqual({ x: 90, y: 130, w: 20, h: 40 });
    expect(s.entities[1].screen).toEqual({ x: 370, y: 130, w: 40, h: 40 }); // partly visible counts
    expect(s.entities[2].screen).toEqual({ x: 50, y: 20, w: 0, h: 0 }); // no box: a point
    expect(g.getState().entities.every((e) => e.screen === undefined)).toBe(true);
  });
});
