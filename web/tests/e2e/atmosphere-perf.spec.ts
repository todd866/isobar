import {test, expect} from '@playwright/test';

test('regional 3D drag with atmospheric vectors stays at 60 fps', async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/');
  const stage=page.locator('[data-api="1"]'); await expect(stage).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  // Select the destination before entering 3D: the teaching field stays
  // anchored there when the user subsequently pans.
  await stage.evaluate((el:any)=>el.chartApi.setView(-31.9,115.8,2));
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  await expect.poll(async()=>Number(await page.locator('[data-atmosphere-layer]').getAttribute('data-flows'))).toBeGreaterThan(5);
  await page.waitForTimeout(1000);
  const box=(await stage.boundingBox())!;
  const x=box.x+box.width*.4,y=box.y+box.height*.6;
  await page.mouse.move(x,y); await page.mouse.down(); await page.waitForTimeout(200);
  const measure=page.evaluate(()=>new Promise<{p95:number;longTasks:number[]}>((resolve)=>{
    const frames:number[]=[],longTasks:number[]=[];
    const observer=new PerformanceObserver(list=>list.getEntries().forEach(entry=>longTasks.push(entry.duration)));
    observer.observe({type:'longtask'});
    let last=performance.now(),start=last;
    function frame(t:number){frames.push(t-last);last=t;if(t-start<3500)requestAnimationFrame(frame);else{observer.disconnect();frames.shift();frames.sort((a,b)=>a-b);resolve({p95:frames[Math.floor(frames.length*.95)],longTasks});}}
    requestAnimationFrame(frame);
  }));
  try {
    await page.mouse.move(x+box.width*.3,y,{steps:80});
    await page.mouse.move(x,y,{steps:80});
    const result=await measure;
    console.log('3D atmosphere pan',JSON.stringify(result));
    expect(Math.round(result.p95*10)/10).toBeLessThanOrEqual(16.8);
    expect(result.longTasks.filter(t=>t>50)).toEqual([]);
  }finally{await page.mouse.up();}
});

// Close teaching fields are a different workload from the regional vector map.
// Keep these in the isolated frame-time project so the normal release suite
// exercises the expensive models, both cloud states and continuous orbit.
for(const [device,width,height] of [['laptop',1280,800],['phone',390,844]] as const)
test(`close teaching atmosphere remains smooth while orbiting (${device})`,async({page},info)=>{
  test.setTimeout(180000);
  await page.setViewportSize({width,height});await page.goto('/');
  const stage=page.locator('[data-api="1"]');await expect(stage).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await stage.evaluate((e:any)=>e.chartApi.setView(-31.95,115.86,.12));
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  const measure=()=>page.evaluate(()=>new Promise<{p95:number;max:number;longTasks:number[]}>((resolve)=>{
    const frames:number[]=[],longTasks:number[]=[];
    const observer=new PerformanceObserver(list=>list.getEntries().forEach(e=>longTasks.push(e.duration)));
    observer.observe({type:'longtask'});let last=performance.now(),start=last;
    function tick(t:number){frames.push(t-last);last=t;if(t-start<1800)requestAnimationFrame(tick);else{
      observer.disconnect();frames.shift();frames.sort((a,b)=>a-b);
      resolve({p95:frames[Math.floor(frames.length*.95)],max:frames.at(-1)!,longTasks});
    }}requestAnimationFrame(tick);
  }));
  const results=[];
  try {
    for(const model of ['sea-breeze','thunderstorm','mountain-wave'])for(const clouds of [false,true]){
      await page.getByRole('button',{name:'Atmospheric section',exact:true}).click();
      await page.getByRole('combobox',{name:'Atmosphere model',exact:true}).selectOption(model);
      await page.getByRole('checkbox',{name:'Clouds',exact:true}).setChecked(clouds);
      await page.getByRole('button',{name:'Frame atmosphere',exact:true}).click();
      await page.getByRole('button',{name:'Close atmospheric section',exact:true}).click();
      const layer=page.locator('[data-atmosphere-layer]');
      await expect(layer).toHaveAttribute('data-rendered-scenario',model,{timeout:15000});
      await expect(layer).toHaveAttribute('data-clouds',clouds?'on':'off',{timeout:15000});
      await page.waitForTimeout(600);
      const idle=await measure();await stage.locator('canvas[tabindex="0"]').focus();
      const before=await stage.evaluate((e:any)=>e.chartApi.camera().bearingRadians);
      await page.keyboard.down('ArrowRight');let orbit;
      try{orbit=await measure();}finally{await page.keyboard.up('ArrowRight');}
      expect(await stage.evaluate((e:any)=>e.chartApi.camera().bearingRadians)).not.toBe(before);
      const row={model,clouds,buildMs:await layer.getAttribute('data-build-ms'),idle,orbit};results.push(row);
      for(const mode of [idle,orbit])expect(Math.round(mode.p95*10)/10,JSON.stringify(row)).toBeLessThanOrEqual(16.8);
    }
  }finally{
    await page.keyboard.up('ArrowRight');
    await info.attach('close atmosphere frame times',{body:JSON.stringify(results),contentType:'application/json'});
  }
});
