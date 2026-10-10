import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';

test.setTimeout(60_000);
async function referenceScene(page: Page) {
  await page.route('**/api/earth/orbit', route => route.fulfill({ status: 503, json: { error: 'Current ISS elements unavailable' } }));
  await page.goto('/earth');
  await expect(page.getByText('Current ISS elements unavailable', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Preview 2019 reference' }).click();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 40_000 });
}
async function paint(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function time(page: Page) { return Number(await page.locator('.earth-experience').getAttribute('data-utc')); }
async function changedPixels(first: Buffer, second: Buffer) {
  const a = await sharp(first).removeAlpha().raw().toBuffer(), b = await sharp(second).removeAlpha().raw().toBuffer();
  expect(a.length).toBe(b.length);
  let changed = 0;
  for (let i=0;i<a.length;i+=3) if (Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]) > 35) changed++;
  return changed / (a.length / 3);
}

test('explicit reference scene renders different views while preserving time and prepared assets offline', async ({ page, context }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => { if (request.url().includes('/earth/') && !request.url().includes('/api/')) requests.push(request.url()); });
  await referenceScene(page);
  await expect(page.locator('.earth-toolbar')).toContainText('Reference · 2019');
  await expect(page.locator('time')).toContainText('2019-06-05');
  await page.getByRole('button', { name: 'Pause time' }).click();
  await paint(page);
  const before = await time(page);
  const follow = await page.locator('canvas').screenshot();
  await context.setOffline(true);
  await page.getByRole('combobox', { name: 'View', exact: true }).selectOption('down');
  await paint(page);
  const down = await page.locator('canvas').screenshot();
  expect(await changedPixels(follow, down)).toBeGreaterThan(.05);
  await page.getByRole('combobox', { name: 'View', exact: true }).selectOption('globe');
  await page.getByRole('combobox', { name: 'View', exact: true }).selectOption('follow');
  expect(await time(page)).toBe(before);
  expect(requests.filter(url => url.endsWith('/iss.glb'))).toHaveLength(1);
  expect(requests.filter(url => url.endsWith('/earth-october.jpg'))).toHaveLength(1);
  await page.getByRole('button', { name: 'Sources', exact: true }).click();
  await expect(page.getByLabel('Scene sources')).toContainText('October 2004');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Sources', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('pointer and keyboard holds freeze time; camera controls leave selected UTC intact', async ({ page }) => {
  await referenceScene(page);
  const canvas = page.locator('canvas');
  await canvas.hover();
  await page.mouse.down();
  await page.waitForTimeout(350);
  const held = await time(page);
  await page.waitForTimeout(350);
  expect(await time(page)).toBe(held);
  await page.mouse.up();
  await expect.poll(() => time(page)).toBeGreaterThan(held);
  await canvas.focus();
  await page.keyboard.down('Space');
  await page.waitForTimeout(350);
  const keyHeld = await time(page);
  await page.waitForTimeout(350);
  expect(await time(page)).toBe(keyHeld);
  await page.keyboard.up('Space');
  await expect.poll(() => time(page)).toBeGreaterThan(keyHeld);
  await page.getByRole('button', { name: 'Pause time' }).click();
  const paused = await time(page);
  await paint(page);
  const initialView = await canvas.screenshot();
  await canvas.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('.earth-experience')).toHaveAttribute('data-view', 'explore');
  await paint(page);
  expect(await changedPixels(initialView, await canvas.screenshot())).toBeGreaterThan(.005);
  await page.keyboard.press('Home');
  await expect(page.locator('.earth-experience')).toHaveAttribute('data-view', 'follow');
  await paint(page);
  const beforeZoom = await canvas.screenshot();
  await canvas.hover(); await page.mouse.wheel(0, -80);
  await expect(page.locator('.earth-experience')).toHaveAttribute('data-view', 'explore');
  await paint(page);
  expect(await changedPixels(beforeZoom, await canvas.screenshot())).toBeGreaterThan(.005);
  expect(await time(page)).toBe(paused);
});

test('asset failure and lost graphics context both have a working retry', async ({ page }) => {
  let fail = true;
  await page.route('**/earth/iss.glb', route => fail ? route.fulfill({ status: 503, body: 'unavailable' }) : route.continue());
  await page.route('**/api/earth/orbit', route => route.fulfill({ status: 503, json: {} }));
  await page.goto('/earth');
  await page.getByRole('button', { name: 'Preview 2019 reference' }).click();
  await expect(page.getByText('Earth assets unavailable', { exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 40_000 });
  await page.locator('canvas').evaluate(canvas => {
    (canvas as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(page.getByText('Graphics interrupted', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('[data-ready=true]')).toBeVisible({ timeout: 40_000 });
  await paint(page);
  expect(await page.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).getContext('webgl2')!.isContextLost())).toBe(false);
});

test('navigation cancels an unfinished scene without late UI or renderer errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/earth/iss.glb', async route => { await gate; await route.abort().catch(() => {}); });
  await page.route('**/api/earth/orbit', route => route.fulfill({ status: 503, json: {} }));
  await page.goto('/earth');
  await page.getByRole('button', { name: 'Preview 2019 reference' }).click();
  await expect(page.getByText('Preparing Earth…')).toBeVisible();
  await page.goto('/flow-study');
  release();
  await expect(page.getByRole('heading', { name: 'Lifted trails' })).toBeVisible();
  await paint(page);
  expect(errors).toEqual([]);
});

test('phone, short landscape and enlarged text keep the scene and controls in the viewport', async ({ page }) => {
  await referenceScene(page);
  await page.getByRole('button', { name: 'Pause time' }).click();
  for (const [width, height, large] of [[390,844,false],[844,390,false],[1280,720,true],[390,844,true]] as const) {
    await page.setViewportSize({width,height});
    await page.evaluate(big => { document.documentElement.style.fontSize = big ? '32px' : '16px'; }, large);
    await paint(page);
    const fit = await page.evaluate(() => {
      const stage = document.querySelector('.earth-stage')!.getBoundingClientRect();
      return { overflowX: document.documentElement.scrollWidth > innerWidth+1, overflowY: document.documentElement.scrollHeight > innerHeight+1,
        stageHeight: stage.height, controls: [...document.querySelectorAll('.earth-toolbar button,.earth-toolbar select,.earth-time input')].every(el => {
          const r=el.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth+1 && r.top>=0 && r.bottom<=innerHeight+1;
        }) };
    });
    expect(fit).toMatchObject({overflowX:false,overflowY:false,controls:true});
    expect(fit.stageHeight).toBeGreaterThanOrEqual(140);
  }
});

test('airflow comparison remains readable on a phone with enlarged text', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/flow-study');
  await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
  await page.getByRole('checkbox', {name:'reduce motion'}).check();
  const geometry = await page.evaluate(() => {
    const title = document.querySelector('.flow-study-heading h1')!.getBoundingClientRect();
    const theme = document.querySelector('.flow-study-heading button')!.getBoundingClientRect();
    const controls = document.querySelector('.flow-study-controls')!.getBoundingClientRect();
    return {overlap: title.right > theme.left, headerBottom: Math.max(title.bottom,theme.bottom), controlsTop:controls.top,
      overflow:document.documentElement.scrollWidth > innerWidth+1};
  });
  expect(geometry.overlap).toBe(false);
  expect(geometry.overflow).toBe(false);
  expect(geometry.headerBottom).toBeLessThanOrEqual(geometry.controlsTop);
  await expect(page.getByRole('heading', {name:'Lifted trails'})).toBeVisible();
});
