#!/usr/bin/env node
/** Offline headless UI acceptance. Build training/ first. No user browser or
 * visible application is opened. Outputs only to build/e6b-polish by default.
 * PLAYWRIGHT_MODULE can name an existing installation; never downloads one. */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { auditViewport } from './viewport-fit.mjs';
const require=createRequire(import.meta.url);
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.E6B_BROWSER||'chromium';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(root,process.env.E6B_QA_OUT||'build/e6b-polish/previews');
await mkdir(output,{recursive:true});
const sizes=[[1024,600],[1280,720],[1440,900],[1920,1080],[390,844],[430,932],[844,390]];
const results=[];
let browser;
try {
  browser=await playwright[engine].launch({headless:true,...(process.env.E6B_BROWSER_PATH?{executablePath:process.env.E6B_BROWSER_PATH}:{})});
  for(const [width,height] of sizes)for(const theme of ['light','dark']){
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1,colorScheme:theme,reducedMotion:'reduce'});
    const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>localStorage.setItem('isobar.e6b.record',JSON.stringify({version:1,memories:{},stages:{},bests:{},daily:null,streak:{count:0,lastDay:null},firstContact:true})));
    await page.goto(`${pathToFileURL(resolve(root,'training/dist/e6b.html'))}?theme=${theme}`);
    for(const state of ['home','guided','reading','jet','table','how','tour']){
      await page.evaluate(state=>{
        const h=window.e6b;
        const reading=()=>{
          const p=h.activeExercise,i=p.procedure.findIndex(s=>s.physical.kind==='read');
          for(const step of p.procedure.slice(0,i)){
            h.applyStep(step.demoStep);
            if(step.physical.kind==='orient')h.setViewRotation(step.physical.angle,false,false);
          }
          h.seqGo(i);
        };
        if(state==='home')h.openHome();
        if(state==='guided')h.openExercise('time-2','guided');
        if(state==='reading'){h.openExercise('time-2','guided');reading();}
        if(state==='jet'){h.openExercise('jet-3','guided');reading();}
        if(state==='table'){h.openExercise('components-3','guided');reading();}
        if(state==='how')h.openHow();
        if(state==='tour')h.startTour();
      },state);
      const path=resolve(output,`e6b-polish-${width}x${height}-${theme}-${state}.png`);
      const report=await auditViewport(page,{primary:[{selector:'.e6b-dial',minWidth:220,minHeight:220}],controls:[{selector:'.e6b-strip'}],screenshotPath:path});
      results.push({width,height,theme,state,report,errors:[...errors]});
      await page.screenshot({path});
      await page.evaluate(()=>window.e6b.openHow(false));
    }
    // Real handlers, Safari-like cumulative GestureEvents on the background.
    await page.evaluate(()=>window.e6b.setMode('free'));
    const before=await page.evaluate(()=>window.e6b.snapshot());
    await page.locator('.e6b-svg:not(.e6b-wind)').evaluate(svg=>{
      const r=svg.getBoundingClientRect();
      for(const [name,rotation] of [['gesturestart',0],['gesturechange',20],['gesturechange',45],['gestureend',45]]){
        const event=new Event(name,{bubbles:true,cancelable:true});
        Object.assign(event,{clientX:r.right-2,clientY:r.top+r.height/2,scale:1,rotation,altKey:true});svg.dispatchEvent(event);
      }
    });
    const after=await page.evaluate(()=>window.e6b.snapshot());
    assert.equal(after.theta,before.theta);assert.equal(after.cursor,before.cursor);
    assert.ok(Math.abs(((after.viewAngle-before.viewAngle+360)%360)-45)<.01);
    // All content is bundled: navigation continues with networking unavailable.
    await page.context().setOffline(true);
    await page.evaluate(()=>{window.e6b.openExercise('mach-3','guided');window.e6b.openHome();});
    await page.evaluate(()=>{
      // Double the actual HTML label sizes, including px-based controls. A
      // root font-size alone leaves these controls unchanged.
      const labels=[...document.querySelectorAll('.e6b button,.e6b input,.e6b p,.e6b label,.e6b h1,.e6b h2,.e6b span,.e6b strong')];
      const sizes=labels.map(el=>parseFloat(getComputedStyle(el).fontSize));
      labels.forEach((el,i)=>el.style.fontSize=`${sizes[i]*2}px`);
    });
    results.push({width,height,theme,state:'large-text',report:await auditViewport(page,{primary:[{selector:'.e6b-dial',minWidth:180,minHeight:180}],controls:[{selector:'.e6b-strip'}]})});
    await page.screenshot({path:resolve(output,`e6b-polish-${width}x${height}-${theme}-large-text.png`)});
    await page.close();
  }
  // Record animation timing separately from reduced-motion layout probes.
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
  await page.goto(pathToFileURL(resolve(root,'training/dist/e6b.html')).href);
  const timing=await page.evaluate(async()=>{
    window.e6b.setMode('free');
    const times=[];let last=performance.now();
    window.e6b.setViewRotation(150,true);
    for(let i=0;i<60;i++)await new Promise(resolve=>requestAnimationFrame(t=>{times.push(t-last);last=t;resolve();}));
    return {intervals:times,final:window.e6b.snapshot()};
  });
  results.push({state:'rotation-timing',timing});await page.close();
  assert.ok(results.every(r=>!(r.errors?.length)), 'browser runtime errors');
  assert.ok(results.every(r=>!r.report?.failures?.length), 'viewport failures; inspect report and screenshots');
} catch(error) {
  results.push({state:'incomplete',error:String(error)});throw error;
} finally {
  await browser?.close();
  await writeFile(resolve(output,'report.json'),JSON.stringify(results,null,2)+'\n');
}
console.log(`E6-B acceptance complete: ${output}`);
