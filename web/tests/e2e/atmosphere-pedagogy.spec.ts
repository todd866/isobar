import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// These are evidence sequences, not a claim that pixel counts prove comprehension.
// The numerical oracles live in atmosphere-pedagogy.test.ts; review the actual
// frames against docs/design/atmospheric-acceptance.md before release.
for (const phone of [false, true]) test(`atmospheric teaching sequence: ${phone ? 'phone' : 'laptop'}`, async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.setViewportSize(phone ? { width: 390, height: 844 } : { width: 1280, height: 720 });
  await page.addInitScript(() => localStorage.setItem('isobar.place','perth'));
  await page.goto('/');
  const stage = page.locator('[data-api="1"]');
  await expect(stage).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await stage.evaluate((e: any) => e.chartApi.setView(-31.95, 115.86, .18));
  await page.getByRole('button', { name: '3D map', exact: true }).click();
  const flow = page.locator('[data-atmosphere-layer]');
  await expect.poll(async () => Number(await flow.getAttribute('data-flows'))).toBeGreaterThan(10);
  await expect.poll(async () => Number(await flow.getAttribute('data-layers'))).toBeGreaterThanOrEqual(3);
  const timeline = page.getByRole('slider', {name:'Forecast time'});
  await timeline.focus();await page.keyboard.press('Home');
  const time = await stage.getAttribute('data-valid-ms');
  const fieldTime = await flow.getAttribute('data-field-time');
  const profileTime = await flow.getAttribute('data-profile-time');
  expect(Number(profileTime)).toBe(Number(time));
  const evidence: unknown[] = [];
  const paintedMotion = async () => flow.evaluate((canvas: HTMLCanvasElement & {previousPixels?:Uint8ClampedArray}) => {
    const pixels=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
    let painted=0,changed=0;const rows=new Set<number>();
    for(let i=0;i<pixels.length;i+=4) {
      if(pixels[i+3]>20){painted++;rows.add(Math.floor(i/4/canvas.width));}
      if(canvas.previousPixels && Math.abs(pixels[i+3]-canvas.previousPixels[i+3])>10)changed++;
    }
    canvas.previousPixels=pixels;
    return {painted,changed,rowSpan:rows.size?Math.max(...rows)-Math.min(...rows):0,height:canvas.height};
  });
  for (const [name, horizontal, vertical] of [['initial', 0, 0], ['tilted', 0, 100], ['orbit', 110, 0], ['reverse', -110, -100]] as const) {
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .45);
    if (horizontal || vertical) await page.mouse.wheel(horizontal, vertical);
    await page.waitForTimeout(300);
    await expect(stage).toHaveAttribute('data-valid-ms', time!);
    await expect(flow).toHaveAttribute('data-field-time', fieldTime!);
    await page.screenshot({ path: info.outputPath(`${name}.png`) });
    evidence.push({ name, camera: await stage.evaluate((e: any) => e.chartApi.camera()),
      flows: await flow.getAttribute('data-flows'), layers: await flow.getAttribute('data-layers'), time, fieldTime });
  }
  await page.getByRole('button', {name:'Terrain and atmosphere slice',exact:true}).click();
  await expect(stage).toHaveAttribute('data-slice','ready',{timeout:45000});
  await expect.poll(async()=>Number(await flow.getAttribute('data-flows'))).toBeGreaterThan(0);
  await expect(flow).toBeVisible();
  await expect.poll(async()=>await flow.getAttribute('data-rendered-slice')).toBe(await flow.getAttribute('data-slice-key'));
  const firstPaint=await paintedMotion();expect(firstPaint.painted).toBeGreaterThan(100);
  for (let frame=0;frame<4;frame++) {
    await page.waitForTimeout(250);
    const paint=await paintedMotion();
    await writeFile(info.outputPath(`motion-${frame}.json`),JSON.stringify({paint,data:await flow.evaluate(e=>({...((e as HTMLElement).dataset)})),camera:await stage.evaluate((e:any)=>e.chartApi.camera())},null,2));
    await page.screenshot({path:info.outputPath(`slice-motion-${frame}.png`)});
    expect(paint.painted).toBeGreaterThan(100);expect(paint.changed).toBeGreaterThan(50);
    expect(paint.rowSpan).toBeGreaterThan(paint.height*.15);
    await expect(stage).toHaveAttribute('data-valid-ms',time!);
    evidence.push({name:`slice-motion-${frame}`,paint});
    await page.screenshot({path:info.outputPath(`slice-motion-${frame}.png`)});
  }
  await page.getByRole('slider',{name:'Slice position',exact:true}).fill('35');
  await page.screenshot({path:info.outputPath('slice-offset.png')});
  await page.getByRole('button', {name:'Terrain and atmosphere slice',exact:true}).click();
  await page.getByRole('button', { name: 'Atmospheric section', exact: true }).click();
  await expect(page.locator('[data-atmosphere-section]')).toBeVisible();
  await page.screenshot({ path: info.outputPath('section.png') });
  await page.keyboard.press('Escape');
  await timeline.focus(); await page.keyboard.press('End');
  await expect(stage).not.toHaveAttribute('data-valid-ms', time!);
  await expect(flow).not.toHaveAttribute('data-field-time', fieldTime!);
  expect(Number(await flow.getAttribute('data-profile-time'))).toBe(Number(await stage.getAttribute('data-valid-ms')));
  await page.getByRole('button', { name: '2D map', exact: true }).click();
  await expect(flow).toHaveCount(0);
  const path = info.outputPath('pedagogy-evidence.json');
  await writeFile(path, JSON.stringify({ checks: 'time coherence, actual controls, renderer availability', visualAssessment: 'requires review; not certified by this test', evidence }, null, 2));
  await info.attach('pedagogy evidence', { path, contentType: 'application/json' });
});
