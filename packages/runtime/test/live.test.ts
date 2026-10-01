import { Game, type GameOp } from '@vibe/engine';
import { describe, expect, it } from 'vitest';
import { LivePlayer } from '../src';
import { demoProject } from './helpers';

function recorder(maxLag?: number) {
  const applied: GameOp[] = [];
  const player = new LivePlayer((op) => applied.push(op), maxLag);
  return { applied, player };
}

describe('LivePlayer', () => {
  it('spreads step ops over ticks at the requested pace', () => {
    const { applied, player } = recorder();
    player.push([{ op: 'keyDown', key: 'D' }, { op: 'step', frames: 10 }, { op: 'keyUp', key: 'D' }, { op: 'step', frames: 5 }]);
    expect(player.received).toBe(4);
    expect(player.backlog).toBe(15);

    expect(player.play(4)).toBe(4);
    expect(applied).toEqual([{ op: 'keyDown', key: 'D' }, { op: 'step', frames: 4 }]);
    expect(player.play(6)).toBe(6);
    // The key is released right after the last frame of the hold, before any later frame.
    expect(applied.slice(2)).toEqual([{ op: 'step', frames: 6 }, { op: 'keyUp', key: 'D' }]);
    expect(player.play(100)).toBe(5);
    expect(player.backlog).toBe(0);
    expect(player.play(3)).toBe(0);
  });

  it('fast-forwards when the view trails the run by more than the lag limit', () => {
    const { applied, player } = recorder(60);
    player.push([{ op: 'step', frames: 600 }]);
    expect(player.play(1)).toBe(540);
    expect(player.backlog).toBe(60);
    expect(applied).toEqual([{ op: 'step', frames: 540 }]);
  });

  it('applies restarts and scene loads in order, even with no frames to play', () => {
    const { applied, player } = recorder();
    player.push([{ op: 'step', frames: 2 }, { op: 'restart' }, { op: 'loadScene', scene: 'x' }]);
    player.play(2);
    expect(applied.map((o) => o.op)).toEqual(['step', 'restart', 'loadScene']);
  });

  it('reaches exactly the state of the original run', () => {
    const ops: GameOp[] = [
      { op: 'keyDown', key: 'D' },
      { op: 'step', frames: 33 },
      { op: 'keyDown', key: 'Space' },
      { op: 'step', frames: 9 },
      { op: 'keyUp', key: 'Space' },
      { op: 'step', frames: 36 },
      { op: 'keyUp', key: 'D' },
    ];
    const original = new Game(demoProject(), { seed: 1 });
    ops.forEach((op) => original.apply(op));

    const mirror = new Game(demoProject(), { seed: 1 });
    const player = new LivePlayer((op) => mirror.apply(op));
    player.push(ops.slice(0, 3));
    while (player.play(1)) {
      // one frame per tick, like the page at 60 fps
    }
    player.push(ops.slice(3));
    while (player.play(1)) {
      // the rest arrives later
    }
    expect(mirror.frame).toBe(original.frame);
    expect(mirror.getState()).toEqual(original.getState());
  });
});
