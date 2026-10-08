import type { Input } from '@vibe/engine';

/** The part of an <input> the text field uses (a fake in unit tests). */
export interface TextFieldElement extends EventTarget {
  value: string;
  focus(): void;
  blur(): void;
}

interface PointerLike extends Event {
  pointerType?: string;
}
interface KeyLike extends Event {
  key: string;
}
interface InputLike extends Event {
  isComposing?: boolean;
}

/**
 * Edits that turn the field's text `before` into `after`: Backspaces for what was removed from the
 * end and the new characters (a phone keyboard with suggestions may rewrite a whole word at once).
 */
export function textDiff(before: string, after: string): string {
  const a = [...before];
  const b = [...after];
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  return '\b'.repeat(a.length - same) + b.slice(same).join('');
}

/**
 * Virtual keyboard on touch screens. A phone only shows its keyboard for a text field focused at
 * the end of a touch (touchend / pointerup, not pointerdown), so: a touch on the canvas while the
 * game reads typed text (`input.wantsText`) focuses a hidden <input>, and what is typed there
 * reaches the game as the same typed text a physical keyboard produces. `sync()` (each frame) closes the keyboard once the
 * game stops reading text. Mouse and physical keyboard keep working as before (attachDomInput).
 */
export function attachTextField(getInput: () => Input, canvas: EventTarget, field: TextFieldElement) {
  let open = false;
  let last = '';
  const reset = () => {
    field.value = '';
    last = '';
  };

  const onTouchEnd = (ev: Event) => {
    const type = (ev as PointerLike).pointerType;
    if (type !== undefined && type !== 'touch' && type !== 'pen') return; // mouse: physical keyboard
    if (!getInput().wantsText) return close();
    // The touch's own default (the emulated click) would move the focus back to the canvas.
    if (ev.cancelable) ev.preventDefault();
    if (open) return;
    reset();
    field.focus();
    open = true;
  };
  const onInput = (ev: Event) => {
    if ((ev as InputLike).isComposing) return; // wait for the composed word
    const text = textDiff(last, field.value);
    last = field.value;
    if (text) getInput().typeText(text);
  };
  const onCompositionEnd = () => onInput(new Event('input'));
  const onKeyDown = (ev: Event) => {
    const key = (ev as KeyLike).key;
    if (key === 'Enter') {
      getInput().typeText('\n');
      reset();
      ev.preventDefault();
    } else if (key === 'Backspace' && field.value === '') getInput().typeText('\b');
  };
  const close = () => {
    if (!open) return;
    open = false;
    field.blur();
    reset();
  };
  const onBlur = () => {
    open = false;
  };

  const listeners: [EventTarget, string, (e: Event) => void][] = [
    [canvas, 'pointerup', onTouchEnd],
    [canvas, 'touchend', onTouchEnd],
    [field, 'input', onInput],
    [field, 'compositionend', onCompositionEnd],
    [field, 'keydown', onKeyDown],
    [field, 'blur', onBlur],
  ];
  for (const [t, type, fn] of listeners) t.addEventListener(type, fn);
  return {
    get open() {
      return open;
    },
    /** Call once per frame: hides the keyboard when the game no longer reads text. */
    sync() {
      if (open && !getInput().wantsText) close();
    },
    detach() {
      for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
    },
  };
}
