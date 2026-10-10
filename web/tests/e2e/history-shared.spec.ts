import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';

// Uses genuine packaged archive data rather than generated weather fixtures.
test('history shares animated map controls without current weather requests', async ({ page }) => {
  test.skip(!existsSync('public/history/catalog.json'), 'Package historical assets first');
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/history?event=dday&date=1944-06-06&hour=12');
  const stage = page.locator('[data-map-ready=true]');
  await expect(stage).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => stage.evaluate((e: any) => e.chartApi.flowSample()?.drawn)).toBeGreaterThan(0);
  await expect.poll(() => stage.evaluate((e: any) => e.chartApi.flowSample()?.travel)).toBeGreaterThan(0);
  expect(new Date(Number(await stage.getAttribute('data-valid-ms'))).getUTCFullYear()).toBe(1944);
  const camera = await stage.evaluate((e: any) => e.chartApi.camera());
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => stage.evaluate((e: any) => e.chartApi.camera())).not.toEqual(camera);
  const timeline = page.getByRole('slider', { name: 'Forecast time' });
  const before = await timeline.getAttribute('aria-valuenow');
  await timeline.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(timeline).not.toHaveAttribute('aria-valuenow', before!);
  await page.getByLabel('Historical event').selectOption('cyclone-tracy');
  await expect.poll(async () => new Date(Number(await stage.getAttribute('data-valid-ms'))).getUTCFullYear()).toBe(1974);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const start = Number(await stage.getAttribute('data-valid-ms'));
  await expect.poll(async () => Number(await stage.getAttribute('data-valid-ms'))).toBeGreaterThan(start);
  expect(requests.filter(url => /api\/(traffic|forecast)|open-meteo|\/data\/(manifest|sky)\.json/.test(url))).toEqual([]);
});

test('historical daily assets switch without moving the map or resuming paused time', async ({page}) => {
  test.setTimeout(60000);
  const catalog=JSON.parse(await (await page.request.get('/history/catalog.json')).text());
  test.skip(!catalog.collections.find((c:any)=>c.id==='everest-1953')?.days.some((d:any)=>d.date==='1953-03-10'), 'Package journey days first');
  await page.goto('/history?event=everest-1953');
  const stage=page.locator('[data-map-ready=true]');await expect(stage).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await stage.evaluate((e:any)=>e.chartApi.setView(28.1,87.1,.15));
  await page.getByRole('button',{name:'3D map',exact:true}).click();
  await page.waitForTimeout(350);
  const before=await stage.evaluate((e:any)=>e.chartApi.camera());
  const day=page.getByLabel('Historical day');
  await day.selectOption('1953-03-10');
  await expect.poll(async()=>new Date(Number(await stage.getAttribute('data-valid-ms'))).toISOString().slice(0,10)).toBe('1953-03-10');
  for (const [key,value] of Object.entries(before)) expect((await stage.evaluate((e:any)=>e.chartApi.camera()))[key]).toBeCloseTo(Number(value),9);
  await expect(page.getByRole('button',{name:'Play',exact:true})).toBeVisible();
  await day.selectOption('1953-05-29');
  await expect.poll(async()=>new Date(Number(await stage.getAttribute('data-valid-ms'))).toISOString().slice(0,10)).toBe('1953-05-29');
  for (const [key,value] of Object.entries(before)) expect((await stage.evaluate((e:any)=>e.chartApi.camera()))[key]).toBeCloseTo(Number(value),9);
  await expect(page.getByRole('button',{name:'Play',exact:true})).toBeVisible();
  const unavailable=catalog.collections.find((c:any)=>c.id==='everest-1953').days.find((d:any)=>d.date==='1953-03-11').weather;
  await page.route('**'+unavailable,route=>route.abort());
  await day.selectOption('1953-03-11');
  await expect(page.getByText(/Failed to fetch|Historical weather unavailable/, {exact:false}).first()).toBeVisible();
  await expect(stage).toBeVisible();for (const [key,value] of Object.entries(before)) expect((await stage.evaluate((e:any)=>e.chartApi.camera()))[key]).toBeCloseTo(Number(value),9);
});
