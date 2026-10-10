import {afterEach,describe,expect,it,vi} from 'vitest';
import {EVEREST_IMAGERY,loadEverestImagery,clearPreparedImagery} from '../../src/lib/terrain/imagery-loader';
afterEach(()=>{vi.unstubAllGlobals();clearPreparedImagery();});
const png=()=>{const b=new Uint8Array(24);b.set([137,80,78,71,13,10,26,10]);const v=new DataView(b.buffer);v.setUint32(16,2048);v.setUint32(20,2048);return b;};
const bitmap=()=>({width:2048,height:2048,close:vi.fn()});
const digest=()=>Uint8Array.from(EVEREST_IMAGERY.sha256.match(/../g)!,v=>parseInt(v,16)).buffer;
describe('bounded opt-in imagery loading',()=>{
 it('rejects failed and oversized responses before image decoding',async()=>{
  const decode=vi.fn();vi.stubGlobal('createImageBitmap',decode);
  for(const response of [new Response('',{status:404}),new Response(png(),{headers:{'content-length':String(20*1024*1024)}})]){
   vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response));
   await expect(loadEverestImagery(new AbortController().signal)).rejects.toThrow();
  }
  expect(decode).not.toHaveBeenCalled();
 });
 it('rejects wrong dimensions and altered bytes',async()=>{
  vi.stubGlobal('createImageBitmap',vi.fn());
  const wrong=png();new DataView(wrong.buffer).setUint32(16,8192);
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(wrong)));
  await expect(loadEverestImagery(new AbortController().signal)).rejects.toThrow('dimensions');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(png())));
  vi.stubGlobal('crypto',{subtle:{digest:async()=>new Uint8Array(32).buffer}});
  await expect(loadEverestImagery(new AbortController().signal)).rejects.toThrow('receipt');
 });
 it('uses browser cache and transfers ownership of a verified bitmap',async()=>{
  const image=bitmap(),fetcher=vi.fn().mockResolvedValue(new Response(png()));
  vi.stubGlobal('fetch',fetcher);vi.stubGlobal('crypto',{subtle:{digest:async()=>digest()}});vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(image));
  const loaded=await loadEverestImagery(new AbortController().signal);
  expect(loaded.image).toBe(image);expect(image.close).not.toHaveBeenCalled();expect(fetcher.mock.calls[0][1].cache).toBe('force-cache');
  await loadEverestImagery(new AbortController().signal);expect(fetcher).toHaveBeenCalledOnce();
 });
 it('cancels an unfinished download when a replacement starts',async()=>{
  let firstSignal:AbortSignal|undefined;
  const fetcher=vi.fn().mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>{firstSignal=options.signal;options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')));})).mockResolvedValueOnce(new Response(png()));
  vi.stubGlobal('fetch',fetcher);vi.stubGlobal('crypto',{subtle:{digest:async()=>digest()}});vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(bitmap()));
  const first=loadEverestImagery(new AbortController().signal).catch(e=>e.name);
  await loadEverestImagery(new AbortController().signal);
  expect(firstSignal?.aborted).toBe(true);expect(await first).toBe('AbortError');
 });
 it('closes a late decoded bitmap after cancellation',async()=>{
  const controller=new AbortController(),image=bitmap();
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(png())));vi.stubGlobal('crypto',{subtle:{digest:async()=>digest()}});
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>{controller.abort();return image;}));
  await expect(loadEverestImagery(controller.signal)).rejects.toThrow('Aborted');expect(image.close).toHaveBeenCalledOnce();
 });
});
