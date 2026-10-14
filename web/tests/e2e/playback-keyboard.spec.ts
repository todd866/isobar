import {test,expect} from '@playwright/test';
import {installChart} from './flow-fixture';
test('Space toggles playback once and leaves editing and modified keys alone',async({page})=>{
  await page.route('https://**/*',r=>r.abort());await installChart(page).ready;
  await page.goto('/');await page.waitForSelector('[data-api="1"]');
  await page.locator('canvas[tabindex="0"]').focus();
  await page.keyboard.press('Space');await expect(page.getByRole('button',{name:'Play',exact:true})).toBeVisible();
  await page.keyboard.down('Space');await page.keyboard.down('Space');await page.keyboard.up('Space');
  await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  for(const modifier of ['Shift','Control','Alt','Meta']) {await page.keyboard.press(`${modifier}+Space`);await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();}
  for(const tag of ['input','textarea','div']) {
    await page.evaluate(tag=>{const el=document.createElement(tag);el.id='editing-probe';if(tag==='div')el.contentEditable='true';document.body.append(el);el.focus();},tag);
    await page.keyboard.press('Space');await expect(page.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
    await page.locator('#editing-probe').evaluate(el=>el.remove());
  }
  await page.getByRole('button',{name:'Pause',exact:true}).focus();
  await page.keyboard.press('Space');await expect(page.getByRole('button',{name:'Play',exact:true})).toBeVisible();
});

for (const control of ['Menu', 'Zoom in', 'forecast tile', 'panel button']) test(`Space activates ${control} without toggling playback`, async ({page}) => {
  await page.route('https://**/*', r => r.abort());
  await installChart(page).ready;
  await page.goto('/');
  await page.waitForSelector('[data-api="1"]');
  await page.getByRole('button', {name:'Pause', exact:true}).click();
  const stage = page.locator('[data-api="1"]');
  if (control === 'Menu') {
    const button = page.getByRole('button', {name:'Menu', exact:true});
    await button.focus(); await page.keyboard.press('Space');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
  } else if (control === 'Zoom in') {
    const before = await stage.evaluate(el => (el as any).chartApi.camera().halfHeight);
    await page.getByRole('button', {name:'Zoom in', exact:true}).focus(); await page.keyboard.press('Space');
    await expect.poll(() => stage.evaluate(el => (el as any).chartApi.camera().halfHeight)).toBeLessThan(before);
  } else if (control === 'forecast tile') {
    const tile = page.getByRole('list', {name:'Forecast days'}).getByRole('listitem').nth(1);
    await tile.focus(); await page.keyboard.press('Space');
    await expect(tile).toHaveAttribute('aria-pressed', 'true');
  } else {
    await page.getByRole('button', {name:'Data sources', exact:true}).click();
    const button = page.getByRole('button', {name:'Explain this chart', exact:true});
    await button.focus(); await page.keyboard.press('Space');
    await expect(page.locator('.map-sources')).toHaveCount(0);
    await page.keyboard.press('Escape');
  }
  await expect(page.getByRole('button', {name:'Play', exact:true})).toBeVisible();
});
