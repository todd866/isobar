/** Offline acceptance: real DOM, gestures, lessons, viewport fit and frame times.
 * npm run build; TRAINING_SINGLE_PROCESS=1 node --experimental-strip-types tools/instrument-check.mjs OUT */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './browser.mjs';
import { INSTRUMENTS } from '../src/instruments/index.ts';
const out=resolve(process.argv[2]??'../build/instruments/previews');mkdirSync(out,{recursive:true});
const url=pathToFileURL(resolve('dist/index.html')).href;
const helper=process.env.VIEWPORT_HELPER??'';
const viewport=existsSync(helper)?await import(pathToFileURL(helper).href):null;
const browser=await launch();if(!browser)throw Error('Headless Chromium unavailable');
const reports=[],frames=[],errors=[],network=[];
let checks=0;
function check(value,why){assert.ok(value,why);checks++;}
async function open(page,id,mode='free',theme='light',size={width:1440,height:900}){
  await page.setViewportSize(size);await page.goto(`${url}?lab=${id}&mode=${mode}&theme=${theme}`);await page.waitForSelector('.i-svg');
}
async function bounds(page,label,screenshot){
  if(viewport){
    const r=await viewport.auditViewport(page,{primary:[{selector:'.i-svg',label:'Instrument diagram',minWidth:250,minHeight:140}],controls:[{selector:'.i-modes',minHeight:32},...(await page.locator('.i-controls').isVisible()?[{selector:'.i-controls',minHeight:20}]:[]),{selector:'.i-readouts',minHeight:30}],screenshotPath:screenshot});
    reports.push({label,...r});check(r.passed,`${label}: ${JSON.stringify(r.failures)}`);
  }else{
    const r=await page.evaluate(()=>{const doc=document.documentElement;return {overflow:doc.scrollWidth-innerWidth,bottom:document.querySelector('.i-foot').getBoundingClientRect().bottom,height:innerHeight};});
    reports.push({label,...r});check(r.overflow<=1&&r.bottom<=r.height+1,`${label} fit`);
  }
}
try{
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(String(e)));
  await page.route(/^https?:/,route=>{network.push(route.request().url());return route.abort();});
  for(const def of INSTRUMENTS){
    for(const [width,height] of [[1440,900],[390,844]])for(const theme of ['light','dark']){
      const label=`${def.id}-${width}x${height}-${theme}`;await open(page,def.id,'free',theme,{width,height});
      await bounds(page,label,`${out}/instr-${label}.png`);
      await page.screenshot({path:`${out}/instr-${label}.png`,scale:'css'});
      const control=page.locator('[data-i-input]').first(),before=Number(await control.inputValue());await control.focus();await page.keyboard.press('ArrowRight');
      check(Number(await control.inputValue())>before,`${label} keyboard slider`);
      const handle=page.locator('[data-handle]').first();await handle.focus();await page.keyboard.press('ArrowRight');
      check(await page.locator('[data-handle]:focus').count()===1,`${label} SVG focus survives paint`);
      await page.locator('[data-i-mode="how"]').click();check(await page.locator('.i-how section').count()===3,`${label} mechanism view`);
      await page.locator('[data-i-mode="free"]').click();check(await page.locator('.i-svg').count()===1,`${label} offline return`);
    }
    // Full estimate -> watch -> guided -> solo -> easier retry -> solved flow.
    await open(page,def.id,'learn','dark',{width:390,height:844});const s=def.scenario(0);
    check((await page.locator('.i-readouts').innerText()).includes('?'),`${def.id} answer hidden before estimate`);
    await bounds(page,`${def.id}-learn-phone`);await page.screenshot({path:`${out}/instr-${def.id}-learn-phone.png`,scale:'css'});
    await page.locator('[data-i-entry]').fill(String(s.answer*.8));await page.locator('[data-i-answer]').evaluate(f=>f.requestSubmit());
    check(await page.locator('[data-i-next]').isDisabled(),`${def.id} cannot skip demonstration`);
    await page.locator('[data-i-watch]').click();await page.waitForFunction(()=>!document.querySelector('[data-i-next]').disabled);
    await page.locator('[data-i-next]').click();check(await page.locator('[data-phase="guided"]').count()===1,`${def.id} guided`);
    check(await page.locator(`[data-handle="${s.guideKey}"].i-guide-handle`).count()===1,`${def.id} coaching marks the diagram control`);
    await page.locator(`[data-i-input="${s.guideKey}"]`).evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},s.guideTarget);
    await page.locator('[data-i-check]').click();check(await page.locator('[data-phase="solo"]').count()===1,`${def.id} solo`);
    await page.locator('[data-i-entry]').fill(String(s.answer+1000));await page.locator('[data-i-answer]').evaluate(f=>f.requestSubmit());
    check(await page.locator('[data-phase="scaffold"]').count()===1,`${def.id} miss opens easier support`);
    check(await page.locator('.i-controls input:not(:disabled)').count()===1,`${def.id} support one control only`);
    await bounds(page,`${def.id}-guided-phone`);
    const actionBox=await page.locator('[data-i-check]').boundingBox();check(actionBox.y+actionBox.height<844,`${def.id} guided action visible`);
    await page.screenshot({path:`${out}/instr-${def.id}-guided-phone.png`,scale:'css'});
    await page.locator(`[data-i-input="${s.guideKey}"]`).evaluate((el,value)=>{el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},s.guideTarget);
    await page.locator('[data-i-check]').click();await page.locator('[data-i-entry]').fill(String(s.answer));await page.locator('[data-i-answer]').evaluate(f=>f.requestSubmit());
    check(await page.locator('[data-phase="complete"]').count()===1,`${def.id} solved original`);
    // Gesture cancellation and trackpad zoom change only the graphic scale.
    await page.locator('[data-i-mode="free"]').click();const box=await page.locator('.i-svg').boundingBox();
    const vals=await page.locator('[data-i-input]').evaluateAll(es=>es.map(e=>e.value));
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.keyboard.down('Control');await page.mouse.wheel(0,-70);await page.keyboard.up('Control');
    await page.waitForFunction(()=>document.querySelector('[data-i-drawing]').getAttribute('transform')!=='translate(0 0) scale(1)');
    assert.deepEqual(await page.locator('[data-i-input]').evaluateAll(es=>es.map(e=>e.value)),vals,`${def.id} zoom preserves physics`);checks++;
    await page.locator('[data-i-reset]').click();
    const touchHandle=page.locator('[data-handle]').first(),touchKey=await touchHandle.getAttribute('data-handle'),tb=await touchHandle.boundingBox();
    const touchBefore=await page.locator(`[data-i-input="${touchKey}"]`).inputValue();
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tb.x+tb.width/2,y:tb.y+tb.height/2,id:1}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tb.x+tb.width/2+35,y:tb.y+tb.height/2-35,id:1}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await page.waitForFunction(({key,before})=>document.querySelector(`[data-i-input="${key}"]`).value!==before,{key:touchKey,before:touchBefore});
    checks++;await cdp.detach();
    const wheelRange=page.locator('[data-i-input]').first(),wheelBefore=await wheelRange.inputValue(),wb=await wheelRange.boundingBox();
    await page.mouse.move(wb.x+wb.width/2,wb.y+wb.height/2);await page.mouse.wheel(0,Number(wheelBefore)>=Number(await wheelRange.getAttribute('max'))?30:-30);
    await page.waitForFunction(before=>document.querySelector('[data-i-input]').value!==before,wheelBefore);checks++;
    // Measure actual requestAnimationFrame cadence during continuously changing inputs.
    await open(page,def.id,'free');
    frames.push({id:def.id,...await page.evaluate(async()=>{
      const range=document.querySelector('[data-i-input]'),times=[];let last=performance.now();
      for(let i=0;i<100;i++){await new Promise(requestAnimationFrame);const now=performance.now();if(i>4)times.push(now-last);last=now;range.value=String(Number(range.min)+(i%30)*Number(range.step));range.dispatchEvent(new Event('input',{bubbles:true}));}
      times.sort((a,b)=>a-b);return {medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.floor(times.length*.95)],over34Ms:times.filter(t=>t>34).length};
    })});
  }
  // Numeric miss opens matching support, keeping the same problem and worksheet.
  for(const card of ['drill.interpolate.r2','drill.isa-dev.r1','drill.isa-dev.r2','drill.cg-shift.r3','drill.met-level.r2']){
    await page.setViewportSize({width:1440,height:900});await page.goto(`${url}?card=${card}&theme=light`);await page.waitForSelector('[data-numeric]');
    await page.locator('[data-numeric]').fill('999999');await page.locator('[data-numeric]').press('Enter');
    await page.waitForSelector('[data-instrument-support] .i-svg');
    check(await page.locator('.worksheet').count()===1,`${card} worksheet remains beside instrument`);
    check(await page.locator('[data-phase="scaffold"]').count()===1,`${card} immediate guided support`);
    if(card==='drill.isa-dev.r2')check((await page.locator('.i-readouts').innerText()).includes('Table entry · 3°C'),'ISA support distinguishes raw deviation from rounded table entry');
    if(card==='drill.met-level.r2')check((await page.locator('.i-prompt').innerText()).includes('½'),'descent retry keeps half-height despite lower difficulty rung');
    const steps=await page.evaluate(()=>window.__TRAINING_STEPS());
    if(steps[0]){await page.locator(`[data-step="${steps[0].id}"]`).fill(steps[0].text);check(await page.locator('[data-phase="scaffold"]').count()===1,`${card} support preserved while typing`);}
    await page.screenshot({path:`${out}/instr-support-${card}.png`,scale:'css'});
    await page.setViewportSize({width:390,height:844});await page.locator('[data-support-return]').click();check(await page.locator('.worksheet').isVisible(),`${card} return to drill`);
  }
  for(const size of [{width:1280,height:720},{width:844,height:390}]){await open(page,'wind','free','light',size);await bounds(page,`extra-${size.width}x${size.height}`);if(size.height<600){await page.locator('[data-i-controls-toggle]').click();check(await page.locator('.i-controls').isVisible(),'landscape input drawer');await page.keyboard.press('Escape');}await page.screenshot({path:`${out}/instr-extra-${size.width}x${size.height}.png`,scale:'css'});}
  await open(page,'interpolation','how','light',{width:390,height:844});await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'200% text has no sideways overflow');
  check(await page.locator('[data-lab-select]').evaluate(select=>{const s=getComputedStyle(select);return select.clientHeight>=parseFloat(s.fontSize)*1.3+parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)-1;}),'200% instrument label is not vertically clipped');
  await page.screenshot({path:`${out}/instr-large-text.png`,scale:'css'});
  await page.close();
  for(const f of frames)check(f.medianMs<=20&&f.p95Ms<=34&&f.over34Ms<=5,`${f.id} frame cadence`);
  assert.equal(errors.length,0,errors.join('\n'));assert.equal(network.length,0,'no external request required');
}finally{await browser.close();writeFileSync(`${out}/acceptance.json`,JSON.stringify({checks,reports,frames,errors,network},null,2));}
console.log(`${checks} acceptance checks; 0 external requests. Frame times: ${JSON.stringify(frames)}`);
