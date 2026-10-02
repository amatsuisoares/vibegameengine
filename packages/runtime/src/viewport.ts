import { round2, stackAt, type CameraState, type Game, type World } from '@vibe/engine';
import { SELECTION_COLOR, selectionBox, type DrawCmd } from './render';

/**
 * Editor viewport (V0.5): an editor-only view of the running scene — its own camera (pan / zoom),
 * picking, dragging an entity to move it, and a few gizmos. Everything here reads the World and
 * draws over the game; nothing changes the simulation (a move is saved to the scene file through
 * the ProjectStore, and the game reloads from it).
 */

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
export const BOUNDS_COLOR = '#ffffff';
export const GAME_CAMERA_COLOR = '#ffb000';

/** An entity being dragged: its draw commands and outline are shown moved by (dx, dy) world px. */
export interface DragPreview {
  id: string;
  dx: number;
  dy: number;
}

export interface EditorView {
  view: CameraState;
  drag?: DragPreview | null;
}

export function viewToWorld(view: CameraState, sx: number, sy: number) {
  return { x: view.x + sx / view.zoom, y: view.y + sy / view.zoom };
}

export function worldToView(view: CameraState, wx: number, wy: number) {
  return { x: (wx - view.x) * view.zoom, y: (wy - view.y) * view.zoom };
}

/** Zooms by `factor`, keeping the world point under (sx, sy) in place. */
export function zoomViewAt(view: CameraState, sx: number, sy: number, factor: number): CameraState {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, round2(view.zoom * factor)));
  const p = viewToWorld(view, sx, sy);
  return { x: p.x - sx / zoom, y: p.y - sy / zoom, zoom };
}

/** Moves the view by a drag of (dsx, dsy) screen px (the world follows the pointer). */
export function panView(view: CameraState, dsx: number, dsy: number): CameraState {
  return { x: view.x - dsx / view.zoom, y: view.y - dsy / view.zoom, zoom: view.zoom };
}

/** Centers the view on an entity (its box, or its position), keeping the zoom. */
export function frameEntity(world: World, id: string, view: CameraState): CameraState | null {
  const e = world.get(id);
  if (!e || e.destroyed) return null;
  const box = selectionBox(world, id, { x: 0, y: 0, zoom: 1 });
  const cx = box && (box.w || box.h) ? box.x + box.w / 2 : e.x;
  const cy = box && (box.w || box.h) ? box.y + box.h / 2 : e.y;
  return { x: cx - world.config.width / 2 / view.zoom, y: cy - world.config.height / 2 / view.zoom, zoom: view.zoom };
}

/**
 * The entity under a viewport point: the selected one when the point is on its outline box (so a
 * disabled entity, which is not drawn, can still be grabbed), else the topmost drawn entity there.
 */
export function pickAt(game: Game, view: CameraState, sx: number, sy: number, selected?: string | null): string | null {
  if (selected) {
    const b = selectionBox(game.world, selected, view);
    const pad = 4;
    if (b && (b.w || b.h) && sx >= b.x - pad && sx <= b.x + b.w + pad && sy >= b.y - pad && sy <= b.y + b.h + pad) return selected;
  }
  const p = viewToWorld(view, sx, sy);
  return stackAt(game, p.x, p.y)[0]?.id ?? null;
}

/** World-space move between two viewport points, in whole pixels. */
export function dragDelta(view: CameraState, from: { x: number; y: number }, to: { x: number; y: number }) {
  return { dx: Math.round((to.x - from.x) / view.zoom), dy: Math.round((to.y - from.y) / view.zoom) };
}

/** The draw commands with those of the dragged entity moved (a preview: the World is untouched). */
export function offsetDrawList(cmds: DrawCmd[], drag: DragPreview, zoom: number): DrawCmd[] {
  if (!drag.dx && !drag.dy) return cmds;
  return cmds.map((c) => (c.id === drag.id ? { ...c, x: c.x + drag.dx * zoom, y: c.y + drag.dy * zoom } : c));
}

/** The view that shows the dragged entity's outline where it would be dropped. */
export function dragView(view: CameraState, drag: DragPreview | null | undefined): CameraState {
  return drag ? { x: view.x - drag.dx, y: view.y - drag.dy, zoom: view.zoom } : view;
}

/**
 * Gizmos of the editor view: the scene bounds, the frame the game camera shows, the selected
 * entity's position (pivot cross with coordinates) and the zoom.
 */
export function paintViewportGizmos(ctx: CanvasRenderingContext2D, world: World, editor: EditorView, selected: string | null) {
  const { view, drag } = editor;
  const { width: vw, height: vh } = world.config;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.font = '11px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';

  // Labels inside the boxes (they often start at the same corner): bounds at the bottom, camera at the top.
  const rect = (x: number, y: number, w: number, h: number, color: string, label: string, dash: number[], top: boolean) => {
    const a = worldToView(view, x, y);
    ctx.strokeStyle = ctx.fillStyle = color;
    ctx.setLineDash(dash);
    ctx.strokeRect(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5, w * view.zoom, h * view.zoom);
    ctx.setLineDash([]);
    ctx.textBaseline = top ? 'top' : 'bottom';
    ctx.fillText(label, Math.round(a.x) + 4, Math.round(top ? a.y + 4 : a.y + h * view.zoom - 4));
  };
  const scene = world.scene;
  rect(0, 0, scene.width, scene.height, BOUNDS_COLOR, `cena ${scene.id} ${scene.width}×${scene.height}`, [2, 3], false);
  const cam = world.camera;
  rect(cam.x, cam.y, vw / cam.zoom, vh / cam.zoom, GAME_CAMERA_COLOR, 'câmera do jogo', [6, 4], true);

  const e = selected ? world.get(selected) : undefined;
  if (e && !e.destroyed) {
    const d = drag?.id === e.id ? drag : null;
    const wx = e.x + (d?.dx ?? 0);
    const wy = e.y + (d?.dy ?? 0);
    const p = worldToView(view, wx, wy);
    ctx.strokeStyle = ctx.fillStyle = SELECTION_COLOR;
    ctx.beginPath();
    ctx.moveTo(p.x - 6, p.y);
    ctx.lineTo(p.x + 6, p.y);
    ctx.moveTo(p.x, p.y - 6);
    ctx.lineTo(p.x, p.y + 6);
    ctx.stroke();
    ctx.textBaseline = 'top';
    const label = d ? `(${round2(wx)}, ${round2(wy)})  Δ ${signed(d.dx)}, ${signed(d.dy)}` : `(${round2(wx)}, ${round2(wy)})`;
    ctx.fillText(label, p.x + 5, p.y + 4);
  }

  const zoom = `Editando · zoom ${Math.round(view.zoom * 100)}%`;
  const w = ctx.measureText(zoom).width;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(4, vh - 22, w + 8, 18);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'bottom';
  ctx.fillText(zoom, 8, vh - 7);
  ctx.restore();
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
