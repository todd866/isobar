import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { australiaLambert, cameraProject, project, type Camera } from '../../src/lib/lambert';
import { chartRoutes, tapPoint } from './map-fixture';

/**
 * The map is the weather front page at phone sizes.  Keep these captures
 * deliberately small and state based: they are the review sheet for the
 * header, map tools, lenses, and the three sheets which can open over it.
 */
const OUT = path.resolve(process.env.ISOBAR_PHONE_DIR ?? path.join(process.cwd(), 'test-results/phone-layout'));
const VIEWPORTS = [
  { name: '390x844', width: 390, height: 844 },
  { name: '375x667', width: 375, height: 667 },
] as const;
const THEMES = ['light', 'dark'] as const;

async function prepare(page: Page, mode: (typeof THEMES)[number], width: number, height: number) {
  await page.emulateMedia({ colorScheme: mode });
  await page.addInitScript((theme) => {
    localStorage.setItem('isobar-theme', theme);
    localStorage.setItem('isobar.place', 'perth');
  }, mode);
  await page.setViewportSize({ width, height });
  await page.clock.setFixedTime(Date.parse('2026-10-08T03:00:00Z'));
  await chartRoutes(page);
  const profile = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/unit/fixtures/openmeteo-point.json'), 'utf8'));
  await page.route('https://api.open-meteo.com/**', (route) => route.fulfill({ json: profile }));
  await page.route('https://marine-api.open-meteo.com/**', (route) => route.fulfill({ json: { hourly: { time: [] } } }));
  await page.goto('/');
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.waitForSelector('[data-isobars="true"]', { timeout: 60_000 });
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });
  await expect(page.locator('[data-map-page]')).toBeVisible();
}

async function assertPhoneContract(page: Page) {
  const map = page.locator('[data-map-page]');
  const stage = page.locator('[data-map-ready]');
  const lensBar = page.locator('[data-lens-bar]');
  const learn = page.locator('.map-header [data-learn-link]');

  // The map page owns the viewport. Training and download navigation belongs
  // in Menu and must not consume a rail or bottom tab strip here.
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  await expect(learn).toBeVisible();
  await expect(learn).toHaveAttribute('href', '/train');
  await expect(map).toBeVisible();
  await expect(stage).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('[data-map-page]')!.getBoundingClientRect();
    const map = document.querySelector('[data-map-ready]')!.getBoundingClientRect();
    const reading = document.querySelector('[data-reading]');
    return { mapShare: (map.width * map.height) / (root.width * root.height), readingClipped: reading ? reading.scrollWidth > reading.clientWidth + 1 : false };
  });
  expect(geometry.mapShare).toBeGreaterThanOrEqual(.99);
  expect(geometry.readingClipped, JSON.stringify(geometry)).toBe(false);
  const clockFits = await page.locator('.map-clock-slot').evaluate((timeline) => {
    const bounds = timeline.getBoundingClientRect();
    return [...timeline.querySelectorAll('.map-clock > span')].every((node) => {
      const box = node.getBoundingClientRect();
      return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
    });
  });
  expect(clockFits).toBe(true);

  // The reading has a complete place and wind unit. A fixture reading may use
  // a different compass point, but it must never end halfway through a word.
  await expect(page.locator('[data-reading]')).toContainText(/\d+.*kt/);
  await expect(page.locator('[data-wind-words]')).toBeVisible();
  await expect(page.locator('[data-wind-words]')).toHaveText('13 kt');
  await expect(page.locator('input[data-place]')).toHaveValue('Perth');

  const expectedLenses = ['Pressure', 'Rain', 'Wind', 'Temp', 'Kite', 'Surf', 'Fly'];
  for (const label of expectedLenses) {
    const lens = page.getByRole('radio', { name: label, exact: true });
    await expect(lens).toHaveCount(1);
    await expect(lens).toBeVisible();
    await expect(lens.locator('svg')).toBeVisible();
    const hit = (await lens.boundingBox())!;
    expect(hit.width).toBeGreaterThanOrEqual(36);
    expect(hit.height).toBeGreaterThanOrEqual(36);
    // The phone lens column may use compact icon-only controls; the accessible
    // radio name remains the stable contract.
  }
  const lensBox = await lensBar.boundingBox();
  expect(lensBox).not.toBeNull();
  const fly = page.getByRole('radio', { name: 'Fly', exact: true });
  if (await fly.isEnabled()) {
    await fly.click();
    const selected = page.getByRole('radio', { name: 'Fly', exact: true });
    await expect(selected).toHaveAttribute('aria-checked', 'true');
    const selectedBox = await selected.boundingBox();
    expect(selectedBox).not.toBeNull();
    expect(selectedBox!.x).toBeGreaterThanOrEqual(lensBox!.x - 1);
    expect(selectedBox!.x + selectedBox!.width).toBeLessThanOrEqual(lensBox!.x + lensBox!.width + 1);
    // Traffic lives inside the Fly lens on phones too (owner rule), in the tools column.
    await expect(page.locator('.map-tools').getByRole('button', { name: 'Traffic', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Satellite', exact: true })).toHaveCount(0);
    await page.getByRole('radio', { name: 'Pressure', exact: true }).click();
    await expect(page.locator('[data-fly-panel]')).toHaveCount(0);
  }

  // Satellite rides the colour lenses on phones; Traffic only exists in Fly.
  // Map details preserves terrain and teaching controls without attribution.
  const tools = page.locator('.map-tools');
  await expect(tools).toBeVisible();
  for (const label of ['Zoom in', 'Zoom out', 'Recenter map', 'Map details']) {
    await expect(tools.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Traffic', exact: true })).toHaveCount(0);
  const toolButtons = tools.getByRole('button');
  await expect(page.locator('.map-lens-wrap').getByRole('button', {name:'Satellite',exact:true})).toBeVisible();
  const sourceButton = tools.getByRole('button', { name: 'Map details', exact: true });
  await expect(toolButtons).toHaveCount(4);
  const sourceIndex = await sourceButton.evaluate((node) => Array.from(node.parentElement?.querySelectorAll('button') ?? []).indexOf(node));
  expect(sourceIndex).toBeGreaterThanOrEqual(0);
  expect(sourceIndex).toBe((await toolButtons.count()) - 1);
  await sourceButton.click();
  const explain = page.getByRole('button', { name: 'Explain this chart', exact: true });
  await expect(explain).toBeVisible();
  const explainBox = await explain.boundingBox();
  const noteBox = await page.locator('.map-details [role="note"]').boundingBox();
  expect(explainBox && noteBox).toBeTruthy();
  expect(explainBox!.width).toBeGreaterThan(120);
  expect(explainBox!.y + explainBox!.height).toBeLessThanOrEqual(noteBox!.y + 1);
  await page.keyboard.press('Escape');
  await expect(explain).toHaveCount(0);

  const chat = page.getByRole('button', { name: 'Ask Isobar', exact: true });
  await expect(chat).toBeVisible();
  const chatBox = await chat.boundingBox();
  const stageBox = await stage.boundingBox();
  expect(chatBox && stageBox).toBeTruthy();
  expect(chatBox!.x).toBeGreaterThanOrEqual(stageBox!.x - 1);
  expect(chatBox!.x + chatBox!.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width + 1);
  expect(chatBox!.y).toBeLessThan(stageBox!.y + stageBox!.height);

  // The initial sheet is compact and leaves an exposed part of the map.
  await page.route('**/api/chat', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true } });
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ delta: 'Perth remains in view while the chart explains the wind.' })}\n\ndata: ${JSON.stringify({ done: true, model: 'fixture' })}\n\n` });
  });
  await chat.click();
  const chatPanel = page.locator('[data-chat-panel]');
  await expect(chatPanel).toBeVisible();
  await expect(chatPanel).toHaveAttribute('data-chat-layout', 'sheet');
  await expect(chatPanel.locator('input[aria-label="Message"]')).toHaveAttribute('placeholder', 'Ask about this weather…');
  await expect(chatPanel.locator('[data-usage-notice]')).toHaveCount(0);
  const panelBox = await chatPanel.boundingBox();
  expect(panelBox && stageBox).toBeTruthy();
  expect(panelBox!.y).toBeGreaterThan(stageBox!.y);
  expect(panelBox!.height).toBeLessThan(160);
  // Project the selected place against the current camera, not a place-name
  // cache (which says nothing about whether a bottom sheet covers the place).
  await expect.poll(async () => {
    const camera = await stage.evaluate((node) => (node as HTMLElement & { chartApi: { camera: () => Camera } }).chartApi.camera());
    const projected = project(australiaLambert(), -31.95, 115.86)!;
    const clip = cameraProject(camera, projected.x, projected.y);
    const map = (await stage.boundingBox())!, sheet = (await chatPanel.boundingBox())!;
    const x = map.x + (clip.x + 1) * map.width / 2;
    const y = map.y + (1 - clip.y) * map.height / 2;
    return x > map.x + 8 && x < map.x + map.width - 48 && y > map.y + 8 && y < sheet.y - 8;
  }).toBe(true);
  const { assertViewport } = await import('../../../tools/viewport-fit.mjs');
  await assertViewport(page, { primary: [{ selector: '[data-chat-panel]', minWidth: 280, minHeight: 120 }], controls: [{ selector: '[aria-label="Close chat"]', minWidth: 36, minHeight: 36 }, { selector: '[aria-label="Message"]', minWidth: 100, minHeight: 32 }] });
  const emptyHeight = panelBox!.height;
  await chatPanel.getByRole('textbox', { name: 'Message' }).fill('How is the wind around Perth?');
  await chatPanel.getByRole('button', { name: 'Send' }).click();
  await expect(chatPanel.locator('[data-chat-reply]')).toContainText('Perth remains in view');
  const messageBox = await chatPanel.boundingBox();
  expect(messageBox!.height).toBeGreaterThan(emptyHeight);
  await chatPanel.getByRole('button', { name: 'Close chat' }).click();
  await expect(chatPanel).toHaveCount(0);
  await expect(chat).toBeFocused();
  await page.getByRole('radio', { name: 'Pressure', exact: true }).click();
}

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const menu = page.locator('[data-map-menu]');
  await expect(menu).toBeVisible();
  await expect(page.locator('[data-chat-panel], [data-point-panel], [data-fly-panel]')).toHaveCount(0);
  await expect(menu.getByRole('link', { name: 'Learn', exact: true })).toHaveAttribute('href', '/train');
  await expect(menu.getByRole('link', { name: 'Learn level' })).toHaveCount(0);
  await expect(menu.locator('[data-learn-level]')).toBeVisible();
  await expect(menu.getByRole('link', { name: 'E6-B', exact: true })).toHaveAttribute('href', '/e6b');
  await expect(menu.locator('[data-account-button]')).toBeVisible();
  await expect(menu.locator('[data-units]')).toBeVisible();
  await expect(menu.getByRole('button', { name: /Light|Dark/ })).toBeVisible();
  await expect(menu.locator('.learn-button, .learn-menu')).toHaveCount(0);
  const barbs = menu.getByRole('button', { name: 'Wind barbs', exact: true });
  await expect(barbs).toBeVisible();
  await barbs.click();
  await expect(barbs).toHaveAttribute('aria-pressed', 'true');
  await barbs.click();
  await expect(menu.getByText('Forecast details', { exact: true })).toBeVisible();
  await expect(menu.locator('.map-menu-run span')).toHaveAttribute('aria-label', /ECMWF forecast run, issued \d{2}Z, \d+ h ago/);
  await expect(menu.getByRole('link', { name: 'About Isobar', exact: true })).toBeVisible();
}

for (const viewport of VIEWPORTS) for (const mode of THEMES) {
  test(`phone map ${viewport.name} ${mode}: default, chat, point and menu`, async ({ page }) => {
    test.setTimeout(90_000);
    fs.mkdirSync(OUT, { recursive: true });
    await prepare(page, mode, viewport.width, viewport.height);
    await assertPhoneContract(page);
    await page.screenshot({ path: path.join(OUT, `${viewport.name}-${mode}-default.png`) });

    await page.getByRole('button', { name: 'Ask Isobar', exact: true }).click();
    await expect(page.locator('[data-chat-panel]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, `${viewport.name}-${mode}-chat.png`) });
    await page.getByRole('button', { name: 'Close chat', exact: true }).click();

    await tapPoint(page);
    await expect(page.locator('[data-point-panel]')).toBeVisible();
    await page.screenshot({ path: path.join(OUT, `${viewport.name}-${mode}-point.png`) });
    await page.getByRole('button', { name: 'Ask Isobar', exact: true }).click();
    await expect(page.locator('[data-chat-panel]')).toBeVisible();
    await expect(page.locator('[data-point-panel]')).toHaveCount(0);

    await openMenu(page);
    await page.screenshot({ path: path.join(OUT, `${viewport.name}-${mode}-menu.png`) });
  });
}

for (const width of [375, 1280]) {
  test(`map destinations use Menu and return to the map at ${width}px`, async ({ page }) => {
    await prepare(page, 'light', width, 844);
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    {
      await expect(page.locator('.map-header [data-learn-link]')).toBeVisible();
      await expect(page.locator('.map-header [data-learn-link]')).toHaveAttribute('href', '/train');
    }
    if (width >= 768) {
      await expect(page.locator('.map-header [data-map-menu] [data-units]')).toHaveCount(1);
      await expect(page.locator('.map-header [data-units]')).toBeHidden();
      await expect(page.locator('.map-header .place-search-icon')).toBeVisible();
    }
    for (const destination of ['Learn', 'E6-B']) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.locator('[data-map-menu]').getByRole('link', { name: destination, exact: true }).click();
      await page.getByRole('link', { name: 'Map', exact: true }).filter({ visible: true }).click();
      await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);
    }
  });
}
