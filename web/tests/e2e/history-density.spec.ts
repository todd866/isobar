import {test,expect} from '@playwright/test';

test('history keeps dated navigation compact and only offers usable lenses',async({page})=>{
  await page.setViewportSize({width:1280,height:720});
  await page.goto('/history?event=everest-1953');
  const map=page.locator('[data-map-ready=true]');await map.waitFor();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect(page.getByRole('radio',{name:'Kite',exact:true})).toHaveCount(0);
  await expect(page.getByRole('radio',{name:'Surf',exact:true})).toHaveCount(0);
  await expect(page.getByRole('radio',{name:'Fly',exact:true})).toHaveCount(0);
  await page.getByLabel('Historical day',{exact:true}).selectOption('1953-05-28');
  await expect(map).toHaveAttribute('data-valid-ms',String(Date.parse('1953-05-28T00:00:00Z')));
  const box=await map.boundingBox();expect(box!.height).toBeGreaterThan(720*.7);
  await page.getByRole('radio',{name:'Wind',exact:true}).click();
  await expect(page.getByRole('radio',{name:'Wind',exact:true})).toHaveAttribute('aria-checked','true');
  await page.getByRole('link',{name:'Present day',exact:true}).click();
  await expect(page.getByRole('radio',{name:'Kite',exact:true})).toBeVisible();
});
