import type { Input, MouseButton } from '@vibe/engine';

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Converts a client (CSS pixel) position into viewport pixels of a canvas that may be scaled by CSS. */
export function clientToViewport(clientX: number, clientY: number, rect: RectLike, viewW: number, viewH: number) {
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    x: round(((clientX - rect.left) * viewW) / (rect.width || 1)),
    y: round(((clientY - rect.top) * viewH) / (rect.height || 1)),
  };
}

const BUTTONS: Record<number, MouseButton> = { 0: 'left', 1: 'middle', 2: 'right' };

/** Keys whose browser default (scrolling, focus moves) is suppressed while playing. */
const CAPTURED_CODES = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Tab']);

interface KeyEventLike extends Event {
  code: string;
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}
interface PointerEventLike extends Event {
  clientX: number;
  clientY: number;
  button: number;
}

export interface DomInputOptions {
  /** Receives keyboard events (usually `window`). */
  keyTarget: EventTarget;
  /** The game canvas: receives pointer events and defines the coordinate mapping. */
  canvas: EventTarget & { getBoundingClientRect(): RectLike };
  viewport: () => { width: number; height: number };
  /** Runtime shortcuts (e.g. R to restart after game over). Return true to consume the key. */
  onShellKey?: (code: string) => boolean;
}

function isEditable(target: EventTarget | null) {
  const tag = (target as { tagName?: string } | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Feeds real keyboard/mouse events into the engine's virtual Input — the same
 * device the agent's input tools drive. `getInput` is called per event because the runtime
 * replaces its Game (and Input) on hot reload. Returns a function that detaches everything.
 */
export function attachDomInput(getInput: () => Input, o: DomInputOptions): () => void {
  const keyOf = (e: KeyEventLike) => e.code || e.key;

  const onKeyDown = (ev: Event) => {
    const e = ev as KeyEventLike;
    if (isEditable(e.target)) return;
    if (o.onShellKey?.(e.code)) {
      e.preventDefault();
      return;
    }
    const input = getInput();
    input.keyDown(keyOf(e));
    // Printable characters also count as typed text (names, chat boxes...), in order with
    // Backspace ("\b") and Enter ("\n"), which may all arrive within one frame.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) input.typeText(e.key);
    else if (e.key === 'Backspace') input.typeText('\b');
    else if (e.key === 'Enter') input.typeText('\n');
    if (CAPTURED_CODES.has(e.code)) e.preventDefault();
  };
  const onKeyUp = (ev: Event) => {
    const e = ev as KeyEventLike;
    getInput().keyUp(keyOf(e));
  };
  // Keys held while the window loses focus would otherwise stay down forever.
  const onBlur = () => getInput().releaseAll();

  const toViewport = (e: PointerEventLike) => {
    const v = o.viewport();
    return clientToViewport(e.clientX, e.clientY, o.canvas.getBoundingClientRect(), v.width, v.height);
  };
  const onPointerMove = (ev: Event) => {
    const p = toViewport(ev as PointerEventLike);
    getInput().mouseMove(p.x, p.y);
  };
  const onPointerDown = (ev: Event) => {
    const e = ev as PointerEventLike;
    const p = toViewport(e);
    const input = getInput();
    input.mouseMove(p.x, p.y);
    const b = BUTTONS[e.button];
    if (b) input.mouseDown(b);
  };
  const onPointerUp = (ev: Event) => {
    const b = BUTTONS[(ev as PointerEventLike).button];
    if (b) getInput().mouseUp(b);
  };
  const onContextMenu = (ev: Event) => ev.preventDefault();

  const listeners: [EventTarget, string, (e: Event) => void][] = [
    [o.keyTarget, 'keydown', onKeyDown],
    [o.keyTarget, 'keyup', onKeyUp],
    [o.keyTarget, 'blur', onBlur],
    [o.canvas, 'pointermove', onPointerMove],
    [o.canvas, 'pointerdown', onPointerDown],
    [o.canvas, 'pointerup', onPointerUp],
    [o.canvas, 'contextmenu', onContextMenu],
  ];
  for (const [t, type, fn] of listeners) t.addEventListener(type, fn);
  return () => {
    for (const [t, type, fn] of listeners) t.removeEventListener(type, fn);
  };
}
