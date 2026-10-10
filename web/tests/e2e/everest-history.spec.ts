import {test,expect} from '@playwright/test';
test.setTimeout(90_000);
test('Everest uses shared transport, collision-free labels and continuous camera gestures',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewportSize({width:1280,height:720});
  await page.goto('/history?event=everest-1953');
  const stage=page.locator('[data-map-ready=true]');await stage.waitFor();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const state=()=>stage.evaluate((e:any)=>({camera:e.chartApi.camera(),labels:e.chartApi.labels(),terrain:e.chartApi.terrain(),geometry:e.chartApi.tiltGeometry()}));
  await expect.poll(async()=>(await state()).terrain?.painted,{timeout:30_000}).toBeTruthy();
  expect(new Date(Number(await stage.getAttribute('data-valid-ms'))).toISOString().slice(0,10)).toBe('1953-05-29');
  const before=(await state()).camera;
  await page.getByRole('combobox',{name:'Historical day',exact:true}).selectOption('1953-05-28');
  expect((await state()).camera).toEqual(before);
  expect(new Date(Number(await stage.getAttribute('data-valid-ms'))).toISOString().slice(0,10)).toBe('1953-05-28');
  const box=(await stage.boundingBox())!;
  await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);
  await page.keyboard.down('Control');for(let i=0;i<3;i++){await page.mouse.wheel(0,-35);await page.waitForTimeout(80);}await page.keyboard.up('Control');
  expect((await state()).camera.halfHeight).toBeLessThan(before.halfHeight);
  const tilt=Number(await stage.getAttribute('data-tilt'));
  for(let i=0;i<3;i++){await page.mouse.wheel(0,35);await page.waitForTimeout(100);}
  expect(Number(await stage.getAttribute('data-tilt'))).toBeGreaterThan(tilt);
  await page.waitForTimeout(2000);await page.screenshot({path:info.outputPath('close-tilted.png')});
  for(let i=0;i<3;i++){await page.mouse.wheel(0,-35);await page.waitForTimeout(100);}
  await page.setViewportSize({width:844,height:390});await page.waitForTimeout(3000);
  const s=await state();expect(s.geometry.cameraPositionM[2]).toBeGreaterThan(8849);
  for(let i=0;i<s.labels.length;i++)for(let j=i+1;j<s.labels.length;j++){
    const a=s.labels[i],b=s.labels[j];expect(a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h,`${a.text} overlaps ${b.text}`).toBe(false);
  }
  await page.screenshot({path:info.outputPath('landscape-reversed.png')});
  await page.getByRole('button',{name:'2D map',exact:true}).click();await expect(stage).toHaveAttribute('data-map-mode','2d');expect((await state()).geometry).toBeNull();
  expect(errors).toEqual([]);
});

test('mountain handoff keeps screen scale and pitch; cutaway restores; missing fine tiles keep measured relief',async({page},info)=>{
  await page.setViewportSize({width:1280,height:720});
  await page.route('https://tiles.mapterhorn.com/11/**',route=>route.fulfill({status:404,body:''}));
  await page.goto('/history?event=everest-1953');
  const stage=page.locator('[data-map-ready=true]');await stage.waitFor();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const state=()=>stage.evaluate((e:any)=>({camera:e.chartApi.camera(),tilt:e.chartApi.tilt(),terrain:e.chartApi.terrain(),cutaway:e.chartApi.cutaway()}));
  await expect.poll(async()=>(await state()).terrain?.painted,{timeout:30_000}).toBeTruthy();
  expect((await state()).terrain.missing).toBeGreaterThan(0);
  expect((await state()).terrain.covered).toBeGreaterThan(0);
  expect((await state()).terrain.cached).toBeLessThanOrEqual(64);
  for(let i=0;i<6;i++)await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await expect.poll(async()=>(await state()).terrain?.painted,{timeout:30_000}).toBeTruthy();
  const before=await state();expect(before.tilt).toBeGreaterThan(Math.PI/4);
  await page.getByRole('button',{name:'Atmospheric section',exact:true}).click();
  await page.getByRole('slider',{name:'Reference aircraft altitude'}).fill('38000');
  await expect.poll(async()=>(await state()).cutaway).toBe(1);
  await page.screenshot({path:info.outputPath('cutaway.png')});
  await page.keyboard.press('Escape');await expect.poll(async()=>(await state()).cutaway).toBe(0);
  await page.getByRole('link',{name:'Present day',exact:true}).click();
  await page.waitForURL(url=>url.pathname==='/');await stage.waitFor();
  await expect.poll(async()=>(await state()).terrain?.covered,{timeout:30_000}).toBeGreaterThan(0);
  const current=await state();
  expect(current.camera.centerX).toBeCloseTo(before.camera.centerX,6);expect(current.camera.centerY).toBeCloseTo(before.camera.centerY,6);
  expect(current.camera.halfWidth).toBeCloseTo(before.camera.halfWidth,6);expect(current.tilt).toBeCloseTo(before.tilt,6);
  await page.getByRole('button',{name:'Menu',exact:true}).click();await page.getByRole('link',{name:'Historical',exact:true}).click();
  await page.waitForURL(url=>url.pathname==='/history');await stage.waitFor();
  await expect(page.getByRole('combobox',{name:'Historical event'})).toHaveValue('everest-1953');
  const back=await state();expect(back.camera.centerY).toBeCloseTo(before.camera.centerY,6);expect(back.camera.halfWidth).toBeCloseTo(before.camera.halfWidth,6);expect(back.tilt).toBeCloseTo(before.tilt,6);
  await page.screenshot({path:info.outputPath('roundtrip.png')});
});

test('selected mountain pin stays framed through zoom and survives both data modes',async({page})=>{
  await page.setViewportSize({width:1280,height:720});
  await page.goto('/history?event=everest-1953');
  const stage=page.locator('[data-map-ready=true]');await stage.waitFor();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect.poll(()=>stage.evaluate((e:any)=>e.chartApi.terrain()?.painted),{timeout:30_000}).toBeTruthy();
  const box=(await stage.boundingBox())!;await page.mouse.click(box.x+box.width*.52,box.y+box.height*.48);
  const pin=page.locator('[data-point-marker]');await expect(pin).toBeVisible();await page.waitForTimeout(500);
  const lat=await pin.getAttribute('data-lat'),lon=await pin.getAttribute('data-lon');
  const before=(await pin.boundingBox())!;
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await page.waitForTimeout(800);const after=(await pin.boundingBox())!;
  expect(Math.abs(after.x-before.x)).toBeLessThan(4);expect(Math.abs(after.y-before.y)).toBeLessThan(4);
  await stage.locator('canvas[tabindex="0"]').focus();
  await page.keyboard.down('ArrowRight');await page.waitForTimeout(500);await page.keyboard.up('ArrowRight');
  const orbited=(await pin.boundingBox())!;expect(Math.abs(orbited.x-after.x)).toBeLessThan(4);expect(Math.abs(orbited.y-after.y)).toBeLessThan(4);
  const bearing=Number(await stage.getAttribute('data-bearing'));expect(bearing).toBeGreaterThan(.2);
  await page.getByRole('link',{name:'Present day',exact:true}).click();await page.waitForURL(url=>url.pathname==='/');
  await stage.waitFor();expect(Number(await stage.getAttribute('data-bearing'))).toBeCloseTo(bearing,3);
  await expect(pin).toHaveAttribute('data-lat',lat!);await expect(pin).toHaveAttribute('data-lon',lon!);
  await page.getByRole('button',{name:'Show daily forecast',exact:true}).click();
  await page.getByRole('button',{name:'Menu',exact:true}).click();
  const history=page.getByRole('link',{name:'Historical',exact:true});await history.focus();await page.keyboard.press('Enter');
  await page.waitForURL(url=>url.pathname==='/history');await stage.waitFor();expect(Number(await stage.getAttribute('data-bearing'))).toBeCloseTo(bearing,3);await expect(pin).toHaveAttribute('data-lat',lat!);await expect(pin).toHaveAttribute('data-lon',lon!);
});
