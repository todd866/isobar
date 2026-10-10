import {test,expect} from '@playwright/test';
test('Katrina uses the shared map and both prepared days offline',async({page,context})=>{
 test.setTimeout(90_000);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/history?event=katrina-2005');
 const stage=page.locator('[data-map-ready=true]');await stage.waitFor();
 await page.getByRole('button',{name:'Pause',exact:true}).click();
 await expect(page.getByLabel('Historical day',{exact:true})).toHaveValue('2005-08-29');
 const camera=await stage.evaluate((e:any)=>e.chartApi.camera());expect(camera.halfHeight).toBeCloseTo(3.2);
 await page.getByRole('button',{name:'Data sources',exact:true}).click();
 await expect(page.getByRole('link',{name:'Best track',exact:true})).toHaveAttribute('href','https://www.nhc.noaa.gov/data/tcr/AL122005_Katrina.pdf');
 await expect(page.locator('.map-sources')).toContainText('55 km');
 await page.getByLabel('Routes',{exact:true}).uncheck();await page.getByLabel('Routes',{exact:true}).check();
 await page.getByRole('button',{name:'Data sources',exact:true}).click();
 await context.setOffline(true);
 for(const date of ['2005-08-28','2005-08-29']){
  await page.getByLabel('Historical day',{exact:true}).selectOption(date);
  await expect(page.getByLabel('Historical day',{exact:true})).toHaveValue(date);
  await expect(stage).toHaveAttribute('data-map-ready','true');
 }
 await page.getByRole('button',{name:'3D map',exact:true}).click();await expect(stage).toHaveAttribute('data-map-mode','3d');
 await page.getByRole('button',{name:'2D map',exact:true}).click();await expect(stage).toHaveAttribute('data-map-mode','2d');
 expect(errors).toEqual([]);
});
