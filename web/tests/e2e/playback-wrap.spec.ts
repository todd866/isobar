import {test, expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {installChart} from './flow-fixture';

test('256 min/s holds the endpoint then cross-dissolves with both label sets resident', async ({page}, info) => {
  test.setTimeout(90000);
  await page.route('https://**/*', route => route.abort());
  await installChart(page, true, true).ready;
  await page.goto('/');
  const stage = page.locator('[data-api="1"]');
  await expect(stage).toHaveAttribute('data-pressure-renderer', 'gpu', {timeout:60000});
  await page.getByRole('button', {name:'Pause', exact:true}).click();
  await page.getByRole('combobox', {name:'Speed', exact:true}).selectOption('256');
  const slider = page.getByRole('slider', {name:'Forecast time'});
  await slider.focus(); await page.keyboard.press('End');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(2000);
  await page.screenshot({path:info.outputPath('wrap-endpoint.png')});
  await page.evaluate(() => {
    const samples: unknown[] = []; (window as any).__wrap = samples;
    const start = performance.now();
    function sample(t:number) {
      const stage = document.querySelector<HTMLElement>('[data-api="1"]')!;
      const fade = stage.querySelector<HTMLCanvasElement>('[data-loop-dissolve]');
      samples.push({t, minute:(stage as any).chartApi.playback().minute, phase:stage.dataset.loopPhase, opacity:Number(fade?.style.opacity ?? 0), gpu:stage.dataset.pressureRenderer,
        labels:(stage as any).chartApi.labels().length});
      if(t-start < 2500) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await page.getByRole('button', {name:'Play', exact:true}).click();
  // Screenshot readback can stall rAF under load; keep it outside timing samples.
  await page.waitForTimeout(2700);
  await page.screenshot({path:info.outputPath('wrap-now.png')});
  const samples = await page.evaluate(() => (window as any).__wrap);
  writeFileSync(info.outputPath('wrap-samples.json'), JSON.stringify(samples));
  await info.attach('wrap-samples.json',{body:JSON.stringify(samples),contentType:'application/json'});
  const dissolve = samples.filter((s:any) => s.phase === 'dissolve');
  expect(dissolve.length).toBeGreaterThan(3);
  expect(dissolve.some((s:any) => s.opacity > .7)).toBe(true);
  expect(dissolve.some((s:any) => s.opacity < .3)).toBe(true);
  expect(dissolve.every((s:any) => s.gpu === 'gpu' && s.labels > 0)).toBe(true);
  for(let i=1;i<dissolve.length;i++) expect(dissolve[i].opacity).toBeLessThanOrEqual(dissolve[i-1].opacity);
  const holding=samples.filter((s:any) => s.phase==='hold');
  expect(holding.length).toBeGreaterThan(1);
  expect(dissolve.at(-1).t-dissolve[0].t).toBeGreaterThan(450);
  expect(dissolve.at(-1).t-dissolve[0].t).toBeLessThan(800);
  const drops = samples.slice(1).filter((s:any,i:number)=>s.minute < samples[i].minute-1);
  expect(drops).toHaveLength(1);
  expect(drops[0].phase).toBe('dissolve');
  // A separate frozen midpoint provides reviewable pixels without perturbing
  // the measured transition above.
  await page.getByRole('button', {name:'Pause', exact:true}).click();
  await slider.focus(); await page.keyboard.press('End');
  await page.mouse.move(0,0); await page.waitForTimeout(500);
  await page.getByRole('button', {name:'Play', exact:true}).click();
  await page.waitForTimeout(450);
  await page.getByRole('button', {name:'Pause', exact:true}).click();
  await page.screenshot({path:info.outputPath('wrap-middle.png')});
});
