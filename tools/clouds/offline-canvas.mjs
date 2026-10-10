import { createRequire } from 'node:module';
import { prepareCloudSprites } from '../../training/src/sky/painted.ts';
const require=createRequire(import.meta.url);
export const {createCanvas,loadImage}=require(process.env.CANVAS_MODULE||'@napi-rs/canvas');
export async function prepareOfflineAtlas() {
  const atlas=await loadImage(new URL('../../web/public/sky/painted-clouds.webp',import.meta.url).pathname);
  Object.defineProperty(atlas,'src',{set(){}}); atlas.decode=async()=>{};
  globalThis.Image=function(){return atlas;};
  globalThis.OffscreenCanvas=function(w,h){return createCanvas(w,h);};
  await prepareCloudSprites();
}
