import { Input } from '@vibe/engine';
import { describe, expect, it } from 'vitest';
import { attachTextField, textDiff } from '../src';

function fakeField() {
  const t = new EventTarget();
  const f = Object.assign(t, {
    value: '',
    focused: false,
    focus() {
      f.focused = true;
    },
    blur() {
      f.focused = false;
      f.dispatchEvent(new Event('blur'));
    },
    /** What the phone keyboard does: changes the value, then fires "input". */
    typeAs(value: string, isComposing = false) {
      f.value = value;
      f.dispatchEvent(Object.assign(new Event('input'), { isComposing }));
    },
    key(key: string) {
      f.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key }));
    },
  });
  return f;
}

const tap = (pointerType: string) => Object.assign(new Event('pointerup', { cancelable: true }), { pointerType });

function setup() {
  const input = new Input();
  const canvas = new EventTarget();
  const field = fakeField();
  const tf = attachTextField(() => input, canvas, field);
  // The game reads the typed text each frame (like a name field does).
  let typed = '';
  const frame = (reading = true) => {
    input.beginFrame();
    if (reading) typed += input.typed();
    tf.sync();
  };
  return { input, canvas, field, tf, frame, typed: () => typed };
}

describe('textDiff', () => {
  it('turns a change of the field into Backspaces and new characters', () => {
    expect(textDiff('', 'B')).toBe('B');
    expect(textDiff('Bol', 'Bolinha')).toBe('inha');
    expect(textDiff('Bolinha', 'Boli')).toBe('\b\b\b');
    expect(textDiff('bolin', 'Bolinha')).toBe('\b\b\b\b\bBolinha'); // a suggestion rewrote the word
    expect(textDiff('', '🐶a')).toBe('🐶a');
  });
});

describe('attachTextField (phone keyboard)', () => {
  it('a touch while the game reads text opens the keyboard; typing there reaches the game', () => {
    const t = setup();
    t.frame();
    t.canvas.dispatchEvent(tap('touch'));
    expect(t.field.focused).toBe(true);
    expect(t.tf.open).toBe(true);
    t.field.typeAs('Bo');
    t.field.typeAs('Bol');
    t.field.typeAs('Bolinga', true); // composing: wait
    t.field.typeAs('Bolinha');
    t.frame();
    t.field.typeAs('Bolinh');
    t.field.key('Enter');
    t.frame();
    expect(t.typed()).toBe('Bolinha\b\n');
    expect(t.field.value).toBe('');
  });

  it('Backspace on an empty field still erases in the game', () => {
    const t = setup();
    t.frame();
    t.canvas.dispatchEvent(tap('touch'));
    t.field.key('Backspace');
    t.frame();
    expect(t.typed()).toBe('\b');
  });

  it('a mouse click does not open it (physical keyboard), nor a touch when the game is not reading text', () => {
    const t = setup();
    t.frame();
    t.canvas.dispatchEvent(tap('mouse'));
    expect(t.field.focused).toBe(false);
    t.frame(false);
    t.frame(false);
    t.canvas.dispatchEvent(tap('touch'));
    expect(t.field.focused).toBe(false);
  });

  it('closes the keyboard when the game stops reading text (e.g. the name was accepted)', () => {
    const t = setup();
    t.frame();
    t.canvas.dispatchEvent(new Event('touchend', { cancelable: true }));
    expect(t.tf.open).toBe(true);
    t.frame(false);
    expect(t.tf.open).toBe(true); // one frame of grace
    t.frame(false);
    expect(t.tf.open).toBe(false);
    expect(t.field.focused).toBe(false);
  });
});
