import {test, expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {installChart} from './flow-fixture';

/** No wind/clock/field pixels in this oracle: read the actual pressure plate.
 * Delay contour delivery on purpose; smooth rAF or animated wind cannot mask
 * frozen isobars. The input has the production 720 × 361 grid dimensions. */
for (const viewport of [{width:1280,height:720}, {width:390,height:844}]) {
for (const speed of ['8', '256']) {
test(`global pressure motion ${viewport.width}px ${speed}min/s in 2D and 3D`, async ({page}, info) => {
  test.setTimeout(120000);
  await page.setViewportSize(viewport);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        super.onmessage = handler ? (event: MessageEvent) => {
          if (event.data?.lines) setTimeout(() => handler(event), 700);
          else if (event.data?.type === 'pressure') setTimeout(() => handler(event), 100);
          else handler(event);
        } : null;
      }
    };
  });
  await page.route('https://**/*', route => route.abort());
  await installChart(page, true, true).ready;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const stage = page.locator('[data-api="1"]');
  await expect(stage).toHaveAttribute('data-pressure-renderer', 'gpu', {timeout:60000});
  await page.getByRole('combobox', {name:'Speed',exact:true}).selectOption(speed);
  await stage.evaluate((e:any) => e.chartApi.setView(-30, 125, 32));
  const renderer = await page.locator('[data-chart-layer=webgl]').evaluate((canvas:HTMLCanvasElement)=>{
    const gl=canvas.getContext('webgl2')!,debug=gl.getExtension('WEBGL_debug_renderer_info');
    return debug?String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)):'unknown';
  });
  if (!process.env.ISOBAR_E2E_SOFTWARE) expect(renderer).not.toMatch(/SwiftShader|llvmpipe|unknown/i);
  const results = [];
  for (const mode of ['2D', '3D']) {
    if (mode === '3D') await page.getByRole('button',{name:'3D map',exact:true}).click();
    await page.waitForTimeout(800);
    const result = await stage.evaluate(async (e:any) => {
      const stamps: number[] = [], hashes: number[] = [], inks: number[] = [];
      const renderers: string[] = [];
      const until = performance.now() + 2500;
      while (performance.now() < until) {
        const shot = await e.chartApi.readPlate();
        if (!shot) throw Error('No pressure plate');
        let hash = 0, ink = 0;
        for (let i=0;i<shot.data.length;i+=4) {
          // Static land/sea + isobars only. Sampling every pixel catches
          // sub-pixel line movement instead of demanding a whole-pixel jump.
          hash = (Math.imul(hash,31) + shot.data[i]) | 0;
          if (shot.data[i] < 160 && shot.data[i+2] > shot.data[i]) ink++;
        }
        stamps.push(performance.now()); hashes.push(hash); inks.push(ink);
        renderers.push(e.dataset.pressureRenderer);
      }
      let run=0, longest=0;
      for(let i=1;i<hashes.length;i++){run=hashes[i]===hashes[i-1]?run+1:0;longest=Math.max(longest,run);}
      return {gpuFraction:renderers.filter(r=>r==='gpu').length/renderers.length, count:hashes.length, unique:new Set(hashes).size, longestFrozen:longest, minInk:Math.min(...inks), intervals:stamps.slice(1).map((s,i)=>s-stamps[i])};
    });
    results.push({mode,...result});
    expect(result.gpuFraction, `${mode} ready across forecast pairs`).toBeGreaterThan(.95);
    const intervals = result.intervals.slice().sort((a,b)=>a-b);
    expect(intervals[Math.floor(intervals.length*.95)], `${mode} actual pressure frame p95`).toBeLessThan(80);
    expect(result.count, `${mode} actual plate samples`).toBeGreaterThan(25);
    expect(result.minInk, `${mode} pressure lines present`).toBeGreaterThan(100);
    expect(result.unique/result.count, `${mode} moving plate fraction`).toBeGreaterThan(.9);
    expect(result.longestFrozen, `${mode} consecutive identical plates`).toBeLessThan(3);
    await page.screenshot({path:info.outputPath(`pressure-${mode}.png`)});
  }
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const slider=page.getByRole('slider',{name:'Forecast time'});
  await slider.focus(); await page.keyboard.press('End');
  await page.keyboard.press('Home');
  await page.mouse.move(0,0);
  await expect(stage).toHaveAttribute('data-pressure-renderer','gpu',{timeout:1500});
  await page.waitForTimeout(500);
  const held=await slider.getAttribute('aria-valuenow');
  const hash=()=>stage.evaluate(async(e:any)=>{const s=await e.chartApi.readPlate();let h=0;for(let i=0;i<s.data.length;i+=4)h=(Math.imul(h,31)+s.data[i])|0;return h;});
  const before=await hash();await page.waitForTimeout(250);
  expect(await hash(),'paused pressure plate').toBe(before);
  expect(await slider.getAttribute('aria-valuenow')).toBe(held);
  expect(errors).toEqual([]);
  const evidence=JSON.stringify({renderer,viewport,speed,results},null,2);
  writeFileSync(info.outputPath('isobar-motion.json'),evidence);
  await info.attach('isobar-motion.json',{body:evidence,contentType:'application/json'});
});

}
}
