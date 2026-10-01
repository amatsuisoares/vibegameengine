import type { EntityInput } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { Game } from '../src';
import { ground, GROUND_TOP, player } from './helpers';

type Animator = NonNullable<NonNullable<EntityInput['components']>['Animator']>;

const ASSETS = [
  { id: 'sheet', type: 'spritesheet', path: 's.png', frameWidth: 16, frameHeight: 16 },
  { id: 'attack_sheet', type: 'spritesheet', path: 'a.png', frameWidth: 16, frameHeight: 16 },
  { id: 'cat_1', type: 'image', path: 'c1.png' },
  { id: 'cat_2', type: 'image', path: 'c2.png' },
  { id: 'step', type: 'audio', path: 'step.wav' },
];

function game(entities: EntityInput[], scripts: Record<string, string> = {}, gravity = 0) {
  return Game.fromRaw({
    config: { name: 't', startScene: 'main', gravity, assets: ASSETS, sounds: { footstep: 'step' } },
    scenes: { main: { id: 'main', width: 3000, entities } },
    scripts,
  });
}

const actor = (animator: Animator, components: EntityInput['components'] = {}): EntityInput => ({
  id: 'cat',
  transform: { x: 100, y: 100 },
  components: { Sprite: { asset: 'sheet' }, Animator: animator, ...components },
});
const sprite = (g: Game) => g.entity('cat')!.components.Sprite!;
const anim = (g: Game) => g.getState({ ids: ['cat'] }).entities[0].anim;

describe('Animator', () => {
  it('keeps the automatic idle/run/jump of platformer bodies', () => {
    const g = Game.fromRaw({
      config: { name: 't', startScene: 'main', assets: ASSETS },
      scenes: {
        main: {
          id: 'main',
          width: 3000,
          entities: [
            ground('g', 0, 3000),
            player(100, GROUND_TOP - 16, { Sprite: { asset: 'sheet' }, Animator: { animations: { idle: { frames: [0] }, run: { frames: [1, 2], fps: 10 }, jump: { frames: [3] } } } }),
          ],
        },
      },
    });
    g.step(2);
    expect(g.getState({ ids: ['player'] }).entities[0].anim).toEqual({ clip: 'idle', frame: 0 });
    g.perform([{ type: 'keyDown', key: 'D' }, { type: 'wait', ms: 300 }]);
    expect(g.getState({ ids: ['player'] }).entities[0].anim!.clip).toBe('run');
    g.perform([{ type: 'tap', key: 'Space' }, { type: 'wait', ms: 100 }]);
    expect(g.getState({ ids: ['player'] }).entities[0].anim!.clip).toBe('jump'); // no "fall" clip: jump is used
    expect(g.entity('player')!.components.Sprite!.frame).toBe(3);
  });

  it('follows the StateMachine: a clip with the state name, or the one in "states"', () => {
    const g = game([
      actor(
        { animations: { idle: { frames: [0] }, walk: { frames: [1, 2], fps: 4 }, nap: { frames: [5] } }, states: { sleeping: 'nap' } },
        { StateMachine: { initial: 'idle', states: { idle: { transitions: [{ to: 'walk', after: 100 }] }, walk: { transitions: [{ to: 'sleeping', after: 1000 }] }, sleeping: { transitions: [{ to: 'dazed', after: 500 }] }, dazed: {} } } },
      ),
    ]);
    g.step(1);
    expect(anim(g)!.clip).toBe('idle');
    g.advance(400); // walk since ~100 ms: frame 1 after 250 ms
    expect(anim(g)).toEqual({ clip: 'walk', frame: 1 });
    expect(sprite(g).frame).toBe(2);
    g.advance(1000);
    expect(anim(g)!.clip).toBe('nap');
    g.advance(600); // "dazed" has no clip: back to the base clip
    expect(anim(g)!.clip).toBe('idle');
  });

  it('frames can be image assets; a clip can use its own spritesheet', () => {
    const g = game([actor({ initial: 'blink', animations: { blink: { frames: ['cat_1', 'cat_2'], fps: 2 }, attack: { frames: [0, 1], asset: 'attack_sheet' } } })]);
    g.step(1);
    expect(sprite(g)).toMatchObject({ asset: 'cat_1', frame: 0 });
    g.advance(500);
    expect(sprite(g).asset).toBe('cat_2');
    g.entity('cat')!.animOverride = 'attack';
    g.step(1);
    expect(sprite(g)).toMatchObject({ asset: 'attack_sheet', frame: 0 });
  });

  it('speed scales playback; 0 pauses it', () => {
    const clip = { animations: { idle: { frames: [0, 1, 2, 3], fps: 4 } } };
    const g = game([actor({ ...clip, speed: 2 })]);
    g.advance(500); // 0.5 s x speed 2 x 4 fps = step 4: the 4-frame loop wraps to frame 0
    expect(anim(g)!.frame).toBe(0);
    g.advance(125);
    expect(anim(g)!.frame).toBe(1);
    g.entity('cat')!.components.Animator!.speed = 0;
    g.advance(1000);
    expect(anim(g)!.frame).toBe(1);
  });

  it('a one-shot holds its last frame, emits anim_end once and moves on to "next"', () => {
    const g = game([actor({ initial: 'spawn', animations: { spawn: { frames: [7, 8], fps: 10, loop: false, next: 'idle' }, idle: { frames: [0] } } })]);
    g.advance(150);
    expect(sprite(g).frame).toBe(8);
    g.advance(100);
    expect(g.events(0, 'anim_end')).toEqual([expect.objectContaining({ entity: 'cat', anim: 'spawn' })]);
    g.step(2);
    expect(anim(g)!.clip).toBe('idle');
    expect(g.events(0, 'anim_end')).toHaveLength(1);
  });

  it('frame events fire every time the frame shows (and can play sounds through config.sounds)', () => {
    const g = game([actor({ animations: { idle: { frames: [0, 1, 2, 3], fps: 8, events: { '1': 'footstep', '3': 'footstep' } } } })]);
    g.advance(1000); // 2 cycles
    expect(g.events(0, 'footstep').map((e) => e.frame)).toEqual([1, 3, 1, 3]);
    expect(g.events(0, 'sound').filter((e) => e.cause === 'footstep')).toHaveLength(4);

    const fast = game([actor({ animations: { idle: { frames: [0, 1, 2], fps: 120, events: { '1': 'tick' } } } })]);
    fast.advance(1000); // 120 frames shown at 60 steps/s: none of the frame-1 events is skipped
    expect(fast.events(0, 'tick')).toHaveLength(40);
  });
});

describe('Animator from scripts', () => {
  it('self.anim plays a clip over the state/auto choice, returns after a one-shot, and stops a looping one', () => {
    const script = `
      function onUpdate(self, game) {
        if (game.frame === 5) self.anim.play('wave');
        if (game.frame === 40) { game.vars.after = self.anim.name; self.anim.play('dance'); }
        if (game.frame === 50) { game.vars.dancing = self.anim.name + ':' + self.anim.frame; self.anim.stop(); }
        if (game.frame === 52) { game.vars.stopped = self.anim.name; self.anim.speed = 3; }
        if (game.frame === 55) self.anim.play('nope');
      }`;
    const g = game(
      [actor({ animations: { idle: { frames: [0] }, wave: { frames: [1, 2], fps: 10, loop: false }, dance: { frames: [3, 4], fps: 10 } } }, { Script: { src: 'scripts/s.js' } })],
      { 'scripts/s.js': script },
    );
    g.step(8);
    expect(anim(g)!.clip).toBe('wave');
    g.step(50);
    expect(g.world.vars).toMatchObject({ after: 'idle', dancing: 'dance:1', stopped: 'idle' });
    expect(g.entity('cat')!.components.Animator!.speed).toBe(3);
    expect(g.events(0, 'script_error')[0].message).toMatch(/animation "nope" does not exist \(animations: idle, wave, dance\)/);
  });
});
