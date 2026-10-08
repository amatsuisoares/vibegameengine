import { describe, expect, it } from 'vitest';
import { Input, normalizeKey } from '../src';

describe('normalizeKey', () => {
  it.each([
    ['d', 'D'],
    ['KeyD', 'D'],
    ['SPACE', 'Space'],
    [' ', 'Space'],
    ['space', 'Space'],
    ['Digit1', '1'],
    ['left', 'ArrowLeft'],
    ['ArrowLeft', 'ArrowLeft'],
    ['esc', 'Escape'],
    ['ShiftLeft', 'Shift'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });
});

describe('Input', () => {
  it('latches a press+release that happens between frames', () => {
    const input = new Input({ jump: ['Space'] });
    input.keyDown('SPACE');
    input.keyUp('space');
    input.beginFrame();
    expect(input.wasPressed('Space')).toBe(true);
    expect(input.action('jump')).toBe(true);
    input.beginFrame();
    expect(input.action('jump')).toBe(false);
  });

  it('maps actions to any of their keys', () => {
    const input = new Input({ left: ['A', 'ArrowLeft'] });
    input.keyDown('ArrowLeft');
    input.beginFrame();
    expect(input.action('left')).toBe(true);
    expect(input.actionPressed('left')).toBe(true);
    input.beginFrame();
    expect(input.actionPressed('left')).toBe(false);
    expect(input.action('left')).toBe(true);
  });

  it('only reports an action released when no key of it is held', () => {
    const input = new Input({ jump: ['Space', 'W'] });
    input.keyDown('Space');
    input.keyDown('W');
    input.beginFrame();
    input.keyUp('Space');
    input.beginFrame();
    expect(input.actionReleased('jump')).toBe(false);
    input.keyUp('W');
    input.beginFrame();
    expect(input.actionReleased('jump')).toBe(true);
  });

  it('wantsText: true while a script reads the typed text (this frame or the previous one)', () => {
    const input = new Input();
    expect(input.wantsText).toBe(false);
    input.beginFrame();
    input.typed(); // a name field reads it every frame
    expect(input.wantsText).toBe(true);
    input.beginFrame();
    expect(input.wantsText).toBe(true); // still set before the scripts run again
    input.beginFrame();
    expect(input.wantsText).toBe(false); // nobody read it in the last frame
  });
});
