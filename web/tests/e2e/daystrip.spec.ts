import {test,expect} from '@playwright/test';
import {chartRoutes} from './map-fixture';
for(const place of ['perth','sydney'])test(`${place} day tiles seek local noon and hide dry rain`,async({page})=>{
  await page.clock.setFixedTime(Date.parse('2026-10-08T01:00:00Z'));
  await page.addInitScript(place=>localStorage.setItem('isobar.place',place),place);
  await chartRoutes(page);await page.goto('/');await page.waitForSelector('[data-api="1"]');
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  const tiles=page.getByRole('list',{name:'Forecast days'}).getByRole('listitem');
  await expect(tiles).not.toHaveCount(0);
  await tiles.nth(1).click();
  const stage=page.locator('[data-api="1"]');
  const selected=await stage.evaluate((e:any)=>e.chartApi.playback().minute);
  // Fixture run is 00Z 8 Oct. 9 Oct noon: Perth 04Z, Sydney 01Z.
  expect(selected).toBe(place==='perth'?28*60:25*60);
  await tiles.first().click();
  expect(await stage.evaluate((e:any)=>e.chartApi.playback().minute)).toBe(place==='perth'?4*60:60);
  await expect(page.locator('.day-rain:visible')).toHaveCount(0);
});
