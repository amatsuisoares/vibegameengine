import { formatText, hitBox, type Entity, type GameStatus, type World } from '@vibe/engine';

/**
 * Rendering is split in two phases so it can be tested without a browser:
 *   buildDrawList(world)  -> plain draw commands in screen space (pure, deterministic)
 *   paint(ctx, commands)  -> Canvas2D calls
 * Neither phase mutates the world.
 */

export interface SpriteCmd {
  kind: 'sprite';
  id: string;
  layer: number;
  /** Center in viewport pixels. */
  x: number;
  y: number;
  /** Size in viewport pixels (sprite size x |scale| x zoom). */
  w: number;
  h: number;
  /** Radians. */
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  opacity: number;
  shape: 'rect' | 'circle' | 'triangle';
  color: string;
  asset?: string;
  frame: number;
}

export interface TextCmd {
  kind: 'text';
  id: string;
  layer: number;
  /** Anchor in viewport pixels: top of the first line for screen-space text, block center for world text. */
  x: number;
  y: number;
  lines: string[];
  font: string;
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  baseline: 'top' | 'middle';
  opacity?: number;
}

export type DrawCmd = SpriteCmd | TextCmd;

export interface SpriteSource {
  image: CanvasImageSource;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Resolves an asset frame to an image region, or returns a human-readable error. */
export interface AssetResolver {
  resolve(assetId: string, frame: number): SpriteSource | string;
}

const DEG = Math.PI / 180;
export const LINE_HEIGHT = 1.2;

export function buildDrawList(world: World): DrawCmd[] {
  const { camera: cam, config } = world;
  const vw = config.width;
  const vh = config.height;
  const out: DrawCmd[] = [];

  for (const e of world.entities) {
    if (!e.active) continue;
    const sprite = spriteCmd(e, world);
    if (sprite) {
      const r = Math.hypot(sprite.w, sprite.h) / 2;
      const visible = sprite.x + r >= 0 && sprite.x - r <= vw && sprite.y + r >= 0 && sprite.y - r <= vh;
      if (visible) out.push(sprite);
    }
    const t = e.components.Text;
    if (t && t.text && t.opacity > 0) {
      const screen = t.screenSpace;
      const zoom = screen ? 1 : cam.zoom;
      out.push({
        kind: 'text',
        id: e.id,
        layer: t.layer,
        x: screen ? e.x : (e.x - cam.x) * cam.zoom,
        y: screen ? e.y : (e.y - cam.y) * cam.zoom,
        lines: formatText(t.text, world).split('\n'),
        font: t.font,
        fontSize: t.fontSize * zoom,
        color: t.color,
        align: t.align,
        baseline: screen ? 'top' : 'middle',
        ...(t.opacity < 1 && { opacity: t.opacity }),
      });
    }
  }
  out.push(...promptCmds(world));
  // Array.prototype.sort is stable: equal layers keep scene order.
  return out.sort((a, b) => a.layer - b.layer);
}

export const PROMPT_LAYER = 1000;
const PROMPT_FONT = 14;

/** "[E] Open" above the interactable the interaction key would use now (only when it has a label). */
function promptCmds(world: World): DrawCmd[] {
  const focus = world.interactFocus;
  const target = focus && world.get(focus.entity);
  const c = target?.components.Interactable;
  if (!target || !c?.label) return [];
  const cam = world.camera;
  const box = hitBox(target);
  const key = world.config.actions[c.key]?.[0] ?? c.key;
  const text = `[${key}] ${c.label}`;
  const x = ((box ? box.x + box.w / 2 : target.x) - cam.x) * cam.zoom;
  const y = ((box ? box.y : target.y) - cam.y) * cam.zoom - PROMPT_FONT;
  const id = `${target.id}:prompt`;
  const backdrop: SpriteCmd = {
    kind: 'sprite',
    id,
    layer: PROMPT_LAYER,
    x,
    y,
    w: text.length * PROMPT_FONT * 0.6 + 10,
    h: PROMPT_FONT + 8,
    rotation: 0,
    flipX: false,
    flipY: false,
    opacity: 0.75,
    shape: 'rect',
    color: '#000000',
    frame: 0,
  };
  const label: TextCmd = {
    kind: 'text',
    id,
    layer: PROMPT_LAYER,
    x,
    y,
    lines: [text],
    font: 'monospace',
    fontSize: PROMPT_FONT,
    color: '#ffffff',
    align: 'center',
    baseline: 'middle',
  };
  return [backdrop, label];
}

function spriteCmd(e: Entity, world: World): SpriteCmd | null {
  const s = e.components.Sprite;
  if (!s || !s.visible || s.opacity <= 0) return null;
  const cam = world.camera;
  return {
    kind: 'sprite',
    id: e.id,
    layer: s.layer,
    x: (e.x - cam.x) * cam.zoom,
    y: (e.y - cam.y) * cam.zoom,
    w: s.width * Math.abs(e.scaleX) * cam.zoom,
    h: s.height * Math.abs(e.scaleY) * cam.zoom,
    rotation: e.rotation * DEG,
    flipX: s.flipX !== e.scaleX < 0,
    flipY: e.scaleY < 0,
    opacity: s.opacity,
    shape: s.shape,
    color: s.color,
    asset: s.asset,
    frame: s.frame,
  };
}

export interface PaintOptions {
  width: number;
  height: number;
  background: string;
  pixelArt: boolean;
  assets?: AssetResolver;
  /** Called when a sprite cannot be drawn from its asset (a placeholder is drawn instead). */
  onAssetError?: (message: string) => void;
}

export const MISSING_ASSET_COLOR = '#ff00ff';

export function paint(ctx: CanvasRenderingContext2D, cmds: DrawCmd[], o: PaintOptions) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = !o.pixelArt;
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, o.width, o.height);
  for (const cmd of cmds) {
    if (cmd.kind === 'sprite') paintSprite(ctx, cmd, o);
    else paintText(ctx, cmd);
  }
  ctx.restore();
}

function paintSprite(ctx: CanvasRenderingContext2D, c: SpriteCmd, o: PaintOptions) {
  ctx.save();
  ctx.globalAlpha = c.opacity;
  // Snap the top-left corner to whole pixels in pixel-art mode to avoid shimmering edges.
  const cx = o.pixelArt ? Math.round(c.x - c.w / 2) + c.w / 2 : c.x;
  const cy = o.pixelArt ? Math.round(c.y - c.h / 2) + c.h / 2 : c.y;
  ctx.translate(cx, cy);
  if (c.rotation) ctx.rotate(c.rotation);
  if (c.flipX || c.flipY) ctx.scale(c.flipX ? -1 : 1, c.flipY ? -1 : 1);

  if (c.asset) {
    const src = o.assets ? o.assets.resolve(c.asset, c.frame) : `asset "${c.asset}" is not loaded`;
    if (typeof src === 'string') {
      o.onAssetError?.(`Sprite of "${c.id}": ${src}`);
      ctx.fillStyle = MISSING_ASSET_COLOR;
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    } else {
      ctx.drawImage(src.image, src.sx, src.sy, src.sw, src.sh, -c.w / 2, -c.h / 2, c.w, c.h);
    }
  } else {
    ctx.fillStyle = c.color;
    if (c.shape === 'rect') {
      ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
    } else {
      ctx.beginPath();
      if (c.shape === 'circle') {
        ctx.ellipse(0, 0, c.w / 2, c.h / 2, 0, 0, Math.PI * 2);
      } else {
        ctx.moveTo(0, -c.h / 2);
        ctx.lineTo(c.w / 2, c.h / 2);
        ctx.lineTo(-c.w / 2, c.h / 2);
        ctx.closePath();
      }
      ctx.fill();
    }
  }
  ctx.restore();
}

function paintText(ctx: CanvasRenderingContext2D, c: TextCmd) {
  const lh = c.fontSize * LINE_HEIGHT;
  const y0 = c.baseline === 'middle' ? c.y - ((c.lines.length - 1) * lh) / 2 : c.y;
  ctx.save();
  ctx.globalAlpha = c.opacity ?? 1;
  ctx.font = `${c.fontSize}px ${c.font}`;
  ctx.fillStyle = c.color;
  ctx.textAlign = c.align;
  ctx.textBaseline = c.baseline;
  c.lines.forEach((line, i) => ctx.fillText(line, c.x, y0 + i * lh));
  ctx.restore();
}

/** Full-screen banner shown when the game is over, so screenshots show the outcome too. */
export function paintStatusOverlay(
  ctx: CanvasRenderingContext2D,
  status: GameStatus,
  width: number,
  height: number,
  detail?: string,
) {
  if (status === 'running') return;
  const banner = {
    won: { title: 'YOU WIN!', color: '#33dd66', hint: 'Press R to restart' },
    lost: { title: 'GAME OVER', color: '#ff5555', hint: 'Press R to restart' },
    crashed: { title: 'RUNTIME ERROR', color: '#ff9933', hint: 'See the console for details' },
  }[status];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = banner.color;
  ctx.font = 'bold 40px monospace';
  ctx.fillText(banner.title, width / 2, height / 2 - 24);
  ctx.fillStyle = '#ffffff';
  ctx.font = '16px monospace';
  if (detail) ctx.fillText(detail.length > 80 ? `${detail.slice(0, 77)}...` : detail, width / 2, height / 2 + 14);
  ctx.fillText(banner.hint, width / 2, height / 2 + (detail ? 40 : 18));
  ctx.restore();
}

export const DEBUG_COLORS = {
  solid: '#44ff44',
  oneWay: '#ffdd44',
  trigger: '#44aaff',
  dynamic: '#ff44ff',
} as const;

/** NavAgent paths in debug view. */
export const NAV_PATH_COLOR = '#ff8800';

export function colliderKind(e: Entity): keyof typeof DEBUG_COLORS | null {
  const c = e.components.Collider;
  if (!c) return null;
  if (c.isTrigger) return 'trigger';
  if (e.components.Body?.type === 'dynamic') return 'dynamic';
  return c.oneWay ? 'oneWay' : 'solid';
}

/** Collider boxes, entity ids and a status line. */
export function paintDebug(ctx: CanvasRenderingContext2D, world: World, info: { fps?: number; paused?: boolean } = {}) {
  const cam = world.camera;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  for (const e of world.entities) {
    const box = e.aabb();
    const kind = colliderKind(e);
    // HUD-only entities live in screen space; a world-space marker would be misleading.
    if (!e.active || (!kind && e.components.Text?.screenSpace && !e.components.Sprite)) continue;
    const sx = (e.x - cam.x) * cam.zoom;
    const sy = (e.y - cam.y) * cam.zoom;
    ctx.fillStyle = ctx.strokeStyle = kind ? DEBUG_COLORS[kind] : '#ffffff';
    if (box && kind) {
      const x = (box.x - cam.x) * cam.zoom;
      const y = (box.y - cam.y) * cam.zoom;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, box.w * cam.zoom - 1, box.h * cam.zoom - 1);
      ctx.fillText(e.id, x, y - 2);
    } else {
      ctx.fillText(e.id, sx + 3, sy - 3);
    }
    ctx.fillRect(sx - 1, sy - 1, 2, 2);
    const path = e.nav?.status === 'moving' ? e.nav.path : [];
    if (path.length) {
      ctx.save();
      ctx.strokeStyle = NAV_PATH_COLOR;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      for (const p of path) ctx.lineTo((p.x - cam.x) * cam.zoom, (p.y - cam.y) * cam.zoom);
      ctx.stroke();
      ctx.restore();
    }
  }
  const parts = [`frame ${world.frame}`, world.status, `scene ${world.scene.id}`];
  if (info.fps !== undefined) parts.push(`${Math.round(info.fps)} fps`);
  if (info.paused) parts.push('PAUSED');
  const line = parts.join(' | ');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.font = '12px monospace';
  const w = ctx.measureText(line).width;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(world.config.width - w - 12, 4, w + 8, 18);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(line, world.config.width - 8, 7);
  ctx.restore();
}
