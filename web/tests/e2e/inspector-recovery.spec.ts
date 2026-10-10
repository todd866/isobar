import {test,expect} from '@playwright/test';
test.setTimeout(90000);

for(const viewport of [
 {name:'laptop',width:1280,height:720},
 {name:'phone',width:390,height:844},
 {name:'landscape',width:844,height:390},
 {name:'large-text-dark',width:390,height:844,large:true},
]) test(`historical inspection away from Everest leaves a usable map: ${viewport.name}`,async({page},info)=>{
 await page.setViewportSize(viewport);
 if(viewport.large)await page.emulateMedia({colorScheme:'dark'});
 let liveProfiles=0;
 await page.route('https://api.open-meteo.com/**',r=>{liveProfiles++;return r.abort();});
 await page.goto('/history?event=everest-1953');
 const stage=page.locator('[data-api="1"]');await stage.waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await stage.evaluate((el:any)=>el.chartApi.setView(37.24,128.71,4));
 await page.getByRole('button',{name:'3D map',exact:true}).click();
 const box=(await stage.boundingBox())!;
 await page.mouse.click(box.x+box.width*.5,box.y+box.height*.55);
 const panel=page.locator('[data-point-panel]');
 await expect(panel).toHaveAttribute('data-point-state','unavailable');
 if(viewport.large)await panel.evaluate(el=>{for(const node of el.querySelectorAll('strong,span,button')){const e=node as HTMLElement;e.style.fontSize=`${parseFloat(getComputedStyle(e).fontSize)*2}px`;}});
 const {assertViewport}=await import('../../../tools/viewport-fit.mjs');
 await assertViewport(page,{primary:[{selector:'[data-api="1"]',minWidth:250,minHeight:140}],controls:[{selector:'[aria-label="Close point"]',minWidth:32,minHeight:32},{selector:'[aria-label="Recenter map"]',minWidth:32,minHeight:32},{selector:'[aria-label="North up"]',minWidth:32,minHeight:32}],screenshotPath:info.outputPath('compact-inspector.png')});
 const size=(await panel.boundingBox())!;expect(size.height).toBeLessThan(viewport.large?230:150);
 const title=await panel.locator('[data-point-title]').textContent();expect(title).not.toBe('Everest');
 expect(liveProfiles).toBe(0);
 await page.waitForTimeout(500); // finish the initial point-framing glide
 const time=await stage.getAttribute('data-valid-ms');
 const camera=await stage.evaluate((el:any)=>el.chartApi.camera());
 await page.locator('[data-lens=temp]').first().click();
 expect(await stage.getAttribute('data-valid-ms')).toBe(time);
 expect(await stage.evaluate((el:any)=>el.chartApi.camera())).toEqual(camera);
 const home=page.getByRole('button',{name:'Recenter map'});
 await expect(home).toContainText('Everest');await home.click();
 await expect(panel).toHaveCount(0);
 await expect(stage).toHaveAttribute('data-bearing','0.0000');
 expect(Number(await stage.getAttribute('data-tilt'))).toBeCloseTo(Math.PI/4,3);
 expect(await stage.getAttribute('data-valid-ms')).toBe(time);
 await expect(page.getByRole('button',{name:'3D map',exact:true})).toHaveAttribute('aria-pressed','true');
 const returned=await stage.evaluate((el:any)=>el.chartApi.camera());
 expect(returned.centerY).toBeCloseTo(27.9881,1);
 await expect.poll(()=>stage.evaluate((el:any)=>el.chartApi.terrain()?.painted),{timeout:30000}).toBe(true);
 await page.screenshot({path:info.outputPath('returned-to-everest.png')});
 await page.getByRole('button',{name:'2D map',exact:true}).click();
 await home.click();
 await page.getByRole('button',{name:'3D map',exact:true}).click();
 expect(Number(await stage.getAttribute('data-tilt'))).toBeCloseTo(Math.PI/4,3);
 await expect(stage).toHaveAttribute('data-bearing','0.0000');
});

test('present-day profile failure can retry without changing place or time',async({page},info)=>{
 let attempts=0;
 await page.route('https://api.open-meteo.com/**',r=>{if(!new URL(r.request().url()).searchParams.has('daily'))attempts++;return r.fulfill({status:503,body:'unavailable'});});
 await page.route('https://marine-api.open-meteo.com/**',r=>r.abort());
 await page.goto('/');const stage=page.locator('[data-api="1"]');await stage.waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await stage.evaluate((el:any)=>el.chartApi.setView(-32.4,116.5,1));
 const box=(await stage.boundingBox())!;await page.mouse.click(box.x+box.width*.45,box.y+box.height*.4);
 const panel=page.locator('[data-point-panel]');await expect(panel).toHaveAttribute('data-point-state','unavailable');
 const before=attempts,point=await panel.getAttribute('data-point-location'),time=await stage.getAttribute('data-valid-ms');
 await panel.getByRole('button',{name:'Retry',exact:true}).click();
 await expect.poll(()=>attempts).toBeGreaterThan(before);
 await expect(panel).toHaveAttribute('data-point-state','unavailable');
 expect(await panel.getAttribute('data-point-location')).toBe(point);expect(await stage.getAttribute('data-valid-ms')).toBe(time);
 expect((await panel.boundingBox())!.height).toBeLessThan(150);
 await page.screenshot({path:info.outputPath('profile-retry.png')});
 await panel.getByRole('button',{name:'Close point'}).click();await expect(panel).toHaveCount(0);
});
