import {expect, test, type Page} from '@playwright/test';
import {chartRoutes} from './map-fixture';

async function pauseDissolve(page: Page) {
  await page.getByRole('button', {name:'Pause', exact:true}).click();
  await page.getByRole('combobox', {name:'Speed', exact:true}).selectOption('8');
  await page.getByRole('slider', {name:'Forecast time'}).focus();
  await page.keyboard.press('End');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const pauseAtMidpoint = () => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-loop-dissolve]');
      const alpha = Number(canvas?.style.opacity);
      if (canvas?.style.display === 'block' && alpha < .8 && alpha > .2) {
        document.querySelector<HTMLButtonElement>('button[aria-label="Pause"]')!.click();
      } else requestAnimationFrame(pauseAtMidpoint);
    };
    requestAnimationFrame(pauseAtMidpoint);
  });
  await page.getByRole('button', {name:'Play', exact:true}).click();
  await expect(page.getByRole('button', {name:'Play', exact:true})).toBeVisible();
  await expect(page.locator('[data-api="1"]')).toHaveAttribute('data-loop-phase', 'dissolve');
}

for (const action of ['chat time', 'teaching']) test(`${action} cancels a paused dissolve`, async ({page}, info) => {
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  await chartRoutes(page);
  await page.route('**/api/chat', route => route.fulfill({contentType:'text/event-stream', body: [
    `data: ${JSON.stringify({delta:'2026-10-09T12:00:00Z'})}\n\n`,
    `data: ${JSON.stringify({done:true, anchors:{places:[], times:[{text:'Later', timeUtc:'2026-10-09T12:00:00Z'}]}})}\n\n`,
  ].join('')}));
  await page.goto('/');
  await page.waitForSelector('[data-frames="complete"]');
  await pauseDissolve(page);
  if (action === 'chat time') {
    await page.getByRole('button', {name:'Ask Isobar', exact:true}).click();
    await page.getByRole('textbox', {name:'Message'}).fill('Later?');
    await page.getByRole('button', {name:'Send', exact:true}).click();
    await page.locator('[data-chat-time]').click();
  } else {
    await page.getByRole('button', {name:'Data sources', exact:true}).click();
    await page.getByRole('button', {name:'Explain this chart', exact:true}).click();
  }
  const stage = page.locator('[data-api="1"]');
  await page.screenshot({path:info.outputPath(`${action}-seek.png`)});
  await expect(stage).toHaveAttribute('data-loop-phase', 'forward');
  await expect(page.locator('[data-loop-dissolve]')).toBeHidden();
  const selected = await stage.evaluate(el => (el as any).chartApi.playback().minute);
  if (action === 'chat time') expect(selected).toBe(36 * 60);
  else await page.keyboard.press('Escape');
  await page.getByRole('button', {name:'Play', exact:true}).click();
  await expect.poll(() => stage.evaluate(el => (el as any).chartApi.playback().minute)).toBeGreaterThan(selected);
  expect(await stage.evaluate(el => (el as any).chartApi.playback().minute)).toBeLessThan(selected + 60);
});
