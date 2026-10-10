import {test,expect,type Page} from '@playwright/test';
const map=(page:Page)=>page.locator('[data-api="1"]');
const camera=(page:Page)=>map(page).evaluate((e:any)=>e.chartApi.camera());
async function open(page:Page){
 await page.goto('/history?event=everest-1953');await map(page).waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await map(page).evaluate((e:any)=>e.chartApi.setView(27.9881,86.925,.13));
 await page.getByRole('button',{name:'3D map',exact:true}).click();
}
test.setTimeout(120000);
test('cancel a preparing slice, recenter and return to 2D before terrain arrives',async({page},info)=>{
 let requested=0,released=0;let release!:()=>void;
 const barrier=new Promise<void>(resolve=>{release=resolve;});
 await page.route('https://tiles.mapterhorn.com/**',async route=>{requested++;await barrier;released++;await route.continue().catch(()=>{});});
 try{
  await open(page);await page.getByRole('button',{name:'Terrain and atmosphere slice'}).click();
  await expect(map(page)).toHaveAttribute('data-slice','preparing');
  await page.getByRole('slider',{name:'Slice position'}).fill('80');
  await page.setViewportSize({width:844,height:390});
  await page.getByRole('button',{name:'Recenter map'}).click();
  await page.getByRole('button',{name:'2D map',exact:true}).click();
  const recovered=await camera(page),time=await map(page).getAttribute('data-valid-ms');
  expect(requested).toBeGreaterThan(0);release();
  await expect.poll(()=>released).toBeGreaterThan(0);await page.waitForTimeout(1500);
  await expect(map(page)).toHaveAttribute('data-slice','off');
  await expect(page.getByRole('slider',{name:'Slice position'})).toHaveCount(0);
  expect(await camera(page)).toEqual(recovered);expect(await map(page).getAttribute('data-valid-ms')).toBe(time);
  await expect(page.getByRole('button',{name:'2D map',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:info.outputPath('late-terrain-after-cancel.png')});
 }finally{release();}
});
test('holding a movement key then focusing another control cannot leave the camera drifting',async({page},info)=>{
 await open(page);const canvas=map(page).locator('canvas[tabindex="0"]');
 await canvas.focus();const start=await camera(page);await page.keyboard.down('w');
 try{
  await expect.poll(()=>camera(page)).not.toEqual(start);
  await page.getByRole('slider',{name:'Forecast time'}).focus();
  await page.waitForTimeout(100);const stopped=await camera(page);
  await page.waitForTimeout(650);expect(await camera(page)).toEqual(stopped);
 }finally{await page.keyboard.up('w');}
 await canvas.focus();await page.keyboard.down('ArrowRight');
 try{
  await page.waitForTimeout(100);await page.getByRole('button',{name:'Recenter map'}).click();
  const recovered=await camera(page);await page.waitForTimeout(650);
  expect(await camera(page)).toEqual(recovered);expect(recovered.bearingRadians).toBe(0);
 }finally{await page.keyboard.up('ArrowRight');}
 await page.screenshot({path:info.outputPath('keyboard-recovery.png')});
});
test('rapid historical day reversal while playing keeps the last requested day and chosen view',async({page},info)=>{
 await open(page);const before=await camera(page),day=page.getByLabel('Historical day');
 const catalog=await (await page.request.get('/history/catalog.json')).json();
 const path=catalog.collections.find((c:any)=>c.id==='everest-1953').days.find((d:any)=>d.date==='1953-03-10').weather;
 let requested=0,completed=0,release!:()=>void;
 const heldResponse=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**'+path,async route=>{requested++;await heldResponse;await route.continue().catch(()=>{});completed++;});
 try{
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await day.selectOption('1953-03-10');await expect.poll(()=>requested).toBeGreaterThan(0);
  await day.selectOption('1953-05-29');release();
  await expect.poll(()=>completed).toBeGreaterThan(0);await page.waitForTimeout(1000);
  await expect(day).toHaveValue('1953-05-29');
  expect(new Date(Number(await map(page).getAttribute('data-valid-ms'))).toISOString().slice(0,10)).toBe('1953-05-29');
  await page.getByRole('button',{name:'Pause',exact:true}).click();await page.waitForTimeout(500);
  expect(await camera(page)).toEqual(before);
  const held=await map(page).getAttribute('data-valid-ms');await page.waitForTimeout(400);
  expect(await map(page).getAttribute('data-valid-ms')).toBe(held);
  await expect.poll(async()=>Number(await page.locator('[data-atmosphere-layer]').getAttribute('data-flows')),{timeout:20000}).toBeGreaterThan(0);
  await page.screenshot({path:info.outputPath('historical-day-reversal.png')});
 }finally{release();}
});
