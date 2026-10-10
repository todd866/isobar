import { expect, test as base, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { installOdFiles } from './od-files';
import { odDeskFixture } from '../fixtures/od-desk';
import { weatherFromPublished } from '../../src/lib/od/weather';
import { nextDossier } from '../../src/lib/od/desk';
import { judge } from '../../src/lib/od/judge';
import { priorPerson } from '../../../training/src/ability';

const test = base.extend<{ desk: Page }>({
  desk: async ({ playwright, browserName, launchOptions, contextOptions, baseURL }, use) => {
    // Match the isolated-browser pattern used by learn.spec.ts. This avoids
    // the single-process Chromium sandbox sharing a browser across tests.
    const browser = await playwright[browserName].launch(launchOptions);
    try {
      const context = await browser.newContext({ ...contextOptions, baseURL, reducedMotion: 'reduce' });
      try {
        await installOdFiles(context);
        await context.addInitScript(() => {
          if (!localStorage.getItem('isobar.od.desk.aus.v1')) localStorage.setItem('isobar.od.desk.aus.v1', JSON.stringify({ shift: 1, seed: 1 }));
          if (!localStorage.getItem('isobar.learn.v1')) localStorage.setItem('isobar.learn.v1', JSON.stringify({ version: 1, started: true, icon: 'weather', text: '', goal: 'weather', level: 'curious', rules: 'aus', updatedAt: '2026-10-09T00:00:00.000Z' }));
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', e => errors.push(e.message));
        await use(page);
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    } finally { await browser.close(); }
  },
});

const shotRoot = path.resolve(process.env.OD_DESK_SCREENSHOTS || new URL('../../../build/od-qa/screenshots', import.meta.url).pathname);
function shots() { mkdirSync(shotRoot, { recursive: true }); return shotRoot; }
async function openDesk(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.addInitScript(({ theme }) => localStorage.setItem('isobar-theme', theme), { theme });
  await page.goto('/decide');
  await expect(page.getByRole('heading', { name: 'Operational Decision' })).toBeVisible();
  await expect(page.locator('.od-empty')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();
}
function expectedDeskStamps() {
  const aviation = JSON.parse(odDeskFixture.get('/data/aviation.json')!.body.toString());
  const reports = aviation.airports.map((airport: { icao: string }) => weatherFromPublished({ station: airport.icao, aviation, capturedAt: '2026-10-09T00:00:00.000Z' })).filter(Boolean);
  const person = priorPerson({ level: 'curious', goal: 'weather', rules: 'aus', now: Date.parse('2026-10-09T00:00:00.000Z') });
  return [0, 1, 2].map(position => nextDossier(reports, person, 1, position, 1 + position)?.id.includes('-pass-') ? 'RELEASE' : 'REFUSE');
}
async function fit(page: Page, phone = false) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  if (process.env.VIEWPORT_HELPER) {
    const { assertViewport } = await import(new URL(process.env.VIEWPORT_HELPER).href);
    await assertViewport(page, { primary: [{ selector: '.od-office', minWidth: phone ? 300 : 800, minHeight: 300 }, { selector: '.od-workspace', minWidth: 280, minHeight: 120 }, { selector: '.od-document.is-active', minWidth: 280, minHeight: 120 }], controls: [{ selector: '.od-stamps button', minHeight: 44 }] });
  }
}

test('shift one files three correct dossiers, records Learn evidence and UsageEvent', async ({ desk: page }) => {
  const usage: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/usage')) usage.push(request.postData() ?? ''); });
  await openDesk(page);
  for (const [i, stamp] of expectedDeskStamps().entries()) {
    await page.getByRole('button', { name: stamp === 'RELEASE' ? 'Release' : 'Refuse' }).click();
    await expect(page.getByRole('status')).toContainText(/Filed/);
    if (i < 2) { await page.getByRole('button', { name: /Next dossier/ }).click(); await expect(page.getByRole('button', { name: 'Release' })).toBeVisible(); }
  }
  const learn = await page.evaluate(() => JSON.parse(localStorage.getItem('isobar.learn.v1') ?? 'null'));
  expect(learn.desk.receipts).toHaveLength(3);
  expect(learn.desk.receipts.every((r: { correct: boolean }) => r.correct)).toBe(true);
  expect(usage.join('\n')).toContain('od-decision');
  await expect(page.getByTestId('citation')).toHaveCount(0);
  await page.getByRole('button', { name: /Close shift/ }).click();
  await expect(page.locator('.od-shift')).toContainText('02');
});

test('wrong stamp opens a Ministry citation with source and Learn card link', async ({ desk: page }) => {
  const usage: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/usage')) usage.push(request.postData() ?? ''); });
  await openDesk(page);
  await page.getByRole('button', { name: 'Refuse' }).click();
  await expect(page.getByTestId('citation')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ministry citation' })).toBeVisible();
  await expect(page.getByTestId('citation').locator('a[href^="http"]')).toHaveCount(1);
  await expect(page.getByTestId('citation').locator('a[href^="/train?concept="]')).toHaveCount(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('isobar.learn.v1') ?? 'null').desk.receipts[0].stamp)).toBe('REFUSE');
  expect(usage.join('\n')).toContain('od-decision');
  await page.getByTestId('citation').locator('a[href^="/train?concept="]').click();
  await expect(page.locator('.review-card')).toBeVisible();
  await expect(page.locator('.review-card')).toContainText(/TAF|forecast|TEMPO|BECMG/i);
  await expect(page.getByRole('link', { name: 'Operational Decision desk' })).toBeVisible();
});

test('amend slip, ruler, wind card and manual expose operational readings', async ({ desk: page }) => {
  await openDesk(page);
  await page.getByRole('button', { name: 'Amend' }).click();
  const slip = page.getByRole('dialog', { name: 'Amendment slip' });
  await expect(slip).toBeVisible();
  await slip.getByLabel('Extra fuel · kg').fill('100');
  await slip.getByLabel('Delay · min').fill('15');
  await expect(slip).toContainText(/Fuel after amendment:/);
  await slip.getByRole('button', { name: 'Stamp amendment' }).click();
  await expect(page.getByRole('status')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('isobar.learn.v1') ?? 'null').desk.receipts[0].stamp)).toBe('AMEND');
  const citation = page.getByRole('dialog', { name: 'Ministry citation' });
  if (await citation.isVisible().catch(() => false)) await citation.getByRole('button', { name: 'Acknowledge' }).click();
  await page.getByRole('button', { name: 'Next dossier' }).click();
  await page.getByRole('button', { name: 'Wind card' }).click();
  const wind = page.getByRole('dialog', { name: 'Wind component card' });
  await wind.getByLabel('Runway °T').fill('90');
  await wind.getByLabel('Wind from °T').fill('180');
  await wind.getByLabel('Wind kt').fill('20');
  await expect(wind.getByTestId('crosswind')).toHaveText('20.0 kt');
  await expect(wind.getByTestId('headwind')).toHaveText('0.0 kt');
  const flow = await wind.getByTestId('wind-arrow').evaluate(node => {
    const arrow = node as SVGPathElement, matrix = arrow.getCTM()!;
    const start = arrow.getPointAtLength(0).matrixTransform(matrix);
    const tip = arrow.getPointAtLength(80).matrixTransform(matrix);
    return { x: tip.x - start.x, y: tip.y - start.y };
  });
  expect(flow.x).toBeLessThan(0); // Wind from the right travels left across the runway.
  expect(Math.abs(flow.y)).toBeLessThan(1);
  await wind.getByRole('button', { name: /Close/ }).click();
  await page.getByRole('button', { name: 'Ruler' }).click();
  const ruler = page.getByRole('dialog', { name: 'ETA ruler' });
  const etaReading = await ruler.getByTestId('ruler-time').textContent();
  await ruler.getByLabel('Ruler offset minutes').fill('30');
  const advanced = new Date(Date.parse((etaReading ?? '').replace(' ', 'T')) + 30 * 60_000).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  await expect(ruler.getByTestId('ruler-time')).toHaveText(advanced);
  await expect(ruler.getByTestId('ruler-reading')).toHaveText(/BASE|FM|BECMG|TEMPO/);
  const etaMillis = Date.parse((etaReading ?? '').replace(' ', 'T'));
  await ruler.getByLabel('Ruler offset minutes').fill(String((Date.parse('2026-10-09T11:59:00Z') - etaMillis) / 60_000));
  await expect(ruler.getByTestId('ruler-reading')).toHaveText('BASE');
  await ruler.getByLabel('Ruler offset minutes').fill(String((Date.parse('2026-10-09T12:00:00Z') - etaMillis) / 60_000));
  await expect(ruler.getByTestId('ruler-reading')).toHaveText('FM091200');
  await ruler.getByRole('button', { name: 'Close ETA ruler' }).click();
  await page.locator('button[title^="06"]').click();
  await expect(page.getByRole('button', { name: 'Open booklet' })).toBeVisible();
  await page.getByRole('button', { name: 'Open booklet' }).click();
  await expect(page.locator('.od-manual')).toContainText('Fuel & time');
});

test('documents drag on desktop and stay a one-sheet swipe stack on phone', async ({ desk: page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDesk(page);
  const first = page.getByTestId('document-0');
  const before = await first.boundingBox();
  const handle = await first.locator('.od-paper-handle').boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + 20, handle!.y + 15);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 220, handle!.y + 80, { steps: 5 });
  await page.mouse.up();
  const after = await first.boundingBox();
  expect(after?.x).not.toBe(before?.x);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.od-document.is-active')).toHaveCount(1);
  await page.locator('.od-document.is-active .od-paper-content').evaluate(node => {
    const make = (clientX: number) => new Touch({ identifier: 1, target: node, clientX, clientY: 300 });
    node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [make(300)] }));
    node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, changedTouches: [make(100)] }));
  });
  await expect(page.locator('.od-mobile-nav select')).toHaveValue('taf');
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();
});

test('keyboard controls and light/dark screenshots fit laptop and phone', async ({ desk: page }) => {
  for (const theme of ['light', 'dark'] as const) for (const [width, height, label] of [[1440, 900, '1440x900'], [390, 844, '390x844']] as const) {
    await page.setViewportSize({ width, height });
    await openDesk(page, theme);
    await page.keyboard.press('w');
    await expect(page.getByRole('dialog', { name: 'Wind component card' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Desk controls' })).toBeVisible();
    await page.keyboard.press('Escape');
    await fit(page, width < 700);
    await page.screenshot({ path: path.join(shots(), `${theme}-${label}.png`), fullPage: false });
  }
});

test('short laptop landscape and enlarged text keep the decision controls reachable', async ({ desk: page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await openDesk(page);
  await fit(page);
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();
  await page.evaluate(() => {
    for (const node of document.querySelectorAll<HTMLElement>('.od-office *')) {
      if (node.children.length === 0) node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * 2}px`;
    }
  });
  await fit(page);
  await page.getByRole('button', { name: 'Release' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Release' })).toBeInViewport();
  await page.screenshot({ path: path.join(shots(), 'large-text-1280x640.png') });
  await page.goto('/decide');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('.od-empty')).toHaveCount(0);
  await fit(page);
  await page.screenshot({ path: path.join(shots(), 'landscape-844x390.png') });
});

test('reduced motion keeps desk usable when art becomes unavailable after preparation', async ({ desk: page }) => {
  const artRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('/od/') && request.url().endsWith('.webp')) artRequests.push(request.url()); });
  await page.route('**/od/*.webp', async route => { await new Promise(resolve => setTimeout(resolve, 80)); await route.fallback(); });
  await openDesk(page);
  await expect(page.locator('.od-office')).toHaveCSS('font-family', /./);
  await expect.poll(() => artRequests.length).toBeGreaterThan(0);
  const preparedCount = artRequests.length;
  expect(new Set(artRequests).size).toBe(12);
  await page.route('**/od/*.webp', route => route.abort());
  for (const title of ['Destination TAF', 'Departure METAR', 'Technical log', 'Ministry bulletin', 'Operations manual']) {
    await page.locator('.od-file-tabs').getByRole('button', { name: new RegExp(title) }).click();
    await expect(page.locator('.od-office')).toBeVisible();
  }
  await page.locator('.od-file-tabs').getByRole('button', { name: /Flight plan/ }).click();
  await page.getByRole('button', { name: 'Release' }).click();
  await page.getByRole('button', { name: /Next dossier/ }).click();
  await expect(page.getByRole('button', { name: 'Release' })).toBeVisible();
  expect(artRequests.length).toBe(preparedCount);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.getByRole('heading', { name: 'Operational Decision' })).toBeVisible();
});


test('AMEND repairs a fuel dossier with an alternate, extra fuel and delay', async ({ desk: page }) => {
  const aviation = JSON.parse(odDeskFixture.get('/data/aviation.json')!.body.toString());
  const reports = aviation.airports.map((airport: { icao: string }) => weatherFromPublished({ station: airport.icao, aviation, capturedAt: '2026-10-09T00:00:00Z' })).filter(Boolean);
  const person = priorPerson({ level: 'curious', goal: 'weather', rules: 'aus', now: Date.now() });
  let seed = 1, d = nextDossier(reports, person, 7, 0, seed)!;
  while (seed < 20 && !d.id.includes('-fail-')) d = nextDossier(reports, person, 7, 0, ++seed)!;
  expect(d.target.decreeIds).toContain('fuel');
  expect(d.id).toContain('-fail-');
  const alternate = d.alternatives.find(a => a.aerodrome.id !== d.plan.alternateId)!;
  const decision = { stamp: 'AMEND' as const, alternate: alternate.aerodrome.id, fuel: d.plan.fuelKg + 1500, delay: 15 };
  expect(judge(d, decision, { edition: 'aus', responseMs: 1000 }).correct).toBe(true);
  await page.addInitScript(seed => localStorage.setItem('isobar.od.desk.aus.v1', JSON.stringify({ shift: 7, seed })), seed);
  await openDesk(page);
  await page.getByRole('button', { name: 'Amend' }).click();
  const slip = page.getByRole('dialog', { name: 'Amendment slip' });
  await slip.getByLabel('Alternate', { exact: true }).selectOption(alternate.aerodrome.id);
  await slip.getByLabel('Extra fuel · kg').fill('1500');
  await slip.getByLabel('Delay · min').fill('15');
  await expect(slip).toContainText(`Fuel after amendment: ${decision.fuel.toLocaleString('en-US')} kg`);
  await slip.getByRole('button', { name: 'Stamp amendment' }).click();
  await expect(page.getByRole('status')).toContainText('Filed');
  await expect(page.getByTestId('citation')).toHaveCount(0);
  const learn = await page.evaluate(() => JSON.parse(localStorage.getItem('isobar.learn.v1')!));
  expect(learn.desk.receipts[0]).toMatchObject({ stamp: 'AMEND', correct: true });
});


test('phone slips remain readable, with accessible controls and paper contrast', async ({ desk: page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDesk(page);
  for (const [button, title, name] of [['Amend', 'Amendment slip', 'amend'], ['Ruler', 'ETA ruler', 'ruler'], ['Wind card', 'Wind component card', 'wind']]) {
    await page.getByRole('button', { name: button }).click();
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    if (process.env.VIEWPORT_HELPER) {
      const { assertViewport } = await import(new URL(process.env.VIEWPORT_HELPER).href);
      await assertViewport(page, { primary: [{ selector: '.od-slip', minWidth: 300, minHeight: 200 }], controls: [{ selector: '.od-slip>header button', minWidth: 44, minHeight: 44 }] });
    }
    await page.screenshot({ path: path.join(shots(), `${name}-390x844.png`) });
    await page.keyboard.press('Escape');
  }
  const contrasts = await page.evaluate(() => {
    const luminance = (rgb: number[]) => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const ratio = (a: number[], b: number[]) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    const rgb = (css: string) => css.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    return ['.od-stamp.od-release', '.od-stamp.od-refuse', '.od-stamp.od-amend', '.od-rows dt', '.od-paper-content'].map(selector => {
      const style = getComputedStyle(document.querySelector(selector)!);
      // The darkest part of the paper texture beneath the opaque overlay.
      const background = selector.includes('od-stamp') ? rgb(style.backgroundColor) : [225, 214, 188];
      return { selector, ratio: ratio(rgb(style.color), background) };
    });
  });
  for (const reading of contrasts) expect(reading.ratio, reading.selector).toBeGreaterThanOrEqual(4.5);
  await page.getByRole('button', { name: 'Refuse' }).click();
  await expect(page.getByTestId('citation')).toBeVisible();
  await page.screenshot({ path: path.join(shots(), 'citation-390x844.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 360, height: 640 });
  await page.getByRole('button', { name: /Next dossier/ }).click();
  await fit(page, true);
  await page.screenshot({ path: path.join(shots(), 'small-360x640.png') });
});

test('late-shift worksheets expose performance inputs and the final shift stays closed', async ({ desk: page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('od-final-fixture')) {
      localStorage.setItem('isobar.od.desk.aus.v1', JSON.stringify({ shift: 19, seed: 1 }));
      sessionStorage.setItem('od-final-fixture', 'prepared');
    }
  });
  await openDesk(page);
  const plan = page.locator('.od-document.is-active');
  await plan.getByText('Load & runway worksheet', { exact: true }).click();
  await expect(plan).toContainText('Aerodrome elevation · departure / arrival');
  await expect(plan).toContainText('Freezing level · departure / arrival');
  await page.locator('.od-file-tabs').getByRole('button', { name: /Destination TAF/ }).click();
  const taf = page.locator('.od-document.is-active');
  await taf.getByText('Arrival performance observation', { exact: true }).click();
  await expect(taf.locator('details')).toContainText('METAR');
  await page.locator('.od-file-tabs').getByRole('button', { name: /Operations manual/ }).click();
  await page.getByRole('button', { name: /Open booklet/ }).click();
  await expect(page.locator('.od-manual')).toContainText('turbine 30 min');
  await page.getByRole('button', { name: 'Next manual page' }).click();
  await expect(page.locator('.od-manual')).toContainText('Seats · including crew');
  await expect(page.locator('.od-manual')).toContainText('Landing mass = take-off mass − trip fuel');
  for (let i = 0; i < 8; i++) {
    await page.getByRole('button', { name: 'Release' }).click();
    const citation = page.getByRole('dialog', { name: 'Ministry citation' });
    if (await citation.isVisible()) await citation.getByRole('button', { name: 'Acknowledge' }).click();
    await page.getByRole('button', { name: i === 7 ? /Close shift/ : /Next dossier/ }).click();
  }
  await expect(page.getByRole('status')).toContainText('All 19 shifts complete');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('isobar.od.desk.aus.v1')!).finished)).toBe(true);
  await page.goto('/decide');
  await expect(page.getByRole('status')).toContainText('All 19 shifts complete');
  await expect(page.getByRole('button', { name: 'Release' })).toHaveCount(0);
});
