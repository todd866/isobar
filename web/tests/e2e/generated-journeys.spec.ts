import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {transitionWalk} from './transition-walk';
import {choosePlace} from './place-field';
import {MIN_GLOBAL_HALF_HEIGHT} from '../../src/lib/camera';

// Ordered-pair coverage is deliberately bounded. This is not a proof of all
// gesture timings, weather products, hardware or arbitrary-length histories.
const actions=['vertical','horizontal','pinch','drag','reverse','mode','lens','seek','hold','point','dismiss','resize','north','home'] as const;
const scenarios=[
 {name:'Perth-laptop',lat:-31.95,lon:115.86,height:2,phone:false,history:false,delay:false},
 {name:'Sydney-phone-delayed',lat:-33.87,lon:151.21,height:2,phone:true,history:false,delay:true},
 {name:'Everest-history',lat:27.9881,lon:86.925,height:.13,phone:false,history:true,delay:false},
 {name:'dateline-phone-delayed',lat:55,lon:179,height:35,phone:true,history:false,delay:true},
];
const baseSeed=Number(process.env.ISOBAR_JOURNEY_SEED??20261010);
for(const [scenarioIndex,scenario] of scenarios.entries())test(`generated control transitions: ${scenario.name}`,async({page},info)=>{
 test.setTimeout(600000);
 const seed=(baseSeed+scenarioIndex*7919)>>>0,walk=transitionWalk(actions,seed);
 const trace:unknown[]=[],pairs=new Set<string>(),errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize(scenario.phone?{width:390,height:844}:{width:1280,height:720});
 let delayed=0;
 if(scenario.delay)await page.route('**/data/frames/**',async route=>{if(delayed++<8)await new Promise(r=>setTimeout(r,180));await route.continue();});
 // Present-day external profiles are unavailable in this run; the retained
 // map and compact missing state must survive. Success/delayed success is
 // exercised by point-section.spec.ts with recorded profile responses.
 await page.route('https://api.open-meteo.com/**',r=>r.fulfill({status:503,body:'fixture unavailable'}));
 await page.route('https://marine-api.open-meteo.com/**',r=>r.abort());
 await page.goto(scenario.history?'/history?event=everest-1953':'/');
 const stage=page.locator('[data-api="1"]'),canvas=stage.locator('canvas[tabindex="0"]');await stage.waitFor();await expect(stage).toHaveAttribute('data-renderer','webgl2');
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 if(scenario.name.startsWith('Perth'))await choosePlace(page,'Perth','perth');
 if(scenario.name.startsWith('Sydney'))await choosePlace(page,'Sydney','sydney');
 await stage.evaluate((e:any,s)=>e.chartApi.setView(s.lat,s.lon,s.height),scenario);
 const state=()=>stage.evaluate((e:any)=>({camera:{...e.chartApi.camera()},pitch:e.chartApi.tilt(),time:Number(e.dataset.validMs),mode:e.querySelector('[aria-label="3D map"]')?.getAttribute('aria-pressed')}));
 let mode3D=await page.getByRole('button',{name:'3D map',exact:true}).getAttribute('aria-pressed')==='true';
 try {
  for(const [step,action] of walk.entries()){
   const before=await state();
   const b=(await stage.boundingBox())!,x=b.x+b.width*.4,y=b.y+b.height*.33;
   const receivesGesture=await canvas.evaluate((node,p)=>document.elementFromPoint(p.x,p.y)===node,{x,y});
   const sign=((seed+step*17)%3===0)?-1:1;
   const row:{step:number;action:string;before:unknown;after?:unknown;passed?:boolean}={step,action,before};trace.push(row);
   await test.step(`${seed}/${step}: ${action}`,async()=>{
    if(action==='vertical'||action==='horizontal'){
     await page.mouse.move(x,y);await page.mouse.wheel(action==='horizontal'?sign*120:0,action==='vertical'?sign*150:0);
    }else if(action==='pinch'){
     await page.mouse.move(x,y);await page.keyboard.down('Control');
     try{await page.mouse.wheel(0,sign*30);}finally{await page.keyboard.up('Control');}
    }else if(action==='drag'||action==='reverse'){
     await page.mouse.move(x,y);await page.mouse.down();
     try{await page.mouse.move(x+35*sign,y+25*sign,{steps:6});if(action==='reverse')await page.mouse.move(x,y,{steps:6});}finally{await page.mouse.up();}
    }else if(action==='mode'){
     mode3D=!mode3D;await page.getByRole('button',{name:mode3D?'3D map':'2D map',exact:true}).click();
    }else if(action==='lens'){
     const lenses=['pressure','wind','temp'];const lens=page.locator(`[data-lens=${lenses[step%3]}]`).first();await lens.click();await expect(lens).toHaveAttribute('aria-checked','true');
    }else if(action==='seek'){
     const slider=page.getByRole('slider',{name:'Forecast time'});const value=Number(await slider.getAttribute('aria-valuenow')),max=Number(await slider.getAttribute('aria-valuemax'));await slider.focus();await page.keyboard.press(value>=max?'ArrowLeft':'ArrowRight');await expect(slider).not.toHaveAttribute('aria-valuenow',String(value));
    }else if(action==='hold'){
     await page.mouse.move(x,y);await page.mouse.down();await page.waitForTimeout(120);
     expect((await state()).time).toBe(before.time);
     // Move past click slop before release: this hold journey must not select a new point.
     await page.mouse.move(x+12,y,{steps:3});await page.mouse.up();
    }else if(action==='point'){
     const panel=page.locator('[data-point-panel]');if(await panel.count())await panel.getByRole('button',{name:'Close point'}).click();
     const bounds=(await stage.boundingBox())!;await page.mouse.click(bounds.x+bounds.width*.5,bounds.y+bounds.height*.6);
     await expect(panel).toBeVisible();await expect(panel).not.toHaveAttribute('data-point-state','loading');
     if(await panel.getAttribute('data-point-state')==='unavailable')expect((await panel.boundingBox())!.height).toBeLessThan(180);
    }else if(action==='dismiss'){
     await page.keyboard.press('Escape');await expect(page.locator('[data-point-panel]')).toHaveCount(0);
    }else if(action==='resize'){
     await page.setViewportSize(scenario.phone?(step%2?{width:844,height:390}:{width:390,height:844}):(step%2?{width:1024,height:600}:{width:1280,height:720}));
    }else if(action==='north'){
     if(mode3D)await page.getByRole('button',{name:'North up',exact:true}).click();else{await canvas.focus();await page.keyboard.press('n');}
    }else if(action==='home'){
     await page.getByRole('button',{name:'Recenter map'}).click();
    }
    // Complete intentional framing glides; keep playback paused throughout.
    await page.waitForTimeout(['point','dismiss','resize','home'].includes(action)?450:40);
    const after=await state();row.after=after;
    expect([after.camera.centerX,after.camera.centerY,after.camera.halfWidth,after.camera.halfHeight,after.camera.bearingRadians??0,after.pitch].every(Number.isFinite)).toBe(true);
    expect(after.camera.halfHeight).toBeGreaterThan(0);expect(after.camera.halfHeight).toBeLessThanOrEqual(90+1e-9);
    expect(after.pitch).toBeGreaterThanOrEqual(0);expect(after.pitch).toBeLessThanOrEqual(1.3091);
    if(action!=='seek')expect(after.time).toBe(before.time);
    await expect(page.getByRole('button',{name:'3D map',exact:true})).toHaveAttribute('aria-pressed',String(mode3D));
    if(!mode3D){expect(after.pitch).toBe(0);expect(after.camera.bearingRadians??0).toBe(0);}
    if(action==='north'&&mode3D){expect(after.camera.bearingRadians).toBe(0);expect(after.camera.halfHeight).toBe(before.camera.halfHeight);expect(after.pitch).toBe(before.pitch);}
    if(action==='home'){expect(after.camera.bearingRadians??0).toBe(0);await expect(page.locator('[data-point-panel]')).toHaveCount(0);}
    // A control sequence must still respond, not just retain finite values.
    // At zoom/tilt limits or beneath an inspector a no-op can be intentional.
    const canPinch=sign<0 ? before.camera.halfHeight>MIN_GLOBAL_HALF_HEIGHT+1e-9
      : before.camera.halfWidth<180-1e-9&&before.camera.halfHeight<90-1e-9;
    if(receivesGesture&&action==='pinch'&&canPinch)
      expect(after.camera.halfHeight).not.toBe(before.camera.halfHeight);
    if(receivesGesture&&action==='horizontal'&&mode3D)
      expect(after.camera.bearingRadians??0).not.toBe(before.camera.bearingRadians??0);
    if(receivesGesture&&action==='vertical'&&mode3D&&before.pitch>.15&&before.pitch<1.15)
      expect(after.pitch).not.toBe(before.pitch);
    if(action==='lens'){expect(after.camera.centerX).toBe(before.camera.centerX);expect(after.camera.centerY).toBe(before.camera.centerY);expect(after.camera.halfHeight).toBe(before.camera.halfHeight);}
    expect(errors).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1&&document.documentElement.scrollHeight<=innerHeight+1)).toBe(true);
    await expect(page.getByRole('button',{name:'Recenter map'})).toBeInViewport();
    row.passed=true;
    if(step>0)pairs.add(`${walk[step-1]}>${action}`);
    if(step%32===0)await page.screenshot({path:info.outputPath(`sequence-${seed}-${step}.png`)});
   });
  }
  expect(pairs.size).toBe(actions.length**2);if(scenario.delay)expect(delayed).toBeGreaterThan(0);
  // Finish every sequence with a real, recoverable map rather than merely
  // accepting finite properties in an unusable terminal state.
  await page.getByRole('button',{name:'Recenter map'}).click();
  await expect(page.getByRole('button',{name:'2D map',exact:true})).toBeInViewport();
  await page.screenshot({path:info.outputPath(`recovered-${seed}.png`)});
 }catch(error){await page.screenshot({path:info.outputPath(`failure-${seed}.png`)});throw error;}
 finally{
  await page.mouse.up();await page.keyboard.up('Control');
  const replayPath=info.outputPath('journey-replay.json');
  await writeFile(replayPath,JSON.stringify({seed,scenario:scenario.name,plannedActions:walk.length,completedActions:trace.filter((r:any)=>r.passed).length,completedOrderedPairs:[...pairs],unexecutedOrderedPairs:actions.flatMap(a=>actions.map(b=>`${a}>${b}`)).filter(pair=>!pairs.has(pair)),possiblePairs:actions.length**2,delayed,trace},null,2));
  await info.attach('journey-coverage',{path:replayPath,contentType:'application/json'});
 }
});
