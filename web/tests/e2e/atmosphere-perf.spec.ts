import {test, expect} from '@playwright/test';

test('regional 3D drag with atmospheric vectors stays at 60 fps', async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/');
  const stage=page.locator('[data-api="1"]'); await expect(stage).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  // Keep the same geographic extent that exposed the deployed regression.
  await stage.evaluate((el:any)=>el.chartApi.setView(-31.9,115.8,2));
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
