export type MouseButton = 'left' | 'right' | 'middle';

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  SPACE: 'Space',
  SPACEBAR: 'Space',
  LEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight',
  UP: 'ArrowUp',
  DOWN: 'ArrowDown',
  ARROWLEFT: 'ArrowLeft',
  ARROWRIGHT: 'ArrowRight',
  ARROWUP: 'ArrowUp',
  ARROWDOWN: 'ArrowDown',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  ENTER: 'Enter',
  RETURN: 'Enter',
  SHIFT: 'Shift',
  SHIFTLEFT: 'Shift',
  SHIFTRIGHT: 'Shift',
  CTRL: 'Control',
  CONTROL: 'Control',
  CONTROLLEFT: 'Control',
  CONTROLRIGHT: 'Control',
  ALT: 'Alt',
  TAB: 'Tab',
  BACKSPACE: 'Backspace',
};

/**
 * Normalizes key names from agents ("SPACE", "d"), browsers' KeyboardEvent.code
 * ("KeyD", "Digit1") and KeyboardEvent.key (" ") into one canonical form.
 */
export function normalizeKey(key: string): string {
  const k = key.length === 1 ? key : key.trim();
  if (/^Key[A-Za-z]$/.test(k)) return k.slice(3).toUpperCase();
  if (/^Digit[0-9]$/.test(k)) return k.slice(5);
  if (/^Numpad[0-9]$/.test(k)) return k.slice(6);
  const alias = KEY_ALIASES[k.toUpperCase()];
  if (alias) return alias;
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/**
 * Virtual input device. Real keyboard/mouse events (browser) and agent tools
 * feed the same API, so the game cannot tell them apart.
 *
 * Presses are latched until the next frame: a key pressed and released between
 * two frames still counts as down for one frame.
 */
export class Input {
  private down = new Set<string>();
  private pendingPressed = new Set<string>();
  private pendingReleased = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();

  private pendingText = '';
  private text = '';
  /** Where the left button went down (the mouse may have moved again before the frame runs). */
  private pendingPressAt: { x: number; y: number } | null = null;
  private pressAt: { x: number; y: number } | null = null;

  private mouseDownSet = new Set<MouseButton>();
  private pendingMousePressed = new Set<MouseButton>();
  private mousePressedSet = new Set<MouseButton>();
  /** Mouse position in viewport (screen) pixels. */
  mouse = { x: 0, y: 0 };

  constructor(public actions: Record<string, string[]> = {}) {}

  keyDown(key: string) {
    const k = normalizeKey(key);
    if (!this.down.has(k)) this.pendingPressed.add(k);
    this.down.add(k);
  }

  keyUp(key: string) {
    const k = normalizeKey(key);
    if (this.down.delete(k)) this.pendingReleased.add(k);
  }

  /**
   * Characters typed (as produced by the keyboard layout, e.g. "Mimi"), with "\b" for Backspace
   * and "\n" for Enter so their order is kept. Available for one frame.
   */
  typeText(text: string) {
    this.pendingText += text;
  }

  mouseMove(x: number, y: number) {
    this.mouse = { x, y };
  }

  mouseDown(button: MouseButton = 'left') {
    if (!this.mouseDownSet.has(button)) this.pendingMousePressed.add(button);
    if (button === 'left') this.pendingPressAt ??= { ...this.mouse };
    this.mouseDownSet.add(button);
  }

  mouseUp(button: MouseButton = 'left') {
    this.mouseDownSet.delete(button);
  }

  releaseAll() {
    for (const k of [...this.down]) this.keyUp(k);
    this.mouseDownSet.clear();
    this.pendingText = '';
  }

  /** Called by the game at the start of every fixed step. */
  beginFrame() {
    this.pressed = this.pendingPressed;
    this.released = this.pendingReleased;
    this.pendingPressed = new Set();
    this.pendingReleased = new Set();
    this.mousePressedSet = this.pendingMousePressed;
    this.pendingMousePressed = new Set();
    this.text = this.pendingText;
    this.pendingText = '';
    this.pressAt = this.pendingPressAt;
    this.pendingPressAt = null;
  }

  /** Viewport position where the left button was pressed this frame (null if it was not). */
  leftPressPosition(): { x: number; y: number } | null {
    return this.pressAt && { ...this.pressAt };
  }

  /** Text typed since the previous frame. */
  typed(): string {
    return this.text;
  }

  isDown(key: string) {
    const k = normalizeKey(key);
    return this.down.has(k) || this.pressed.has(k);
  }
  wasPressed(key: string) {
    return this.pressed.has(normalizeKey(key));
  }
  wasReleased(key: string) {
    return this.released.has(normalizeKey(key));
  }

  isMouseDown(button: MouseButton = 'left') {
    return this.mouseDownSet.has(button) || this.mousePressedSet.has(button);
  }
  wasMousePressed(button: MouseButton = 'left') {
    return this.mousePressedSet.has(button);
  }

  private keysOf(action: string): string[] {
    return this.actions[action] ?? [action];
  }

  action(name: string) {
    return this.keysOf(name).some((k) => this.isDown(k));
  }
  actionPressed(name: string) {
    return this.keysOf(name).some((k) => this.wasPressed(k));
  }
  /** True when a key of the action was released and no other key of it is still held. */
  actionReleased(name: string) {
    const keys = this.keysOf(name);
    return keys.some((k) => this.wasReleased(k)) && !keys.some((k) => this.down.has(normalizeKey(k)));
  }

  snapshot() {
    return {
      keys: [...this.down].sort(),
      mouse: { ...this.mouse, buttons: [...this.mouseDownSet] },
    };
  }
}
