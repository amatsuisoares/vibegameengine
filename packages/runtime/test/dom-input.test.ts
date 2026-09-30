import { Input } from '@vibe/engine';
import { describe, expect, it } from 'vitest';
import { attachDomInput, clientToViewport } from '../src';

function key(type: string, code: string, key = '', target?: object) {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, key });
  if (target) Object.defineProperty(e, 'target', { value: target });
  return e;
}

function pointer(type: string, clientX: number, clientY: number, button = 0) {
  return Object.assign(new Event(type, { cancelable: true }), { clientX, clientY, button });
}

function setup(onShellKey?: (code: string) => boolean) {
  let input = new Input({ jump: ['Space'] });
  const win = new EventTarget();
  // Canvas is 800x450 in viewport pixels but displayed at 400x225 CSS pixels, offset by (10, 20).
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 10, top: 20, width: 400, height: 225 }) });
  const detach = attachDomInput(() => input, { keyTarget: win, canvas, viewport: () => ({ width: 800, height: 450 }), onShellKey });
  const frame = () => input.beginFrame();
  return { get input() { return input; }, swap: (i: Input) => (input = i), win, canvas, detach, frame };
}

describe('clientToViewport', () => {
  it('maps CSS pixels to viewport pixels', () => {
    expect(clientToViewport(210, 132.5, { left: 10, top: 20, width: 400, height: 225 }, 800, 450)).toEqual({ x: 400, y: 225 });
  });
});

describe('attachDomInput', () => {
  it('feeds keyboard events into the virtual input using physical key codes', () => {
    const t = setup();
    t.win.dispatchEvent(key('keydown', 'KeyD', 'd'));
    t.frame();
    expect(t.input.isDown('D')).toBe(true);
    t.win.dispatchEvent(key('keyup', 'KeyD', 'd'));
    t.frame();
    expect(t.input.isDown('D')).toBe(false);
    expect(t.input.wasReleased('D')).toBe(true);
  });

  it('prevents page scrolling for Space and arrows but not for letters', () => {
    const t = setup();
    const space = key('keydown', 'Space', ' ');
    const d = key('keydown', 'KeyD', 'd');
    t.win.dispatchEvent(space);
    t.win.dispatchEvent(d);
    expect(space.defaultPrevented).toBe(true);
    expect(d.defaultPrevented).toBe(false);
    t.frame();
    expect(t.input.action('jump')).toBe(true);
  });

  it('ignores typing in form fields', () => {
    const t = setup();
    t.win.dispatchEvent(key('keydown', 'KeyA', 'a', { tagName: 'INPUT' }));
    t.frame();
    expect(t.input.isDown('A')).toBe(false);
  });

  it('lets the runtime consume shell keys', () => {
    const t = setup((code) => code === 'KeyR');
    const r = key('keydown', 'KeyR', 'r');
    t.win.dispatchEvent(r);
    t.frame();
    expect(r.defaultPrevented).toBe(true);
    expect(t.input.isDown('R')).toBe(false);
  });

  it('releases everything when the window loses focus', () => {
    const t = setup();
    t.win.dispatchEvent(key('keydown', 'ArrowLeft'));
    t.win.dispatchEvent(new Event('blur'));
    t.frame();
    t.frame();
    expect(t.input.isDown('ArrowLeft')).toBe(false);
  });

  it('maps pointer events to viewport coordinates and buttons', () => {
    const t = setup();
    t.canvas.dispatchEvent(pointer('pointerdown', 110, 70, 2));
    t.frame();
    expect(t.input.mouse).toEqual({ x: 200, y: 100 });
    expect(t.input.isMouseDown('right')).toBe(true);
    t.canvas.dispatchEvent(pointer('pointerup', 110, 70, 2));
    t.canvas.dispatchEvent(pointer('pointermove', 410, 245));
    t.frame();
    expect(t.input.isMouseDown('right')).toBe(false);
    expect(t.input.mouse).toEqual({ x: 800, y: 450 });
  });

  it('follows the current Input after the game is replaced, and detaches cleanly', () => {
    const t = setup();
    const next = new Input();
    t.swap(next);
    t.win.dispatchEvent(key('keydown', 'KeyW'));
    next.beginFrame();
    expect(next.isDown('W')).toBe(true);
    t.detach();
    t.win.dispatchEvent(key('keydown', 'KeyS'));
    next.beginFrame();
    expect(next.isDown('S')).toBe(false);
  });
});
