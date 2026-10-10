#!/usr/bin/env node
// Real shared drawSkySync; local Skia output is not browser/phone certification.
import { createRequire } from 'node:module';
import { mkdirSync,writeFileSync } from 'node:fs';
import { scenes } from './production-scenes.mjs';
import { prepareCloudSprites } from '../../training/src/sky/painted.ts';
import { drawSkySync } from '../../training/src/sky/render.ts';
const require=createRequire(import.meta.url);
const {createCanvas,loadImage}=require(process.env.CANVAS_MODULE||'@napi-rs/canvas');
const atlas=await loadImage('web/public/sky/painted-clouds.webp');
Object.defineProperty(atlas,'src',{set(){}}); atlas.decode=async()=>{};
globalThis.Image=function(){return atlas;};
globalThis.OffscreenCanvas=function(w,h){return createCanvas(w,h);};
await prepareCloudSprites();
const out='build/clouds-phase2';mkdirSync(out,{recursive:true});
const results=[], playback=[];
for(const dark of [false,true]) for(const [w,h] of [[390,236],[600,320]]) {
  const sheet=createCanvas(w*2,(h+28)*2),sctx=sheet.getContext('2d');
  sctx.fillStyle=dark?'#101922':'#edf1f3';sctx.fillRect(0,0,sheet.width,sheet.height);
  for(const [i,scene] of scenes.entries()) {
    const options={width:w,height:h,dpr:2,dark,seed:scene.id,coastKm:null};
    const canvas=createCanvas(w*2,h*2),ctx=canvas.getContext('2d');ctx.scale(2,2);
    const scratch={clouds:createCanvas(w*2,h*2),layer:createCanvas(w*2,h*2)};
    const samples=[];
    for(let k=0;k<90;k++) {const t=performance.now();drawSkySync(ctx,scene,options,scratch);ctx.getImageData(0,0,1,1);if(k>=10)samples.push(performance.now()-t);}
    samples.sort((a,b)=>a-b);results.push({id:scene.id,width:w,height:h,dpr:2,dark,p50Ms:samples[40],p95Ms:samples[76],maxMs:samples.at(-1)});
    const visible=createCanvas(w*2,h*2),vctx=visible.getContext('2d'),warm=[];
    for(let k=0;k<100;k++){const t=performance.now();vctx.globalAlpha=1;vctx.drawImage(canvas,0,0);vctx.globalAlpha=0.5;vctx.drawImage(canvas,0,0);vctx.getImageData(0,0,1,1);if(k>=10)warm.push(performance.now()-t);}
    warm.sort((a,b)=>a-b);playback.push({id:scene.id,width:w,height:h,dpr:2,dark,p95Ms:warm[Math.floor(warm.length*.95)],maxMs:warm.at(-1)});
    writeFileSync(`${out}/${scene.id}-${dark?'dark':'light'}-${w}.png`,canvas.toBuffer('image/png'));
    const x=(i%2)*w,y=Math.floor(i/2)*(h+28);sctx.fillStyle=dark?'#dde7ef':'#182e40';sctx.font='12px sans-serif';sctx.fillText(scene.title,x+6,y+19);sctx.drawImage(canvas,x,y+28,w,h);
  }
  writeFileSync(`${out}/production-${dark?'dark':'light'}-${w}.png`,sheet.toBuffer('image/png'));
}
writeFileSync(`${out}/offline-timing.json`,JSON.stringify({scope:'Desktop local Skia, full shared drawSkySync plus 1px readback, not phone/browser or compositing latency',results,cachedCrossfade:playback},null,2));
console.log(JSON.stringify(results,null,2));
