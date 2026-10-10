import { devices, expect, test, type Page } from '@playwright/test';

// The E6-B on an iPhone, in WebKit: the instrument is the page. Nothing sits
// under the tab bar, nothing covers the problem line, no label is clipped, and
// a finger on the instrument works the instrument instead of scrolling the page.
const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 15'];
test.use({ ...iphone, browserName: 'webkit', launchOptions: {} });

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

async function open(page: Page, theme: 'light' | 'dark', state: string) {
  await page.addInitScript((t) => {
    localStorage.setItem('isobar-theme', t);
    localStorage.setItem('isobar.e6b.hinted', '1');
  }, theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
  await page.goto('/e6b');
  await page.waitForFunction(() => (window as unknown as { e6b?: unknown }).e6b);
  await page.evaluate((s) => {
    const h = (window as unknown as { e6b: { openExercise(id: string, stage: string): void } }).e6b;
    if (s === 'watch') h.openExercise('time-2', 'watch');
    if (s === 'guided') h.openExercise('time-2', 'guided');
    if (s === 'solo') h.openExercise('time-2', 'solo');
    if (s === 'wind') h.openExercise('windhdg-1', 'guided');
  }, state);
  await page.waitForTimeout(400);
}

async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, selector).not.toBeNull();
  return b!;
}

async function noClipping(page: Page, label: string) {
  const clipped = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.e6b *, nav[aria-label="Main navigation"] *')) {
      if (el.closest('svg') || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own) continue;
      if (el.textContent!.includes('…')) out.push(`ellipsis: ${el.textContent}`);
      if (cs.textOverflow === 'ellipsis') out.push(`text-overflow: ${el.textContent}`);
      if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) out.push(`clipped x: ${el.textContent}`);
      if (cs.overflowY !== 'visible' && cs.overflowY !== 'auto' && el.scrollHeight > el.clientHeight + 1) out.push(`clipped y: ${el.textContent}`);
    }
    return out;
  });
  expect(clipped, label).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  for (const state of ['first', 'watch', 'guided', 'solo', 'wind']) {
    test(`iPhone 15 ${theme} ${state}: instrument first, nothing under the tab bar or over the task`, async ({ page }) => {
      await open(page, theme, state);
      const vw = page.viewportSize()!.width;
      const tab = await box(page, 'nav[aria-label="Main navigation"] >> visible=true');
      const readout = await box(page, '.e6b .dock .readout');
      const dock = await box(page, '.e6b .strip.dock');
      expect(readout.y + readout.height, 'readings above the tab bar').toBeLessThanOrEqual(tab.y);
      expect(dock.y + dock.height, 'dock above the tab bar').toBeLessThanOrEqual(tab.y);
      for (const b of await page.locator('.e6b button:visible, .e6b input:visible').all()) {
        const r = (await b.boundingBox())!;
        if (r.y > tab.y) continue;
        expect(r.height, `${await b.textContent()} tap target`).toBeGreaterThanOrEqual(44);
      }
      const svg = await box(page, '.e6b-dial svg.e6b-svg:visible');
      expect(svg.width / vw, 'disc width').toBeGreaterThanOrEqual(0.88);
      expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), 'no page scroll').toBeLessThanOrEqual(1);
      const task = page.locator('.e6b-task .stem, .e6b-task .e6b-next').first();
      if (await task.count()) {
        const t = (await task.boundingBox())!;
        for (const other of ['.e6b-dial svg:visible', '.e6b-coach:visible', '.e6b .strip.dock', '.e6b .readout']) {
          for (const o of await page.locator(other).all()) expect(overlaps(t, (await o.boundingBox())!), `${other} over the task`).toBe(false);
        }
        expect(overlaps(t, tab)).toBe(false);
      }
      await noClipping(page, `${theme} ${state}`);
      // The Menu rises from the dock and stops short of the problem line.
      await page.locator('.e6b [data-e6b="more"]').click();
      const panel = await box(page, '.e6b .more-panel');
      if (await task.count()) expect(overlaps((await task.boundingBox())!, panel), 'menu over the task').toBe(false);
      expect(overlaps(panel, readout), 'menu over the readings').toBe(false);
      await noClipping(page, `${theme} ${state} menu`);
      await expect(page.locator('.e6b .more-panel').getByText('Upright', { exact: true })).toBeVisible();
    });
  }
}

test('iPhone 15: touch turns the disc and the view, never the page', async ({ page }) => {
  await open(page, 'light', 'guided');
  expect(await page.locator('.e6b-svg').first().evaluate((el) => getComputedStyle(el).touchAction)).toBe('none');
  expect(await page.evaluate(() => getComputedStyle(document.body).touchAction)).not.toBe('none');
  const result = await page.evaluate(async () => {
    const h = (window as unknown as { e6b: { snapshot(): { theta: number; viewAngle: number } } }).e6b;
    const svg = document.querySelector<SVGSVGElement>('.e6b-svg')!;
    const r = svg.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, rad = r.width * 0.25;
    const fire = (type: string, id: number, x: number, y: number) => svg.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    const at = (deg: number, k = rad) => [cx + k * Math.sin(deg * Math.PI / 180), cy - k * Math.cos(deg * Math.PI / 180)] as const;
    const before = h.snapshot();
    // One finger on blue, round the rim: the disc turns.
    fire('pointerdown', 1, ...at(100)); for (let a = 100; a <= 130; a += 5) fire('pointermove', 1, ...at(a)); fire('pointerup', 1, ...at(130));
    const disc = h.snapshot();
    // Two fingers twist: the whole computer turns, the setting stays.
    fire('pointerdown', 1, ...at(90, rad * 0.5)); fire('pointerdown', 2, ...at(270, rad * 0.5));
    for (let a = 0; a <= 30; a += 5) { fire('pointermove', 1, ...at(90 + a, rad * 0.5)); fire('pointermove', 2, ...at(270 + a, rad * 0.5)); }
    fire('pointerup', 1, ...at(120, rad * 0.5)); fire('pointerup', 2, ...at(300, rad * 0.5));
    const twist = h.snapshot();
    let held = false;
    try {
      const move = new TouchEvent('touchmove', { cancelable: true, bubbles: true });
      svg.dispatchEvent(move); held = move.defaultPrevented;
    } catch { held = true; /* no TouchEvent constructor: touch-action alone holds the page */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { before, disc, twist, held, scrollY };
  });
  expect(Math.abs(result.disc.theta - result.before.theta), 'disc turned').toBeGreaterThan(5);
  expect(Math.abs(result.twist.viewAngle - result.disc.viewAngle), 'view turned').toBeGreaterThan(5);
  expect(result.twist.theta, 'two fingers leave the disc setting').toBeCloseTo(result.disc.theta, 3);
  expect(result.held, 'touchmove held on the instrument').toBe(true);
  expect(result.scrollY, 'page did not scroll').toBe(0);
});

test('iPhone 15: teaching flow wording is for fingers, not keys', async ({ page }) => {
  await open(page, 'light', 'first');
  const flow = await page.locator('.e6b-task .flow').innerText();
  expect(flow, 'the one next action').not.toMatch(/⌥|scroll|Shift/);
  await page.locator('.e6b [data-e6b="more"]').click();
  await page.locator('.e6b [data-e6b="how"]').click();
  const inputs = page.locator('.e6b .how .inputs');
  await expect(inputs).toBeVisible();
  const text = await inputs.innerText();
  expect(text).toMatch(/one finger/i);
  expect(text).toMatch(/two-finger/i);
  expect(text).not.toMatch(/⌥|scroll|Shift/);
});
