import {test,expect} from '@playwright/test';
import sharp from 'sharp';
test.setTimeout(120000);
const selector='[data-map-ready=true]';
async function state(page:any){return page.locator(selector).evaluate((e:any)=>({camera:e.chartApi.camera(),time:e.dataset.validMs,slice:e.chartApi.slice(),ready:e.chartApi.sliceReady()}));}
async function open(page:any){
 await page.goto('/history?event=everest-1953&terrain=photo');
 const stage=page.locator(selector);await stage.waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await stage.evaluate((e:any)=>e.chartApi.setView(27.9881,86.925,.13));
 await page.getByRole('button',{name:'3D map',exact:true}).click();await page.waitForTimeout(350);return stage;
}
test('terrain and wind slice retains camera/time through lenses, orbit and return to full map',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewportSize({width:1280,height:720});const stage=await open(page);
 const before=await state(page),toggle=page.getByRole('button',{name:'Terrain and atmosphere slice'});
 await toggle.click();await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
 expect((await state(page)).camera).toEqual(before.camera);expect((await state(page)).time).toBe(before.time);
 const slice=(await state(page)).slice;
 await expect.poll(async()=>Number(await page.locator('[data-atmosphere-layer]').getAttribute('data-flows')),{timeout:30000}).toBeGreaterThan(3);
 await page.screenshot({path:info.outputPath('slice-laptop.png')});
 const plate=await stage.locator('[data-chart-layer=webgl]').screenshot();
 const pixels=await sharp(plate).removeAlpha().raw().toBuffer();let rock=0,sky=0;
 for(let i=0;i<pixels.length;i+=3){const r=pixels[i],g=pixels[i+1],b=pixels[i+2];if(r>85&&r<140&&g>70&&g<130&&b>50&&b<105)rock++;if(b>180&&b>r+8&&g>170)sky++;}
 expect(rock).toBeGreaterThan(500);expect(sky).toBeGreaterThan(10000);
 await page.locator('[data-lens=wind]').first().click();expect((await state(page)).slice).toEqual(slice);expect((await state(page)).camera).toEqual(before.camera);
 await stage.locator('canvas[tabindex="0"]').focus();await page.keyboard.down('ArrowRight');await page.waitForTimeout(400);await page.keyboard.up('ArrowRight');
 const rotated=(await state(page));
 expect(rotated.slice.bearingRadians).toBeCloseTo(rotated.camera.bearingRadians,6);
 expect(rotated.slice.lat).toBeCloseTo(slice.lat,8);expect(rotated.slice.lon).toBeCloseTo(slice.lon,8);
 expect(rotated.camera.bearingRadians).toBeGreaterThan(.05);
 const orbited=await state(page);await page.screenshot({path:info.outputPath('slice-orbit.png')});
 await toggle.click();await expect(stage).toHaveAttribute('data-slice','off');expect((await state(page)).camera).toEqual(orbited.camera);expect((await state(page)).time).toBe(before.time);
 await page.getByRole('button',{name:'2D map',exact:true}).click();await expect(toggle).toHaveCount(0);expect((await state(page)).slice).toBeNull();expect(errors).toEqual([]);
});
test('missing terrain leaves the full map usable and slice preparation cancellable',async({page})=>{
 await page.route('https://tiles.mapterhorn.com/**',r=>r.abort());
 const stage=await open(page),before=await state(page),toggle=page.getByRole('button',{name:'Terrain and atmosphere slice'});await toggle.click();
 await expect(stage).toHaveAttribute('data-slice','preparing');await expect(toggle).toHaveAttribute('aria-busy','true');
 await page.waitForTimeout(1000);expect((await state(page)).ready).toBe(false);
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();expect((await state(page)).camera.halfHeight).toBeLessThan(before.camera.halfHeight);
 await toggle.click();await expect(stage).toHaveAttribute('data-slice','off');expect((await state(page)).time).toBe(before.time);
});

test('present-day Perth uses the same slice with atmospheric levels retained',async({page},info)=>{
 await page.goto('/');const stage=page.locator('[data-isobars=true]');await stage.waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await stage.evaluate((e:any)=>e.chartApi.setView(-31.95,116.1,.6));
 await page.getByRole('button',{name:'3D map',exact:true}).click();await page.waitForTimeout(350);
 const before=await state(page);await page.getByRole('button',{name:'Terrain and atmosphere slice'}).click();
 await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
 await expect.poll(async()=>Number(await page.locator('[data-atmosphere-layer]').getAttribute('data-layers'))).toBeGreaterThanOrEqual(3);
 expect((await state(page)).camera).toEqual(before.camera);expect((await state(page)).time).toBe(before.time);
 await page.screenshot({path:info.outputPath('slice-perth.png')});
});


test('slice slider sweeps terrain and wind and orbit sets its bearing without changing time',async({page},info)=>{
 const stage=await open(page);await page.getByRole('button',{name:'Terrain and atmosphere slice'}).click();
 await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
 const slider=page.getByRole('slider',{name:'Slice position'}),before=await state(page);
 await slider.focus();await page.keyboard.press('End');
 await expect(slider).toHaveValue('100');await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
 const moved=await state(page);expect(moved.slice.lat).not.toBe(before.slice.lat);
 expect(moved.camera).toEqual(before.camera);expect(moved.time).toBe(before.time);
 await expect.poll(()=>stage.evaluate((e:any)=>e.chartApi.displayedSlice()?.lat)).toBe(moved.slice.lat);
 const plate=stage.locator('[data-chart-layer=webgl]'),first=await plate.screenshot();
 await slider.focus();await page.keyboard.press('Home');await expect(slider).toHaveValue('-100');
 await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
 const back=await state(page);expect(back.slice.lat).toBeLessThan(before.slice.lat);
 expect(Buffer.compare(first,await plate.screenshot())).not.toBe(0);
 const canvas=stage.locator('canvas[tabindex="0"]'),box=(await canvas.boundingBox())!;
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.wheel(70,0);await page.waitForTimeout(250);
 const rotated=await state(page);expect(rotated.slice.bearingRadians).toBeCloseTo(rotated.camera.bearingRadians,6);
 expect(rotated.slice.bearingRadians).toBeGreaterThan(.2);expect(rotated.time).toBe(before.time);
 await expect(slider).toHaveValue('-100');
 await slider.fill('0');await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
 const centred=await state(page);expect(centred.slice.lat).toBeCloseTo(before.slice.lat,8);expect(centred.slice.lon).toBeCloseTo(before.slice.lon,8);
 await page.screenshot({path:info.outputPath('slice-slider.png')});
 await page.getByRole('button',{name:'2D map',exact:true}).click();await expect(slider).toHaveCount(0);
 await page.getByRole('button',{name:'3D map',exact:true}).click();await page.getByRole('button',{name:'Terrain and atmosphere slice'}).click();await expect(slider).toHaveValue('0');
});


test('point cross-section turns and sweeps with the map and shows the approximate ascent',async({page},info)=>{
 const stage=await open(page),canvas=stage.locator('canvas[tabindex="0"]');
 const box=(await canvas.boundingBox())!;
 await page.mouse.click(box.x+box.width*.5,box.y+box.height*.6);
 const panel=page.locator('[data-point-panel]'),section=panel.locator('[data-sounding]');
 await expect(section).toBeVisible();await page.waitForTimeout(700);
 await expect.poll(async()=>Number(await section.getAttribute('data-section-route-points'))).toBeGreaterThan(5);
 const before=await section.locator('canvas').screenshot(),time=(await state(page)).time;
 const area=(await canvas.boundingBox())!;
 await page.mouse.move(area.x+area.width*.4,area.y+area.height*.5);await page.mouse.wheel(70,0);await page.waitForTimeout(250);
 await expect.poll(async()=>Number(await section.getAttribute('data-section-bearing-radians'))).toBeGreaterThan(.2);
 expect(Buffer.compare(before,await section.locator('canvas').screenshot())).not.toBe(0);
 await page.getByRole('button',{name:'Terrain and atmosphere slice'}).click();await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
 const mid=await section.getAttribute('data-section-mid');
 await page.getByRole('slider',{name:'Slice position'}).fill('65');await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
 await expect(panel).toBeVisible();await expect.poll(()=>section.getAttribute('data-section-mid')).not.toBe(mid);
 await page.mouse.move(area.x+area.width*.4,area.y+area.height*.5);await page.mouse.wheel(50,0);await page.waitForTimeout(250);
 await expect(panel).toBeVisible();expect((await state(page)).time).toBe(time);
 await page.screenshot({path:info.outputPath('rotating-section.png')});
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);
 const sweep=page.getByRole('slider',{name:'Slice position'}),bounds=(await sweep.boundingBox())!;
 expect(await sweep.evaluate((e:HTMLElement)=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e;})).toBe(true);
 await page.mouse.click(bounds.x+bounds.width*.25,bounds.y+bounds.height*.5);
 await expect.poll(()=>sweep.inputValue()).not.toBe('65');
 await expect(panel).toBeVisible();await page.screenshot({path:info.outputPath('section-phone-controls.png')});
});
