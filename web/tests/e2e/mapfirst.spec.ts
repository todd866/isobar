import { historyRoutes } from './history-layout-fixture';
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';


const OUT = path.resolve(process.cwd(), 'test-results/mapfirst');
const VIEWPORTS = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '844x390', width: 844, height: 390 },
  { name: '390x844', width: 390, height: 844 },
] as const;

async function prepare(page: Page, theme: 'light' | 'dark', route = '/', viewport = { width: 1280, height: 720 }) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((value) => {
    localStorage.setItem('isobar-theme', value);
    localStorage.setItem('isobar.place', 'perth');
  }, theme);
  const manifest = JSON.parse(fs.readFileSync('public/data/manifest.json', 'utf8'));
  await page.clock.setFixedTime(Date.parse(manifest.run) + 8 * 3600000);
  await page.route('**/api/auth/**', request => request.fulfill({json:null}));
  await page.route('**/api/usage', request => request.fulfill({status:204,body:''}));
  const profile = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/unit/fixtures/openmeteo-point.json'), 'utf8'));
  await page.route('https://api.open-meteo.com/**', (request) => request.fulfill({ json: profile }));
  await page.route('https://marine-api.open-meteo.com/**', (request) => request.fulfill({ json: { hourly: { time: [] } } }));
  await page.goto(route);
  await page.waitForSelector('[data-map-ready="true"]', { timeout: 60_000 });
  await page.waitForSelector('[data-frames="complete"]', { timeout: 60_000 });
  await expect(page.locator('[data-map-page]')).toBeVisible();
}

function rectsOverlap(a: DOMRect, b: DOMRect, gap = 0) {
  return a.left < b.right - gap && a.right > b.left + gap && a.top < b.bottom - gap && a.bottom > b.top + gap;
}

async function assertMapFirst(page: Page, width: number, height: number, historical = false) {
  const geometry = await page.evaluate(() => {
    const root = document.querySelector('[data-map-page]')!.getBoundingClientRect();
    const map = document.querySelector('[data-map-ready]')!.getBoundingClientRect();
    const chips = ['.map-header-place', '.map-header-actions', '.map-lens-wrap', '.map-bottom-bar']
      .map((selector) => document.querySelector<HTMLElement>(selector))
      .filter((node): node is HTMLElement => Boolean(node && node.getClientRects().length))
      .map((node) => ({ selector: node.className, rect: node.getBoundingClientRect().toJSON() }));
    const controls = [...document.querySelectorAll<HTMLElement>('.map-tools, .map-legend, [data-map-controls]')]
      .filter((node) => node.getClientRects().length)
      .map((node) => node.getBoundingClientRect().toJSON());
    const daysHost = document.querySelector<HTMLElement>('.forecast-days');
    const days = [...document.querySelectorAll<HTMLElement>('.timeline .forecast-day')]
      .map((node) => { const label = node.querySelector<HTMLElement>(`[data-day-option="${node.dataset.detail}"]`)!; const style = getComputedStyle(node); return { rect: node.getBoundingClientRect().toJSON(), label: label.getBoundingClientRect().toJSON(), name: label.querySelector('.day-name')!.textContent, scrollWidth: label.scrollWidth + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight), clientWidth: node.clientWidth }; });
    return {
      root: root.toJSON(), map: map.toJSON(), chips, controls, days,
      daysHost: daysHost?.getBoundingClientRect().toJSON(), daysScrollLeft: daysHost?.scrollLeft ?? 0,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rangeBars: document.querySelectorAll('.day-range').length,
    };
  });
  const rootArea = geometry.root.width * geometry.root.height;
  const mapArea = geometry.map.width * geometry.map.height;
  expect(mapArea / rootArea, 'map must fill the map content area').toBeGreaterThanOrEqual(.99);
  expect(geometry.pageOverflow, 'map chrome must not widen the page').toBeLessThanOrEqual(1);
  expect(geometry.rangeBars, 'temperature range bars were removed').toBe(0);

  for (let i = 0; i < geometry.chips.length; i++) {
    for (let j = i + 1; j < geometry.chips.length; j++) {
      expect(rectsOverlap(geometry.chips[i].rect as DOMRect, geometry.chips[j].rect as DOMRect), `${geometry.chips[i].selector} overlaps ${geometry.chips[j].selector}`).toBe(false);
    }
    for (const control of geometry.controls) {
      expect(rectsOverlap(geometry.chips[i].rect as DOMRect, control as DOMRect), `${geometry.chips[i].selector} overlaps map controls`).toBe(false);
    }
  }

  if (!historical) expect(geometry.days, 'the timeline owns seven forecast segments').toHaveLength(7);
  else expect(geometry.days.length).toBeGreaterThan(0);
  for (const rain of await page.locator('.day-rain:visible').allTextContents()) {
    expect(rain).toMatch(/^\d+\.\d$/);
    expect(Number(rain)).toBeGreaterThanOrEqual(0.1);
  }
  const host = geometry.daysHost!;
  for (const day of geometry.days) {
    expect(day.scrollWidth, 'day labels must not be clipped').toBeLessThanOrEqual(day.clientWidth + 1);
    expect(day.name).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
    expect(day.label.left).toBeGreaterThanOrEqual(day.rect.left);
    expect(day.label.right).toBeLessThanOrEqual(day.rect.right);
    expect(day.rect.top).toBeGreaterThanOrEqual(host.top - 1);
    expect(day.rect.bottom).toBeLessThanOrEqual(host.bottom + 1);
  }
  if (width > 600 && !historical) {
    const fonts = await page.locator('[data-lens="pressure"], .map-lens-extras [aria-label="Satellite"]').evaluateAll(nodes => nodes.map(node => { const s = getComputedStyle(node); return [s.fontFamily, s.fontSize, s.fontWeight].join('|'); }));
    expect(fonts).toHaveLength(2);
    expect(fonts[1]).toBe(fonts[0]);
  }
  if (width <= 600) {
    expect(geometry.daysScrollLeft, 'today starts the phone day strip').toBeLessThanOrEqual(1);
    expect(geometry.days[0].rect.left).toBeGreaterThanOrEqual(host.left - 1);
    expect(geometry.days[0].rect.left).toBeLessThanOrEqual(host.left + 3);
  } else {
    expect(geometry.days[0].rect.left).toBeGreaterThanOrEqual(host.left - 1);
    expect(geometry.days.at(-1)!.rect.right).toBeLessThanOrEqual(host.right + 1);
  }
  expect(await page.locator('.map-bottom-bar').evaluate((node) => node.getBoundingClientRect().height)).toBeLessThan(58);
}

for (const viewport of VIEWPORTS) for (const theme of ['light', 'dark'] as const) {
  test(`map-first ${viewport.name} ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await prepare(page, theme, '/', viewport);
    fs.mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: path.join(OUT, `${viewport.name}-${theme}.png`) });
    await assertMapFirst(page, viewport.width, viewport.height);
    {
      const { assertViewport } = await import('../../../tools/viewport-fit.mjs');
      await assertViewport(page, { primary: [{selector:'[data-map-ready]'}], controls:[{selector:'.map-header-place'}, {selector:'.map-header-actions'}, {selector:'.map-bottom-bar'}] });
    }
  });
}

for(const viewport of VIEWPORTS) for(const theme of ['light','dark'] as const) test(`history map-first ${viewport.name} ${theme}`, async ({page}) => {
  test.setTimeout(90_000);
  await historyRoutes(page);
  await prepare(page,theme,'/history?event=dday',viewport);
  fs.mkdirSync(OUT,{recursive:true});
  await page.screenshot({path:path.join(OUT,`history-${viewport.name}-${theme}.png`)});
  await assertMapFirst(page,viewport.width,viewport.height,true);
  await page.getByLabel('Historical day',{exact:true}).selectOption('1944-06-06');
  await expect.poll(async()=>new Date(Number(await page.locator('[data-map-ready]').getAttribute('data-valid-ms'))).getUTCDate()).toBe(6);
});

test('phone day strip scrolls by touch and track drag seeks immediately', async ({page,context}) => {
  await prepare(page,'light','/',{width:390,height:844});
  const host=page.locator('.forecast-days');
  const box=(await host.boundingBox())!;
  const cdp=await context.newCDPSession(page);
  const y=box.y+10;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width-5,y}]});
  for(let i=1;i<=8;i++) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:box.x+box.width-5-i*8,y}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(()=>host.evaluate(el=>el.scrollLeft)).toBeGreaterThan(20);
  const slider=page.getByRole('slider',{name:'Forecast time'});
  const before=await slider.getAttribute('aria-valuenow');
  await page.mouse.move(box.x+10,box.y+box.height-4);await page.mouse.down();
  await expect(slider).not.toHaveAttribute('aria-valuenow',before!);
  await page.mouse.move(box.x+box.width-10,box.y+box.height-4);await page.mouse.up();
  await cdp.detach();
});
