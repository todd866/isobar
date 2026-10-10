import { expect, test, type Page } from '@playwright/test';

// Owner, 8 Oct: "the user needs to click this sequence, how are they gonna know
// to do that". A naive user who only ever acts on the one highlighted thing
// (data-next: a field, a button, or the glowing part of the instrument) must be
// able to finish problems of different skills. At every beat there is exactly one.
type Snap = { side: string; step: number | null };
const snap = (page: Page) => page.evaluate(() => (window as unknown as { e6b: { snapshot(): Snap } }).e6b.snapshot());

async function open(page: Page) {
  await page.addInitScript((theme) => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('isobar.e6b.hinted', '1'); localStorage.setItem('isobar-theme', theme); }, process.env.E6B_THEME ?? 'light');
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: (process.env.E6B_THEME as 'dark' | 'light' | undefined) ?? 'light' });
  await page.goto('/e6b');
  await page.waitForFunction(() => (window as unknown as { e6b?: unknown }).e6b);
  await page.waitForTimeout(300);
}

async function centre(page: Page) {
  return page.evaluate(() => {
    const svg = [...document.querySelectorAll<SVGSVGElement>('.e6b-svg')].find((s) => getComputedStyle(s).display !== 'none')!;
    const r = svg.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

const mid = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Act on the one highlighted affordance; return what was done. */
async function act(page: Page): Promise<string> {
  const next = page.locator('[data-next="true"]');
  await expect.poll(() => next.count(), { message: 'exactly one next action', timeout: 4000 }).toBe(1);
  const el = next.first();
  await expect(el).toBeVisible();
  const tag = await el.evaluate((e) => e.tagName.toLowerCase());
  if (tag === 'input') {
    // A naive estimate is any number; a reading is what the glowing read point shows.
    // Read the current beat atomically: the preceding problem's read marker
    // can disappear between a locator count and its attribute lookup.
    const value = await page.evaluate(() => document.querySelector('[data-read]')?.getAttribute('data-read')?.replace(/,/g, '') ?? '42');
    await el.fill(value);
    return `type ${value}`;
  }
  if (tag === 'button') { const label = (await el.innerText()).trim(); await el.click(); return `press ${label}`; }
  const gesture = await el.getAttribute('data-gesture');
  const from = mid((await el.boundingBox())!);
  if (gesture === 'tap') { await page.mouse.click(from.x, from.y); return 'tap'; }
  const to = mid((await page.locator('[data-drop="true"]').first().boundingBox())!);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (gesture === 'slide') {
    for (let i = 1; i <= 16; i++) await page.mouse.move(from.x, from.y + (to.y - from.y) * i / 16);
  } else {
    const c = await centre(page);
    const r = Math.hypot(from.x - c.x, from.y - c.y);
    const a0 = Math.atan2(from.x - c.x, -(from.y - c.y)), a1 = Math.atan2(to.x - c.x, -(to.y - c.y));
    const da = ((a1 - a0 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    const at = (a: number) => ({ x: c.x + r * Math.sin(a), y: c.y - r * Math.cos(a) });
    // First move past the 4 px slop in one step, then sweep to the mark.
    const jump = (Math.sign(da) || 1) * Math.min(Math.abs(da), 12 / r);
    let p = at(a0 + jump); await page.mouse.move(p.x, p.y);
    const n = Math.max(6, Math.ceil(Math.abs(da) * 40));
    for (let i = 1; i <= n; i++) { p = at(a0 + jump + (da - jump) * i / n); await page.mouse.move(p.x, p.y); }
  }
  await page.mouse.up();
  return gesture ?? 'drag';
}

for (const [device, width, height] of [['phone', 390, 844], ['desktop', 1440, 900]] as const) {
  test(`${device}: a naive user finishes three problems of different skills by following the glow`, async ({ browser }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: false });
    const page = await context.newPage();
    await open(page);
    const card = page.locator('.e6b-task .flow');
    const done: string[] = [];
    const sides = new Set<string>();
    let problems = 0;
    for (let beat = 0; beat < 120 && problems < 3; beat++) {
      await expect(card, 'one problem card').toHaveCount(1);
      await expect.poll(() => page.locator('[data-next="true"]').count(), { timeout: 4000 }).toBe(1);
      const line = (await card.locator('.fline').innerText()).trim();
      expect(line.length, 'the card says what to do').toBeGreaterThan(4);
      const before = (await card.locator('.fn').innerText()).trim();
      if (process.env.E6B_SHOTS) await page.screenshot({ path: `${process.env.E6B_SHOTS}/flow-${device}-${process.env.E6B_THEME ?? 'light'}-${String(beat).padStart(2, '0')}.png` });
      const what = await act(page);
      done.push(`${before} ${line} → ${what}`);
      sides.add((await snap(page)).side);
      await page.waitForTimeout(what.startsWith('press Next problem') ? 400 : 250);
      if (what.startsWith('press Next problem')) problems++;
    }
    console.log(done.join('\n'));
    expect(problems, 'three problems finished').toBe(3);
    expect([...sides].sort(), 'both sides of the computer used').toEqual(['computer', 'wind']);
    // Three different skills: time, fuel, wind.
    expect(done.filter((d) => /Next problem/.test(d)).length).toBe(3);
    await context.close();
  });
}

test('the estimate beat shows the method from the problem’s numbers, the move its why', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const card = page.locator('.e6b-task .flow');
  await expect(card.locator('.fline')).toHaveText('Estimate the time in your head, in minutes');
  await card.locator('[data-e6b="flow-input"]').fill('25');
  await card.locator('button[type="submit"]').click();
  await expect(card.locator('.fnote')).toHaveText('120 kt = 2 NM/min → 60 ÷ 2 = 30 min');
  await card.locator('[data-e6b="flow-next"]').click();
  await expect(card.locator('.fline')).toContainText('Hairline to 120');
  await expect(card.locator('.fwhy')).toContainText('hairline marks the number you start from');
  await expect(page.locator('.flow-src[data-next="true"]')).toHaveCount(1);
  await expect(page.locator('.flow-pointer')).toBeVisible();
  // Show me animates the move and the step ticks itself.
  await card.locator('[data-e6b="flow-show"]').click();
  await expect(card.locator('.fline')).toContainText('▲ (60) under 120', { timeout: 4000 });
  await expect(card.locator('.fwhy')).toContainText('▲ is 60 min: 120 over 60');
});

const handOn = (page: Page) => page.evaluate(() => {
  const hand = document.querySelector('.flow-hand') as HTMLElement | null;
  return !!hand && getComputedStyle(hand).display !== 'none';
});

/** The kind maybeGhost records: a turn of the hairline is its own gesture. */
const gestureKind = (page: Page) => page.evaluate(() => {
  const src = document.querySelector('.flow-src[data-gesture]');
  if (!src) return null;
  const gesture = src.getAttribute('data-gesture') || 'turn';
  if (gesture !== 'turn') return gesture;
  return src.closest('.flow-cur') ? 'hairline' : 'turn';
});

/** A hand that has just started. A leftover from the previous step is already well under way. */
const handFresh = (page: Page) => page.evaluate(() => {
  const hand = document.querySelector('.flow-hand') as HTMLElement | null;
  if (!hand || getComputedStyle(hand).display === 'none') return false;
  return hand.getAnimations().some((a) => a.playState === 'running' && Number(a.currentTime) < 500);
});

test('the ghost hand demonstrates each gesture once when motion is allowed', async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('isobar.e6b.hinted', '1');
    localStorage.setItem('isobar-theme', 'light');
  });
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'light' });
  await page.goto('/e6b');
  await page.waitForFunction(() => (window as unknown as { e6b?: unknown }).e6b);
  const seen: string[] = [];
  for (let beat = 0; beat < 80 && seen.length < 4; beat++) {
    await expect.poll(() => page.locator('[data-next="true"]').count(), { timeout: 8000 }).toBe(1);
    const kind = await gestureKind(page);
    if (kind && !seen.includes(kind)) {
      await expect.poll(() => handOn(page), { message: `ghost hand for ${kind}` }).toBe(true);
      if (!seen.length) await page.screenshot({ path: 'test-results/e6b-ghost-light.png' });
      seen.push(kind);
    } else if (kind) {
      expect(await handFresh(page), `no second ${kind} hand`).toBe(false);
    }
    const line = (await page.locator('.e6b-task .fline').innerText()).trim();
    // Show me completes the move. A fast drag would spin past the mark once motion is allowed.
    if (kind) {
      await page.locator('[data-e6b="flow-show"]').click();
      await expect(page.locator('.e6b-task .fline')).not.toHaveText(line, { timeout: 8000 });
    } else await act(page);
  }
  expect(seen, 'one appearance of each gesture').toEqual(['hairline', 'turn', 'tap', 'slide']);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('isobar.e6b.ghosted') ?? '[]'))).toEqual(seen);
  await context.close();

  const dark = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const night = await dark.newPage();
  await night.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('isobar.e6b.hinted', '1');
    localStorage.setItem('isobar-theme', 'dark');
  });
  await night.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  await night.goto('/e6b');
  await night.waitForFunction(() => (window as unknown as { e6b?: unknown }).e6b);
  await night.locator('[data-e6b="flow-input"]').fill('30');
  await night.locator('.e6b-task button[type="submit"]').click();
  await night.locator('[data-e6b="flow-next"]').click();
  await expect.poll(() => handOn(night), { message: 'ghost hand in the dark' }).toBe(true);
  await night.screenshot({ path: 'test-results/e6b-ghost-dark.png' });
  await dark.close();
});
