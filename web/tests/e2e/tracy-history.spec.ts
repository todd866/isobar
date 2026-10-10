import {test,expect} from '@playwright/test';

// The packaged two-day archive plus the production best-track reconstruction.
test('Tracy is visible, keeps its view through lenses and weakens through the shared clock',async({page},info)=>{
 test.setTimeout(90000);
 await page.setViewportSize({width:1280,height:720});
 const errors:string[]=[],evidence:unknown[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('isobar.speed','0'));
  await page.goto('/history?event=cyclone-tracy&date=1974-12-24&hour=17');
  const stage=page.locator('[data-map-ready=true]');await stage.waitFor({timeout:60000});
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const labels=()=>stage.evaluate((e:any)=>e.chartApi.labels());
  await expect.poll(async()=>(await labels()).some((l:any)=>/^L 950/.test(l.text)),{timeout:15000}).toBe(true);
  await expect(page.getByLabel('Historical event',{exact:true})).toHaveValue('cyclone-tracy');
  expect(new Date(Number(await stage.getAttribute('data-valid-ms'))).toISOString()).toContain('1974-12-24T17:');
  const low=(await labels()).find((l:any)=>/^L 950/.test(l.text));
  const centre=await stage.evaluate((e:any)=>e.chartApi.screen(-12.38,130.76));
  expect(Math.hypot(low.x+low.w/2-centre.x,low.y+26-centre.y)).toBeLessThan(4);
  const camera=await stage.evaluate((e:any)=>e.chartApi.camera());const time=await stage.getAttribute('data-valid-ms');
  await page.screenshot({path:info.outputPath('tracy-pressure.png')});
  await page.locator('[data-lens="wind"]').click();
  await expect(page.locator('[data-lens="wind"]')).toHaveAttribute('aria-checked','true');
  expect(await stage.evaluate((e:any)=>e.chartApi.camera())).toEqual(camera);
  expect(await stage.getAttribute('data-valid-ms')).toEqual(time);
  await expect.poll(()=>stage.evaluate((e:any)=>e.chartApi.flowSample()?.drawn)).toBeGreaterThan(0);
  await expect.poll(()=>stage.evaluate((e:any)=>e.chartApi.flowSample()?.travel)).toBeGreaterThan(0);
  const ink=()=>page.locator('canvas[data-flow-layer]').evaluate((c:HTMLCanvasElement)=>{
    const data=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;let count=0,signature=0;
    for(let i=3;i<data.length;i+=32)if(data[i]>12){count++;signature=(signature+data[i-3]+data[i-1]*3+i%997)%1000003;}
    return {count,signature};
  });
  await expect.poll(async()=>(await ink()).count).toBeGreaterThan(10);
  const first=await ink();await expect.poll(async()=>(await ink()).signature).not.toBe(first.signature);
  await page.screenshot({path:info.outputPath('tracy-wind.png')});
  evidence.push({step:'landfall',camera,time,labels:await labels()});
  await page.getByLabel('Historical day',{exact:true}).selectOption('1974-12-25');
  const slider=page.getByRole('slider',{name:'Forecast time'});await slider.focus();
  await expect.poll(async()=>new Date(Number(await stage.getAttribute('data-valid-ms'))).toISOString()).toBe('1974-12-25T00:00:00.000Z');
  await expect.poll(async()=>(await labels()).some((l:any)=>/^L 982/.test(l.text))).toBe(true);
  await page.keyboard.press('End');
  await expect.poll(async()=>new Date(Number(await stage.getAttribute('data-valid-ms'))).toISOString()).toContain('1974-12-25T23:');
  await expect.poll(async()=>(await labels()).some((l:any)=>/^L 950/.test(l.text))).toBe(false);
  expect(await stage.evaluate((e:any)=>e.chartApi.camera())).toEqual(camera);
  await page.screenshot({path:info.outputPath('tracy-decay.png')});
  evidence.push({step:'decay',camera:await stage.evaluate((e:any)=>e.chartApi.camera()),time:await stage.getAttribute('data-valid-ms'),labels:await labels()});
  await page.getByRole('link',{name:'Back to present day',exact:true}).click();
  await expect.poll(async()=>new Date(Number(await stage.getAttribute('data-valid-ms'))).getUTCFullYear()).toBeGreaterThan(2020);
  expect(errors).toEqual([]);
  await info.attach('cyclone-evidence',{body:JSON.stringify(evidence,null,2),contentType:'application/json'});
});
