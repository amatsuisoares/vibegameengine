import type { Asset } from '@vibe/shared';
import type { AssetResolver, SpriteSource } from './render';

export interface ImageLike {
  width: number;
  height: number;
}

export type ImageLoader<I extends ImageLike> = (url: string) => Promise<I>;

export interface AssetLoadReport {
  loaded: string[];
  errors: { id: string; message: string }[];
  /** Audio is declared but not loaded yet (stage 8). */
  skipped: string[];
}

/** Source rectangle of a frame in a spritesheet laid out left-to-right, top-to-bottom. */
export function spritesheetFrameRect(imageW: number, imageH: number, frameW: number, frameH: number, frame: number) {
  const cols = Math.floor(imageW / frameW);
  const rows = Math.floor(imageH / frameH);
  const count = cols * rows;
  if (count === 0 || frame < 0 || frame >= count) return { count, rect: null };
  return {
    count,
    rect: { sx: (frame % cols) * frameW, sy: Math.floor(frame / cols) * frameH, sw: frameW, sh: frameH },
  };
}

/**
 * Loads the images declared in `config.assets` and resolves sprite frames.
 * The loader is injected: the browser passes an HTMLImageElement loader, tests pass fakes.
 */
export class AssetStore<I extends ImageLike & CanvasImageSource = HTMLImageElement> implements AssetResolver {
  private readonly defs = new Map<string, Asset>();
  private readonly images = new Map<string, I>();
  private readonly failures = new Map<string, string>();

  constructor(
    assets: readonly Asset[],
    private readonly baseUrl: string,
    private readonly loader: ImageLoader<I>,
  ) {
    for (const a of assets) this.defs.set(a.id, a);
  }

  urlOf(asset: Asset) {
    return this.baseUrl + asset.path.split('/').map(encodeURIComponent).join('/');
  }

  async loadAll(): Promise<AssetLoadReport> {
    const report: AssetLoadReport = { loaded: [], errors: [], skipped: [] };
    await Promise.all(
      [...this.defs.values()].map(async (a) => {
        if (a.type === 'audio') {
          report.skipped.push(a.id);
          return;
        }
        try {
          this.images.set(a.id, await this.loader(this.urlOf(a)));
          report.loaded.push(a.id);
        } catch (err) {
          const message = `failed to load "${a.path}": ${err instanceof Error ? err.message : String(err)}`;
          this.failures.set(a.id, message);
          report.errors.push({ id: a.id, message });
        }
      }),
    );
    return report;
  }

  resolve(assetId: string, frame: number): SpriteSource | string {
    const def = this.defs.get(assetId);
    if (!def) return `asset "${assetId}" is not declared in project.json`;
    if (def.type === 'audio') return `asset "${assetId}" is audio, not an image`;
    const image = this.images.get(assetId);
    if (!image) return `asset "${assetId}" ${this.failures.get(assetId) ?? 'is not loaded'}`;
    if (def.type === 'image') return { image, sx: 0, sy: 0, sw: image.width, sh: image.height };
    const { count, rect } = spritesheetFrameRect(image.width, image.height, def.frameWidth!, def.frameHeight!, frame);
    if (!rect) return `frame ${frame} is out of range for spritesheet "${assetId}" (${count} frames)`;
    return { image, ...rect };
  }
}

/** Browser image loader. */
export function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`HTTP request for ${url} failed`));
    img.src = url;
  });
}
