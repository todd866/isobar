import {test,expect} from '@playwright/test';
test.setTimeout(120000);
for(const [seed,place,phone] of [[17,'Perth',false],[83,'Everest',false],[129,'Everest',true]] as const) {
 test(`camera recovery seed ${seed}: ${place}${phone?' phone':''}`,async({page},info)=>{
  await page.setViewportSize(phone?{width:390,height:844}:{width:1280,height:720});
  await page.goto(place==='Everest'?'/history?event=everest-1953&terrain=photo':'/');
  const stage=page.locator('[data-api="1"]');await stage.waitFor();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await stage.evaluate((el:any,where)=>el.chartApi.setView(where==='Everest'?27.9881:-31.95,where==='Everest'?86.925:115.86,where==='Everest'?.02:.6),place);
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  const camera=()=>stage.evaluate((el:any)=>el.chartApi.camera());
  const time=await stage.getAttribute('data-valid-ms');
  let random=seed; const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random/4294967296;};
  const actions=['orbit','tilt','pinch','drag','mode','resize','orbit','pinch','drag','tilt'];
  for(const [index,action] of actions.entries()){
   const sign=next()<.5?-1:1,box=(await stage.boundingBox())!,x=box.x+box.width*.45,y=box.y+box.height*.55;
   await page.mouse.move(x,y);
   if(action==='orbit')await page.mouse.wheel(sign*160,0);
   if(action==='tilt')for(let i=0;i<4;i++)await page.mouse.wheel(0,sign*160);
   if(action==='pinch'){await page.keyboard.down('Control');await page.mouse.wheel(0,sign*30);await page.keyboard.up('Control');}
   if(action==='drag'){await page.mouse.down();await page.mouse.move(x+sign*30,y-sign*35,{steps:7});await page.mouse.up();}
   if(action==='mode'){await page.getByRole('button',{name:'2D map',exact:true}).click();await page.getByRole('button',{name:'3D map',exact:true}).click();}
   if(action==='resize')await page.setViewportSize(phone?{width:430,height:800}:{width:1100,height:740});
   const c=await camera();
   expect([c.centerX,c.centerY,c.halfWidth,c.halfHeight,c.bearingRadians??0].every(Number.isFinite),`seed ${seed} step ${index} ${action}`).toBe(true);
   expect(c.halfHeight).toBeGreaterThan(0);expect(c.halfHeight).toBeLessThanOrEqual(90);
   expect(Number(await stage.getAttribute('data-tilt'))).toBeGreaterThanOrEqual(0);
   expect(Number(await stage.getAttribute('data-tilt'))).toBeLessThanOrEqual(1.3091);
   expect(await stage.getAttribute('data-valid-ms')).toBe(time);
  }
  // Force a visible non-north bearing using actual controls before recovery.
  const box=(await stage.boundingBox())!;await page.mouse.move(box.x+box.width*.5,box.y+box.height*.6);await page.mouse.wheel(160,0);
  const before=await camera(),pitch=await stage.getAttribute('data-tilt');
  expect(Math.abs(before.bearingRadians??0)).toBeGreaterThan(.05);
  await page.getByRole('button',{name:'North up',exact:true}).click();
  await expect(stage).toHaveAttribute('data-bearing','0.0000');
  const after=await camera();expect(after).toEqual({...before,bearingRadians:0});
  expect(await stage.getAttribute('data-tilt')).toBe(pitch);expect(await stage.getAttribute('data-valid-ms')).toBe(time);
  await page.getByRole('button',{name:'2D map',exact:true}).click();await page.getByRole('button',{name:'3D map',exact:true}).click();
  await expect(stage).toHaveAttribute('data-bearing','0.0000');
  await stage.locator('canvas[tabindex="0"]').focus();await page.keyboard.press('ArrowRight');await page.keyboard.press('n');
  await expect(stage).toHaveAttribute('data-bearing','0.0000');
  await page.screenshot({path:info.outputPath('north-up-recovered.png')});
 });
}

test('travel recovers north automatically; deliberate orbit and held gestures stay under user control',async({page})=>{
 await page.goto('/');const stage=page.locator('[data-api="1"]');await stage.waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await page.getByRole('button',{name:'3D map',exact:true}).click();
 const box=(await stage.boundingBox())!,x=box.x+box.width*.45,y=box.y+box.height*.6;
 const camera=()=>stage.evaluate((el:any)=>el.chartApi.camera());
 await page.mouse.move(x,y);await page.mouse.wheel(160,0);
 const orbit=await camera();await page.waitForTimeout(1250);
 expect((await camera()).bearingRadians).toBe(orbit.bearingRadians);
 await page.mouse.down();await page.mouse.move(x+30,y-20,{steps:5});
 const held=await camera();await page.waitForTimeout(1200);
 expect((await camera()).bearingRadians).toBe(held.bearingRadians);
 await page.mouse.up();
 const travel=await camera(),time=await stage.getAttribute('data-valid-ms');
 await expect.poll(async()=>(await camera()).bearingRadians,{timeout:2500}).toBe(0);
 expect(await camera()).toEqual({...travel,bearingRadians:0});
 expect(await stage.getAttribute('data-valid-ms')).toBe(time);
 // A fresh deliberate look interrupts a pending travel recovery.
 await page.mouse.move(x,y);await page.mouse.wheel(160,0);
 await page.keyboard.down('Control');await page.mouse.wheel(0,-20);await page.keyboard.up('Control');
 await page.waitForTimeout(550);await page.mouse.wheel(-80,0);
 const interrupted=await camera();await page.waitForTimeout(1200);
 expect((await camera()).bearingRadians).toBe(interrupted.bearingRadians);
});

for (const variant of [
 {name:'short-laptop',width:1280,height:720,dark:false,enlarged:false},
 {name:'phone-dark',width:390,height:844,dark:true,enlarged:false},
 {name:'phone-landscape',width:844,height:390,dark:false,enlarged:false},
 {name:'phone-large-text',width:390,height:844,dark:false,enlarged:true},
]) test(`north-up controls fit ${variant.name}`,async({page},info)=>{
 await page.setViewportSize({width:variant.width,height:variant.height});
 await page.emulateMedia({colorScheme:variant.dark?'dark':'light'});
 await page.goto('/');const stage=page.locator('[data-api="1"]');await stage.waitFor();
 await page.getByRole('button',{name:'3D map',exact:true}).click();
 if(variant.enlarged)await page.locator('[aria-label="North up"],[aria-label="2D map"],[aria-label="3D map"]').evaluateAll(nodes=>{
  for(const node of nodes){const element=node as HTMLElement;element.style.fontSize=`${parseFloat(getComputedStyle(element).fontSize)*2}px`;}
 });
 const {assertViewport}=await import('../../../tools/viewport-fit.mjs');
 await assertViewport(page,{primary:[{selector:'[data-api="1"]',minWidth:250,minHeight:120}],controls:[
  {selector:'[aria-label="North up"]',minWidth:32,minHeight:32},
  {selector:'[aria-label="2D map"]',minWidth:32,minHeight:32},
  {selector:'[aria-label="3D map"]',minWidth:32,minHeight:32},
 ],screenshotPath:info.outputPath('north-controls.png')});
 const north=page.getByRole('button',{name:'North up',exact:true});
 expect(await north.evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 await north.click();
 await expect(stage).toHaveAttribute('data-bearing','0.0000');
});
