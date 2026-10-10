import { expect, test, type Locator, type Page } from '@playwright/test';
import { chartRoutes } from './map-fixture';

async function openPaused(page: Page) {
  await chartRoutes(page);
  await page.goto('/');
  await expect(page.locator('[data-isobars="true"]')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Forecast time' })).toBeVisible();
  const pause = page.getByRole('button', { name: 'Pause', exact: true });
  if (await pause.isVisible()) await pause.click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  // The clock display is sampled at 140 ms; let its final playing frame settle.
  await page.waitForTimeout(200);
}

async function clock(page: Page) {
  return Number(await page.getByRole('slider', { name: 'Forecast time' }).getAttribute('aria-valuenow'));
}

async function timelineBoxes(page: Page) {
  const timeline = page.getByRole('slider', { name: 'Forecast time' });
  const track = timeline.locator('[data-timeline-track]');
  return { timeline, track, box: (await track.boundingBox())! };
}

async function moveAcross(page: Page, track: Locator, box: { x: number; y: number; width: number; height: number }) {
  await page.mouse.move(box.x + box.width * .15, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width * .82, box.y + box.height / 2, { steps: 6 });
  await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2);
  await expect(track).toBeVisible();
}

test('quick timeline crossing does not seek or pause, while a dwell arms at the latest position', async ({ page }) => {
  await openPaused(page);
  const { track, box } = await timelineBoxes(page);
  const before = await clock(page);
  await moveAcross(page, track, box);
  await page.waitForTimeout(80);
  expect(await clock(page)).toBe(before);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  const target = box.x + box.width * .72;
  await page.mouse.move(target, box.y + box.height / 2);
  await page.waitForTimeout(350);
  const armed = await clock(page);
  expect(armed).not.toBe(before);
  // The visible timeline is a moving time window, not the entire run.
  // An immediate click at the same coordinate must select the identical time.
  await page.mouse.down();
  await page.mouse.up();
  expect(await clock(page)).toBe(armed);
  await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2);
  await page.mouse.move(target, box.y + box.height / 2);
  await page.waitForTimeout(350);

  await page.mouse.move(box.x + box.width * .4, box.y + box.height / 2);
  await page.waitForTimeout(50);
  expect(await clock(page)).not.toBe(armed);
  await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});

test('hover restores the playback state captured when it arms, and click seeks immediately', async ({ page }) => {
  await openPaused(page);
  const { track, box } = await timelineBoxes(page);
  const pausedBefore = await clock(page);
  await page.mouse.move(box.x + box.width * .65, box.y + box.height / 2);
  await page.waitForTimeout(350);
  await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(await clock(page)).not.toBe(pausedBefore);

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2);
  await page.waitForTimeout(350);
  await page.mouse.move(box.x + box.width + 30, box.y + box.height / 2);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const clickBefore = await clock(page);
  await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  expect(await clock(page)).not.toBe(clickBefore);
  await expect(track).toBeVisible();
});

test('pointer cancellation before the dwell leaves the clock unchanged', async ({ page }) => {
  await openPaused(page);
  const { timeline, box } = await timelineBoxes(page);
  const before = await clock(page);
  await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2);
  await page.waitForTimeout(80);
  await timeline.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: box.x + box.width * .8, clientY: box.y + box.height / 2 });
  await page.waitForTimeout(350);
  expect(await clock(page)).toBe(before);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});
