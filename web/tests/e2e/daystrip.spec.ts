import {test,expect} from '@playwright/test';
import {chartRoutes} from './map-fixture';
for(const place of ['perth','sydney'])test(`${place} day segments seek continuously and omit dry rain`,async({page})=>{
  await page.clock.setFixedTime(Date.parse('2026-10-08T01:00:00Z'));
  await page.addInitScript(place=>localStorage.setItem('isobar.place',place),place);
  await chartRoutes(page);await page.goto('/');await page.waitForSelector('[data-api="1"]');
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const days=page.locator('.forecast-day');
  await expect(days).not.toHaveCount(0);
  // Clicking at different positions within one day must choose different hours.
  const day=(await days.nth(1).boundingBox())!;
  const stage=page.locator('[data-api="1"]');
  await page.mouse.click(day.x+day.width*.25,day.y+day.height/2);
  const early=await stage.evaluate((e:any)=>e.chartApi.playback().minute);
  await page.mouse.click(day.x+day.width*.75,day.y+day.height/2);
  const late=await stage.evaluate((e:any)=>e.chartApi.playback().minute);
  expect(late-early).toBeCloseTo(12*60,0);
  await expect(page.locator('.day-rain:visible')).toHaveCount(0);
  await expect(page.locator('.day-range')).toHaveCount(0);
});
