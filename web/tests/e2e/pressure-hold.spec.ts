import {test, expect} from '@playwright/test';
import {installChart} from './flow-fixture';
test('a pending scrub retains the last GPU pressure picture',async({page})=>{
  test.setTimeout(90000);
  await page.addInitScript(()=>{
    const NativeWorker=window.Worker;
    window.Worker=class extends NativeWorker {
      set onmessage(handler:((e:MessageEvent)=>void)|null){super.onmessage=handler?(event:MessageEvent)=>{if(event.data?.type==='pressure')setTimeout(()=>handler(event),2000);else handler(event);}:null;}
    };
  });
  await page.route('https://**/*',r=>r.abort());
  await installChart(page,true,true).ready;
  await page.goto('/');
  const stage=page.locator('[data-api="1"]');
  await expect(stage).toHaveAttribute('data-pressure-renderer','gpu',{timeout:60000});
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const hash=()=>stage.evaluate(async(e:any)=>{const s=await e.chartApi.readPlate();let h=0;for(let i=0;i<s.data.length;i+=16)h=(Math.imul(h,31)+s.data[i])|0;return h;});
  const before=await hash();
  const slider=page.getByRole('slider',{name:'Forecast time'});
  await slider.focus();await page.keyboard.press('End');
  await page.waitForTimeout(150);
  await expect(stage).toHaveAttribute('data-pressure-renderer','gpu');
  expect(await hash()).toBe(before);
  await expect.poll(hash,{timeout:6000}).not.toBe(before);
});
