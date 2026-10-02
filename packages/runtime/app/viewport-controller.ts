import {
  clientToViewport,
  dragDelta,
  frameEntity,
  panView,
  pickAt,
  zoomViewAt,
  type DragPreview,
  type Runtime,
} from '@vibe/runtime';

export interface ViewportHost {
  runtime: Runtime;
  canvas: HTMLCanvasElement;
  /** Selects an entity of the current scene (null = nothing), like a click in the hierarchy. */
  select(entity: string | null): void;
  /** Why the entity cannot be moved (e.g. spawned at runtime), or null when it can. */
  cannotMove(id: string): string | null;
  /** Saves a move of the entity by (dx, dy) world px. Resolves to an error message, or null. */
  move(id: string, dx: number, dy: number): Promise<string | null>;
  log(level: 'log' | 'warn' | 'error', message: string): void;
}

/** Pointer travel (screen px) below which a press counts as a click, not a drag. */
const DRAG_THRESHOLD = 3;
/** Arrow-key nudges are saved together once the keys rest this long (one history entry). */
const NUDGE_SAVE_MS = 400;
/** A saved move stays previewed until the game reloads from the file (or this long). */
const PENDING_MS = 3000;

type Gesture =
  | { kind: 'move'; id: string; start: { x: number; y: number }; moved: boolean; movable: string | null }
  | { kind: 'pan'; last: { x: number; y: number }; start: { x: number; y: number }; moved: boolean; clearOnClick: boolean };

function isEditable(target: EventTarget | null) {
  const tag = (target as { tagName?: string } | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Viewport edit mode (the page's "Editar" button): the game is paused and does not get the mouse
 * or keyboard; the canvas shows the scene through an editor camera. Click selects, dragging an
 * entity moves it (saved to the scene file as a user edit), dragging empty space or with the
 * middle/right button pans, the wheel zooms, arrows nudge (Shift = 10 px), F frames the selection,
 * 0 goes back to the game camera, Esc clears the selection.
 */
export class ViewportController {
  private gesture: Gesture | null = null;
  private nudge: { id: string; dx: number; dy: number; timer?: ReturnType<typeof setTimeout> } | null = null;
  private pendingTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly host: ViewportHost) {
    const c = host.canvas;
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => void this.onPointerUp(e));
    c.addEventListener('pointercancel', () => this.cancelGesture());
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  get active() {
    return this.host.runtime.editor !== null;
  }

  enter() {
    const rt = this.host.runtime;
    rt.editor = { view: { ...rt.game.world.camera } };
    rt.render();
  }

  exit() {
    this.cancelGesture();
    this.flushNudge();
    this.host.runtime.editor = null;
    this.host.runtime.render();
  }

  /** The game was rebuilt from the files (hot reload): a saved move now shows for real. */
  onReload() {
    const ed = this.host.runtime.editor;
    if (ed && !this.gesture && !this.nudge) ed.drag = null;
  }

  private get view() {
    return this.host.runtime.editor!.view;
  }

  private set view(v) {
    this.host.runtime.editor!.view = v;
    this.host.runtime.render();
  }

  private point(e: PointerEvent | WheelEvent) {
    const { width, height } = this.host.runtime.project.config;
    return clientToViewport(e.clientX, e.clientY, this.host.canvas.getBoundingClientRect(), width, height);
  }

  private setDrag(drag: DragPreview | null) {
    this.host.runtime.editor!.drag = drag;
    this.host.runtime.render();
  }

  private onPointerDown(e: PointerEvent) {
    if (!this.active) return;
    e.preventDefault();
    this.host.canvas.focus();
    this.host.canvas.setPointerCapture?.(e.pointerId);
    const p = this.point(e);
    const rt = this.host.runtime;
    const id = e.button === 0 ? pickAt(rt.game, this.view, p.x, p.y, rt.selected) : null;
    if (id) {
      if (id !== rt.selected) this.host.select(id);
      this.flushNudge();
      this.gesture = { kind: 'move', id, start: p, moved: false, movable: this.host.cannotMove(id) };
    } else {
      this.gesture = { kind: 'pan', last: p, start: p, moved: false, clearOnClick: e.button === 0 };
    }
  }

  private onPointerMove(e: PointerEvent) {
    const g = this.gesture;
    if (!this.active || !g) return;
    const p = this.point(e);
    g.moved ||= Math.hypot(p.x - g.start.x, p.y - g.start.y) >= DRAG_THRESHOLD;
    if (!g.moved) return;
    if (g.kind === 'pan') {
      this.view = panView(this.view, p.x - g.last.x, p.y - g.last.y);
      g.last = p;
    } else if (!g.movable) {
      this.setDrag({ id: g.id, ...dragDelta(this.view, g.start, p) });
    }
  }

  private async onPointerUp(e: PointerEvent) {
    const g = this.gesture;
    this.gesture = null;
    if (!this.active || !g) return;
    if (g.kind === 'pan') {
      if (!g.moved && g.clearOnClick) this.host.select(null);
      return;
    }
    if (!g.moved) return;
    if (g.movable) {
      this.host.log('warn', g.movable);
      return;
    }
    const { dx, dy } = dragDelta(this.view, g.start, this.point(e));
    await this.save(g.id, dx, dy);
  }

  private cancelGesture() {
    if (this.gesture?.kind === 'move') this.setDrag(null);
    this.gesture = null;
  }

  private onWheel(e: WheelEvent) {
    if (!this.active) return;
    e.preventDefault();
    const p = this.point(e);
    this.view = zoomViewAt(this.view, p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  }

  private onKeyDown(e: KeyboardEvent) {
    if (!this.active || isEditable(e.target)) return;
    const rt = this.host.runtime;
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const arrow = arrows[e.code];
    if (arrow && rt.selected) {
      e.preventDefault();
      const id = rt.selected;
      const reason = this.host.cannotMove(id);
      if (reason) return this.host.log('warn', reason);
      if (this.nudge && this.nudge.id !== id) this.flushNudge();
      const n = (this.nudge ??= { id, dx: 0, dy: 0 });
      n.dx += arrow[0];
      n.dy += arrow[1];
      this.setDrag({ id, dx: n.dx, dy: n.dy });
      clearTimeout(n.timer);
      n.timer = setTimeout(() => this.flushNudge(), NUDGE_SAVE_MS);
    } else if (e.code === 'KeyF' && rt.selected) {
      const v = frameEntity(rt.game.world, rt.selected, this.view);
      if (v) this.view = v;
    } else if (e.code === 'Digit0' || e.code === 'Numpad0' || e.code === 'Home') {
      this.view = { ...rt.game.world.camera };
    } else if (e.code === 'Escape') {
      this.host.select(null);
    }
  }

  private flushNudge() {
    const n = this.nudge;
    if (!n) return;
    clearTimeout(n.timer);
    this.nudge = null;
    void this.save(n.id, n.dx, n.dy);
  }

  /** Saves the move; the preview stays until the game reloads with it (or goes back on failure). */
  private async save(id: string, dx: number, dy: number) {
    if (!dx && !dy) return this.setDrag(null);
    const error = await this.host.move(id, dx, dy);
    if (!this.active) return;
    if (error) {
      this.host.log('error', error);
      this.setDrag(null);
      return;
    }
    clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => this.onReload(), PENDING_MS);
  }
}
