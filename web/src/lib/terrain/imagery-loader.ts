import receipt from './everest-imagery.json';
import {imageryMapping,type ImageryMapping,type ImageryReceipt} from './imagery-material';
export const EVEREST_IMAGERY = receipt as ImageryReceipt;
export const EVEREST_IMAGERY_URL = `/history/imagery/${receipt.sha256}.png`;
export interface LoadedImagery {image:ImageBitmap;mapping:ImageryMapping}
const MAX_BYTES=12*1024*1024;
// One public, verified compressed image; no weather/user/session data.
let prepared:Blob|null=null;
let active:AbortController|null=null;
export function clearPreparedImagery(){prepared=null;active?.abort();}

/** Explicit opt-in, one bounded local static asset. Callers own bitmap.close().
 * One bounded compressed Blob reuses verified bytes offline; browser HTTP cache
 * also reuses the content-addressed asset across document navigations. */
export async function loadEverestImagery(signal:AbortSignal):Promise<LoadedImagery> {
  const mapping=imageryMapping(EVEREST_IMAGERY);
  // This material has one active map owner; a replacement cancels its predecessor.
  active?.abort();
  const controller=new AbortController(),abort=()=>controller.abort();
  active=controller;
  if(signal.aborted)controller.abort();else signal.addEventListener('abort',abort,{once:true});
  const timeout=setTimeout(abort,20_000);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
    if(!prepared){
    const response=await fetch(EVEREST_IMAGERY_URL,{signal:controller.signal,cache:'force-cache'});
    if(!response.ok||!response.body)throw new Error('Terrain imagery unavailable');
    if(Number(response.headers.get('content-length'))>MAX_BYTES)throw new Error('Terrain imagery exceeds byte budget');
    reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
    while(true){if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>MAX_BYTES)throw new Error('Terrain imagery exceeds byte budget');chunks.push(next.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    if(bytes.length<24||bytes.slice(0,8).some((n,i)=>n!==[137,80,78,71,13,10,26,10][i]))throw new Error('Terrain imagery is not PNG');
    const view=new DataView(bytes.buffer),{width,height}=EVEREST_IMAGERY.pixel_window;
    if(view.getUint32(16)!==width||view.getUint32(20)!==height)throw new Error('Terrain imagery dimensions differ from receipt');
    if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    if(digest!==EVEREST_IMAGERY.sha256)throw new Error('Terrain imagery differs from receipt');
    if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
    prepared=new Blob([bytes],{type:'image/png'});
    }
    if(controller.signal.aborted)throw new DOMException('Aborted','AbortError');
    const image=await createImageBitmap(prepared,{imageOrientation:'none',premultiplyAlpha:'none',colorSpaceConversion:'none'});
    if(controller.signal.aborted){image.close();throw new DOMException('Aborted','AbortError');}
    return {image,mapping};
  }finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);await reader?.cancel().catch(()=>{});controller.abort();if(active===controller)active=null;}
}
