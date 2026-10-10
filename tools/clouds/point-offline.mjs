#!/usr/bin/env node
// Canvas fields only; DOM labels/viewport need the real point-panel journey.
import {writeFileSync,mkdirSync} from 'node:fs';
import {prepareOfflineAtlas,createCanvas} from './offline-canvas.mjs';
import {scenes} from './production-scenes.mjs';
import {drawSounding} from '../../web/src/lib/point/sounding.ts';
import {paintCloudSprite} from '../../training/src/sky/painted.ts';
import {drawBarb} from '../../training/src/sky/render.ts';
await prepareOfflineAtlas();mkdirSync('build/clouds-phase2',{recursive:true});
for(const dark of [false,true]) for(const groundFt of [0,14829,null]) {
 const w=390,h=320,c=createCanvas(w*2,h*2),ctx=c.getContext('2d');ctx.scale(2,2);
 const scene=scenes[2],ink=dark?'#9fd0e4':'#174e66';
 const bottomFt=groundFt==null?5000:0,floor=groundFt??bottomFt;
 const heights=[...new Set([floor,5000,10000,20000,30000,40000])].filter(ft=>ft>=floor).sort((a,b)=>a-b);
 const rows=heights.map(feet=>({id:String(feet),feet,temp:15-feet*.0019,dew:10-feet*.002,from:270,speed:10+feet/1000}));
 drawSounding(ctx,{width:w,height:h,rows,layers:scene.layers,icing:scene.icing,freezingFt:scene.freezingFt,bottomFt,groundFt,emphasis:'cloud',dark,ink,muted:dark?'#a3b6c3':'#617583',cloudPainter:{canvas:createCanvas(w*2,h*2),dpr:2,paintCloudSprite}},(x,y,kt,from,len)=>drawBarb(ctx,x,y,kt,from,ink,len));
 const suffix=groundFt==null?'-unknown':groundFt>0?'-raised':'';
 writeFileSync(`build/clouds-phase2/point-field-${dark?'dark':'light'}-390${suffix}.png`,c.toBuffer('image/png'));
}
