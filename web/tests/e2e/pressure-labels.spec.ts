import {test, expect} from '@playwright/test';
import {installChart} from './flow-fixture';
for(const speed of ['8','256']) test(`pressure labels track each frame at ${speed} min/s`, async({page},info)=>{
  test.setTimeout(90000);
  await page.route('https://**/*',r=>r.abort());
  await installChart(page,true,true).ready;
  await page.goto('/');
  const stage=page.locator('[data-api="1"]');
  await expect(stage).toHaveAttribute('data-pressure-renderer','gpu',{timeout:60000});
  await stage.evaluate((e:any)=>e.chartApi.setView(-30,125,32));
  await page.getByRole('combobox',{name:'Speed',exact:true}).selectOption(speed);
  await page.waitForTimeout(1000);
  const result=await stage.evaluate(async(e:any)=>{
    let previous=new Map<string,any>(),frames=0,moving=0,max=0,visible=0,steady=0,changing=0;
    const until=performance.now()+2500;
    while(performance.now()<until){
      await new Promise(requestAnimationFrame);
      const labels=e.chartApi.labels().filter((l:any)=>l.kind==='isobar');
      let moved=false, stable=false, changed=false;
      if(labels.length)visible++;
      for(const l of labels){const p=previous.get(l.key);if(p){stable=true;changed ||= Math.abs(l.alpha-p.alpha)>.001;const d=Math.hypot(l.x-p.x,l.y-p.y);max=Math.max(max,d);moved ||= d>.001;}}
      previous=new Map(labels.map((l:any)=>[l.key,l]));frames++;if(stable)steady++;if(moved)moving++;if(moved||changed)changing++;
    }
    return{frames,moving,max,visible,steady,changing,labels:previous.size};
  });
  await info.attach('label-motion.json',{body:JSON.stringify(result),contentType:'application/json'});
  expect(result.labels).toBeGreaterThan(0);
  expect(result.visible/result.frames).toBeGreaterThan(.5);
  expect(result.steady).toBeGreaterThan(0);
  expect(result.moving).toBeGreaterThan(0);
  expect(result.changing/result.steady).toBeGreaterThan(.5);
  expect(result.max).toBeLessThanOrEqual(3.01);
});
