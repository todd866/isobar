import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {createHash} from 'node:crypto';
import {createCanvas,prepareOfflineAtlas} from '../tools/clouds/offline-canvas.mjs';
import {scenes} from '../tools/clouds/production-scenes.mjs';
import {drawSkySync,yForFt,SkyAnimator} from '../training/src/sky/render.ts';
import {drawSounding,heightFraction,plotY} from '../web/src/lib/point/sounding.ts';
import {paintCloudSprite} from '../training/src/sky/painted.ts';
await prepareOfflineAtlas();
function render(state, dark=false) {
 const c=createCanvas(390,236),ctx=c.getContext('2d');
 drawSkySync(ctx,state,{width:390,height:236,dpr:1,dark,seed:'pixel',coastKm:null,compact:true},{clouds:createCanvas(390,236),layer:createCanvas(390,236)});
 return {c,p:ctx.getImageData(0,0,390,236).data};
}
function changed(a,b,y0,y1) {let count=0;for(let y=Math.max(0,Math.floor(y0));y<Math.min(236,Math.ceil(y1));y++)for(let x=40;x<350;x++){const i=(y*390+x)*4;if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>15)count++;}return count;}
test('packed production atlas size and digest match the report',()=>{
 const report=JSON.parse(readFileSync('tools/clouds/assets/production-manifest.json'));
 const bytes=readFileSync('web/public/sky/painted-clouds.webp');
 assert.equal(bytes.length,report.bytes); assert.ok(bytes.length<300000);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),report.sha256);
});
test('real renderer applies icing to both high and low painted layers',()=>{
 const state={...scenes[0],freezingFt:3000,layers:[{...scenes[0].layers[0],baseFtAmsl:3500,topFtAmsl:7000},{...scenes[0].layers[0],baseFtAmsl:12000,topFtAmsl:18000}],icing:[{baseFt:3500,topFt:7000},{baseFt:12000,topFt:18000}]};
 for(const dark of [false,true]) {
  const iced=render(state,dark).p,bare=render({...state,icing:[]},dark).p;
  assert.ok(changed(iced,bare,yForFt(7000,236),yForFt(3500,236))>150,'low hatch');
  assert.ok(changed(iced,bare,yForFt(18000,236),yForFt(12000,236))>150,'high hatch');
 }
});
test('reported missing top never paints a CB anvil; rain and freezing line still draw',()=>{
 const missing={...scenes[2],layers:[{...scenes[2].layers[0],topFtAmsl:null}],icing:[]};
 const a=render(missing).p,b=render({...missing,layers:[]}).p;
 assert.equal(changed(a,b,0,yForFt(4200,236)),0);
 assert.ok(changed(a,b,yForFt(4000,236),220)>50);
});
test('point sounding calls shared sprites with exact coverage and preserves icing',()=>{
 const canvas=createCanvas(390,236),ctx=canvas.getContext('2d'),calls=[];
 const paint=(...args)=>{calls.push(args);return paintCloudSprite(...args);};
 const props={width:390,height:236,rows:[],layers:scenes[0].layers,icing:scenes[0].icing,freezingFt:4000,bottomFt:0,groundFt:0,emphasis:'cloud',dark:false,ink:'#123',muted:'#567',cloudPainter:{canvas:createCanvas(390,236),paintCloudSprite:paint}};
 drawSounding(ctx,props,()=>{});
 assert.equal(calls.length,1);assert.equal(calls[0][1],'nimbostratus');assert.equal(calls[0][4],(390-16)*.75);
 const iced=ctx.getImageData(0,0,390,236).data;
 drawSounding(ctx,{...props,icing:[]},()=>{});
 assert.ok(changed(iced,ctx.getImageData(0,0,390,236).data,0,220)>100);
 calls.length=0;
 drawSounding(ctx,{...props,layers:[{...props.layers[0],topFtAmsl:null}]},()=>{});assert.equal(calls.length,0);
});
test('painted clouds, rain and icing preserve raised ground and unknown-ground frames',()=>{
 for(const dark of [false,true]) for(const groundFt of [14829,0,null]) for(const ready of [false,true]) {
  const canvas=createCanvas(390,236),ctx=canvas.getContext('2d'),calls=[];
  const bottomFt=groundFt==null?5000:0,floor=groundFt??bottomFt;
  const layer={...scenes[0].layers[0],baseFtAmsl:floor-1000,topFtAmsl:floor+9000,precipBottomFtAmsl:0};
  const props={width:390,height:236,rows:[],layers:[layer],icing:[{baseFt:0,topFt:40000}],freezingFt:floor+4000,bottomFt,groundFt,emphasis:'cloud',dark,ink:'#123',muted:'#567',
   cloudPainter:ready?{canvas:createCanvas(390,236),paintCloudSprite:(...args)=>{calls.push(args);return paintCloudSprite(...args);}}:undefined};
  drawSounding(ctx,{...props,layers:[],icing:[]},()=>{});const clear=ctx.getImageData(0,0,390,236).data;
  drawSounding(ctx,props,()=>{});const painted=ctx.getImageData(0,0,390,236).data;
  const yGround=plotY(heightFraction(floor,bottomFt),236);
  assert.equal(changed(clear,painted,Math.ceil(yGround)+1,236),0,'weather never paints under the ground/axis floor');
  if(ready) {assert.equal(calls.length,1);assert.ok(changed(clear,painted,0,yGround-1)>100,'visible cloud retains its above-ground part');}
  calls.length=0;
  drawSounding(ctx,{...props,layers:[{...layer,baseFtAmsl:floor-4000,topFtAmsl:floor-2000}]},()=>{});
  assert.equal(calls.length,0,'a wholly buried cloud is omitted');
  assert.equal(changed(clear,ctx.getImageData(0,0,390,236).data,0,236),0);
  // A cloud above terrain rains down to terrain, retaining the existing phase.
  drawSounding(ctx,{...props,layers:[{...layer,baseFtAmsl:floor+3000}]},()=>{});
  assert.equal(changed(clear,ctx.getImageData(0,0,390,236).data,Math.ceil(yGround)+1,236),0);
 }
});
test('disposed animator cannot retain pending work or request another frame',()=>{
 let requests=0;globalThis.requestAnimationFrame=()=>++requests;globalThis.cancelAnimationFrame=()=>{};
 const a=new SkyAnimator(createCanvas(390,236));
 a.show(scenes[0],{width:390,height:236,dpr:1,dark:false,seed:'test',coastKm:null});
 a.dispose();const n=requests;a.show(scenes[1],{width:390,height:236,dpr:1,dark:false,seed:'test',coastKm:null});assert.equal(requests,n);
});
test('delayed atlas readiness replaces a base fallback and deduplicates the decode',async()=>{
 const {loadImage}=await import('../tools/clouds/offline-canvas.mjs');
 const {configureCloudAtlas,prepareCloudSprites}=await import('../training/src/sky/painted.ts');
 const atlas=await loadImage('web/public/sky/painted-clouds.webp');Object.defineProperty(atlas,'src',{set(){}});
 let resolveDecode,decodes=0;const decoding=new Promise(resolve=>{resolveDecode=resolve;});atlas.decode=()=>{decodes++;return decoding;};
 globalThis.Image=function(){return atlas;};configureCloudAtlas('test-delayed');
 const jobs=new Map();let id=0;globalThis.requestAnimationFrame=cb=>{jobs.set(++id,cb);return id;};globalThis.cancelAnimationFrame=id=>jobs.delete(id);
 const c=createCanvas(390,236),a=new SkyAnimator(c),opts={width:390,height:236,dpr:1,dark:false,seed:'delayed',coastKm:null};
 a.showNow(scenes[2],opts);const before=c.getContext('2d').getImageData(0,0,390,236).data;
 assert.equal(a.stats.builds.length,1);assert.equal(decodes,1);
 const p=prepareCloudSprites();assert.equal(p,prepareCloudSprites());resolveDecode();await p;await Promise.resolve();await Promise.resolve();
 for(let n=0;n<20&&a.stats.builds.length<2;n++){const pending=[...jobs.values()];jobs.clear();pending.forEach(cb=>cb(performance.now()));}
 assert.equal(a.stats.builds.length,2,'ready callback must schedule painted replacement without a new state');
 a.showNow(scenes[2],opts);assert.ok(changed(before,c.getContext('2d').getImageData(0,0,390,236).data,10,180)>1000);
 a.dispose();assert.equal(decodes,1);
});
