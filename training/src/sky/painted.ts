/** One atlas, decoded once per page. Tint once at preparation, never per draw. */
import { SPRITE_RECTS } from './atlas.ts';
import type { CloudType } from './physics.ts';
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type ImageCanvas = HTMLCanvasElement | OffscreenCanvas;
let url = './painted-clouds.webp';
let ready: Promise<void> | null = null;
let palettes: CanvasImageSource[] | null = null;
export function configureCloudAtlas(next: string) {
  if (next === url) return;
  url = next; ready = null; palettes = null;
}
export function cloudSpritesReady(): boolean { return palettes != null; }
export function prepareCloudSprites(): Promise<void> {
  if (ready) return ready;
  const source = url;
  ready = (async () => {
    const image = new Image(); image.src = source;
    await image.decode();
    if (source !== url) return;
    palettes = [image, ...[0.28, 0.68].map(shade => {
      const canvas: ImageCanvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(image.width, image.height) : document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d') as Ctx;
      ctx.drawImage(image, 0, 0);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(0,0,0,${shade})`; ctx.fillRect(0, 0, image.width, image.height);
      ctx.globalCompositeOperation = 'source-over';
      return canvas;
    })];
  })().catch(error => { ready = null; throw error; });
  return ready;
}
export function paintCloudSprite(ctx: Ctx, type: CloudType, x: number, y: number, w: number, h: number, dark: boolean, night = 0, flip = false): boolean {
  const genus = type === 'towering' || type === 'altocumulus' ? 'cumulus'
    : type === 'stratocumulus' || type === 'altostratus' ? 'stratus' : type;
  if (!palettes || !(genus in SPRITE_RECTS) || !(w > 0 && h > 0)) return false;
  const [sx, sy, sw, sh] = SPRITE_RECTS[genus as keyof typeof SPRITE_RECTS];
  ctx.save();
  if (flip) { ctx.translate(x + w, y); ctx.scale(-1, 1); x = 0; y = 0; }
  ctx.drawImage(palettes[dark ? 1 : 0], sx, sy, sw, sh, x, y, w, h);
  if (night > 0) {
    ctx.globalAlpha *= Math.max(0, Math.min(1, night));
    ctx.globalCompositeOperation = 'source-atop';
    ctx.drawImage(palettes[2], sx, sy, sw, sh, x, y, w, h);
  }
  ctx.restore();
  return true;
}
