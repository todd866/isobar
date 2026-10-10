import { test, expect, type Page } from '@playwright/test';

// What people come to do (docs/design/user-journeys.md). After every step the
// view and the forecast time must be what the user expects: only their own pan
// or zoom, Recenter or a place change moves the map; only Now, the timeline,
// a day or playback moves the time.

type Cam = { centerX: number; centerY: number; halfWidth: number; halfHeight: number; perPx?: number };

async function open(page: Page) {
  await page.goto('/');
  await page.waitForSelector('[data-isobars="true"]');
  await page.waitForFunction(() => !!(document.querySelector('[data-api="1"]') as HTMLElement & { chartApi?: unknown })?.chartApi);
}

async function camera(page: Page): Promise<Cam> {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-api="1"]') as HTMLElement & { chartApi: { camera: () => Cam } };
    const c = stage.chartApi.camera();
    // Scale the user sees: degrees of latitude per screen pixel.
    return { ...c, perPx: (c.halfHeight * 2) / Math.max(1, stage.getBoundingClientRect().height) };
  });
}

/** Same place, same scale: a panel may show more or less map, never a different zoom or centre. */
function sameView(a: Cam, b: Cam) {
  const scale = Math.max(a.halfHeight, b.halfHeight);
  const zoomSame = a.perPx && b.perPx ? Math.abs(Math.log(a.perPx / b.perPx)) < 0.02 : Math.abs(Math.log(a.halfWidth / b.halfWidth)) < 0.02;
  return Math.abs(a.centerX - b.centerX) < scale * 0.02 && Math.abs(a.centerY - b.centerY) < scale * 0.02 && zoomSame;
}

async function zoomIn(page: Page, steps = 6) {
  const stage = page.locator('[data-api="1"]');
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
  await page.keyboard.up('Control');
  await page.waitForTimeout(200);
}

async function lens(page: Page, id: string) {
  await page.locator(`[data-lens="${id}"]`).first().click();
  await page.waitForTimeout(400);
}

async function time(page: Page) {
  return Number(await page.getByRole('slider', { name: 'Forecast time' }).getAttribute('aria-valuenow'));
}

test('J2 look closer at home, then change lens: the view and time stay', async ({ page }) => {
  await open(page);
  await zoomIn(page);
  const zoomed = await camera(page);
  for (const id of ['rain', 'wind', 'temp', 'fly', 'pressure']) {
    const button = page.locator(`[data-lens="${id}"]`).first();
    // Every lens must exist and be usable; a missing control is a failure, not a skip.
    await expect(button, `${id} lens control`).toBeVisible();
    await expect(button, `${id} lens enabled`).toBeEnabled();
    const before = await time(page);
    await lens(page, id);
    const after = await camera(page);
    // The view is the user's: no lens may change centre or zoom (Fly's side panel included).
    expect(sameView(after, zoomed), `${id} moved the view ${JSON.stringify(zoomed)} -> ${JSON.stringify(after)}`).toBe(true);
    // Playback drifts a few forecast minutes per second; a lens change must not jump it.
    expect(Math.abs((await time(page)) - before), `${id} jumped the time`).toBeLessThan(10);
  }
});

test('J4 pan elsewhere, then change lens: the view stays', async ({ page }) => {
  await open(page);
  await zoomIn(page, 3);
  const stage = page.locator('[data-api="1"]');
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 220, box.y + box.height / 2 + 90, { steps: 8 });
  await page.mouse.up();
  const panned = await camera(page);
  await lens(page, 'rain');
  expect(sameView(await camera(page), panned)).toBe(true);
});

test('J8 resize while zoomed in keeps the centre', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await zoomIn(page, 4);
  const before = await camera(page);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.waitForTimeout(400);
  const after = await camera(page);
  expect(Math.abs(after.centerX - before.centerX)).toBeLessThan(before.halfWidth * 0.1);
  expect(Math.abs(after.centerY - before.centerY)).toBeLessThan(before.halfHeight * 0.1);
});

test('no boilerplate footer: sources sit behind the map ⓘ', async ({ page }) => {
  await open(page);
  await expect(page.getByText('CC BY 4.0', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Data sources' }).click();
  await expect(page.getByRole('note')).toContainText('ECMWF Open Data (CC BY 4.0)');
  await page.goto('/e6b');
  await expect(page.getByText('CC BY 4.0', { exact: false })).toHaveCount(0);
});

test('tooltips are one short line of names or figures, never instructions', async ({ page }) => {
  for (const path of ['/', '/e6b', '/train', '/download']) {
    await page.goto(path);
    await page.waitForTimeout(1500);
    const bad = await page.evaluate(() => [...document.querySelectorAll('[title]')]
      .map((e) => e.getAttribute('title') ?? '')
      .filter((t) => t.length > 60 || t.includes('\n') || /\b(drag|click|tap|scroll|press|use|hold)\b.*[;.]/i.test(t)));
    expect(bad, `${path} tooltips`).toEqual([]);
  }
});
