import { expect, test, type Page } from '@playwright/test';

// Owner, 8 Oct: "the loupe should be draggable anywhere"; a first-time user on a
// phone "didn't understand how to use it" (the step sat far from Check); "I should
// be able to rotate the whole thing as a single unit".
type Goal = { kind: string; angle?: number; theta?: number; tol: number };
type Snap = { theta: number; cursor: number; viewAngle: number; step: number | null; met: boolean | null; stage: string; targets: Goal[] };
type E6B = { snapshot(): Snap; openExercise(id: string, stage: string): void; setMode(m: string): void };
const turn = (d: number) => ((d % 360) + 540) % 360 - 180;
const snap = (page: Page) => page.evaluate(() => (window as unknown as { e6b: E6B }).e6b.snapshot());

async function open(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => localStorage.setItem('isobar.e6b.hinted', '1'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e6b');
  await page.waitForFunction(() => (window as unknown as { e6b?: unknown }).e6b);
  await page.waitForTimeout(300);
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const r = document.querySelector('.e6b-svg')!.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: Math.min(r.width, r.height) / 2 };
  });
}

/** Drag along a circle about the instrument centre from screen angle a0 to a1.
 * With `jump`, the first move goes straight to a0 + jump: past the 4 px slop in
 * one step, so none of the turn is lost to it; the drag then sweeps to a1. */
async function arcDrag(page: Page, k: number, a0: number, a1: number, jump = 0) {
  const g = await geometry(page);
  const at = (deg: number) => ({ x: g.cx + g.R * k * Math.sin(deg * Math.PI / 180), y: g.cy - g.R * k * Math.cos(deg * Math.PI / 180) });
  let p = at(a0);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  if (jump) { p = at(a0 + jump); await page.mouse.move(p.x, p.y); a0 += jump; }
  const n = Math.max(8, Math.ceil(Math.abs(a1 - a0)));
  for (let i = 1; i <= n; i++) { p = at(a0 + (a1 - a0) * i / n); await page.mouse.move(p.x, p.y); }
  await page.mouse.up();
  await page.waitForTimeout(60);
}

test('phone: a first-time user completes Time en route 1 with the visible controls', async ({ page }) => {
  await open(page, 390, 844);
  await page.evaluate(() => (window as unknown as { e6b: E6B }).e6b.openExercise('time-1', 'guided'));
  await page.waitForTimeout(300);
  const card = page.locator('.e6b-task');
  const next = card.locator('[data-e6b="step-next"]');
  const back = card.locator('[data-e6b="step-back"]');
  const line = card.locator('.step');
  for (let i = 0; i < 7; i++) {
    const s = await snap(page);
    expect(s.step, `on step ${i + 1}`).toBe(i);
    await expect(card.locator('.stepper .sn')).toHaveText(`${i + 1}/7`);
    await expect(next, 'the Next control is on screen').toBeVisible();
    await expect(back).toBeVisible();
    const text = (await line.innerText()).replace('✓', '').trim();
    expect(text, `step ${i + 1} names an action`).toMatch(/^(Estimate|Move|Turn|Read|Put)\b/);
    // One line on a 390 px phone: the step reads as a single instruction.
    const lines = await line.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
    expect(lines, `"${text}" fits on one line`).toBe(1);
    const entry = card.locator('[data-e6b="procedure-entry"]');
    if (i === 0) expect(text).toBe('Estimate the time in minutes, then Check');
    if (await entry.count()) {
      // The entry sits directly under the step it belongs to.
      const lb = (await line.boundingBox())!, eb = (await entry.boundingBox())!;
      expect(eb.y - (lb.y + lb.height), 'entry right under the step').toBeLessThan(24);
      await entry.fill('30');
      await card.locator('button[type="submit"]').click();
      await page.waitForTimeout(150);
      if (i < 6) { expect((await snap(page)).step, 'Check moves on to the next step').toBe(i + 1); continue; }
      expect((await snap(page)).met).toBe(true);
      await expect(next).toBeEnabled();
      await next.click();
      break;
    }
    for (let tries = 0; tries < 4 && !(await snap(page)).met; tries++) {
      const now = await snap(page);
      const cursor = now.targets.find((g) => g.kind === 'cursor' && Math.abs(turn(g.angle! - now.cursor)) > g.tol);
      const disc = now.targets.find((g) => g.kind === 'disc' && Math.abs(turn(g.theta! - now.theta)) > g.tol);
      if (cursor) {
        // The red handle at the rim.
        const a0 = now.cursor + now.viewAngle;
        await arcDrag(page, 1531 / 1580, a0, a0 + turn(cursor.angle! - now.cursor));
      } else if (disc) {
        // Grab the blue disc a quarter turn away from the hairline.
        const a0 = now.cursor + now.viewAngle + 90;
        await arcDrag(page, 0.6, a0, a0 + turn(disc.theta! - now.theta), 12);
      } else await page.waitForTimeout(200);
    }
    expect((await snap(page)).met, `step ${i + 1} done on the instrument: ${JSON.stringify(await snap(page))}`).toBe(true);
    await expect(line).toHaveClass(/ok/);
    await expect(next).toBeEnabled();
    await next.click();
    await page.waitForTimeout(150);
  }
  expect((await snap(page)).stage, 'all seven steps lead to Solo').toBe('solo');
});

test('phone: ‹ goes back a step and › waits for the step to be done', async ({ page }) => {
  await open(page, 390, 844);
  await page.evaluate(() => (window as unknown as { e6b: E6B }).e6b.openExercise('time-1', 'guided'));
  await page.waitForTimeout(300);
  const card = page.locator('.e6b-task');
  await expect(card.locator('[data-e6b="step-next"]')).toBeDisabled();
  await expect(card.locator('[data-e6b="step-back"]')).toBeDisabled();
  await card.locator('[data-e6b="procedure-entry"]').fill('30');
  await card.locator('button[type="submit"]').click();
  await expect(card.locator('.stepper .sn')).toHaveText('2/7');
  await card.locator('[data-e6b="step-back"]').click();
  await expect(card.locator('.stepper .sn')).toHaveText('1/7');
  await expect(card.locator('[data-e6b="step-next"]'), 'a checked step can be passed again').toBeEnabled();
  // The coach bubble no longer repeats the step at the bottom.
  await expect(page.locator('.e6b-coach .bubble')).toHaveCount(0);
});

async function loupeState(page: Page) {
  return page.evaluate(() => {
    const lens = document.querySelector<HTMLElement>('.e6b-loupe')!;
    const box = lens.getBoundingClientRect();
    const dial = document.querySelector('.e6b')!.getBoundingClientRect();
    const svg = document.querySelector<SVGSVGElement>('.e6b-svg')!;
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    const pt = new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM()!.inverse());
    const vb = lens.querySelector('svg')!.viewBox.baseVal;
    return { cx, cy, w: box.width, under: { x: pt.x, y: pt.y }, shows: { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 },
      inside: box.left >= dial.left - 0.5 && box.top >= dial.top - 0.5 && box.right <= dial.right + 0.5 && box.bottom <= dial.bottom + 0.5,
      onScreen: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
  });
}

async function dragLoupe(page: Page, to: { x: number; y: number }) {
  const s = await loupeState(page);
  await page.mouse.move(s.cx, s.cy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(s.cx + (to.x - s.cx) * i / 20, s.cy + (to.y - s.cy) * i / 20);
  await page.mouse.up();
  await page.waitForTimeout(80);
}

test('desktop: the loupe drags anywhere, stays put and magnifies what is under it', async ({ page }) => {
  await open(page, 1440, 900);
  await page.evaluate(() => (window as unknown as { e6b: E6B }).e6b.setMode('free'));
  await page.waitForTimeout(200);
  const g = await geometry(page);
  const start = await loupeState(page);
  const before = await snap(page);
  for (const corner of [{ x: g.cx - g.R * 0.7, y: g.cy - g.R * 0.7 }, { x: g.cx + g.R * 0.75, y: g.cy + g.R * 0.75 }]) {
    await dragLoupe(page, corner);
    const s = await loupeState(page);
    expect(Math.hypot(s.cx - corner.x, s.cy - corner.y), 'dropped where released').toBeLessThan(3);
    expect(Math.hypot(s.cx - start.cx, s.cy - start.cy), 'moved').toBeGreaterThan(100);
    expect(s.inside, 'inside the instrument area').toBe(true);
    expect(Math.hypot(s.shows.x - s.under.x, s.shows.y - s.under.y), 'magnifies the point under its centre').toBeLessThan(4);
    // Turning the disc keeps the lens where it was dropped.
    await arcDrag(page, 0.5, 200, 230);
    const after = await loupeState(page);
    expect(Math.hypot(after.cx - s.cx, after.cy - s.cy), 'stays put while the disc turns').toBeLessThan(1);
  }
  const moved = await snap(page);
  expect(Math.abs(turn(moved.cursor - before.cursor)), 'dragging the loupe never moves the hairline').toBeLessThan(0.01);
  // Far past the edge: it stops at the edge of the instrument area, whole and on screen.
  await dragLoupe(page, { x: g.cx + g.R * 3, y: g.cy - g.R * 3 });
  const edge = await loupeState(page);
  expect(edge.inside && edge.onScreen, 'clamped inside the instrument area').toBe(true);
  expect(edge.cx - g.cx, 'parked off the dial').toBeGreaterThan(g.R);
  expect(Math.hypot(edge.shows.x - edge.under.x, edge.shows.y - edge.under.y)).toBeLessThan(4);
  // Kept for the session.
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { e6b?: unknown }).e6b);
  await page.waitForTimeout(300);
  const back = await loupeState(page);
  expect(Math.hypot(back.cx - edge.cx, back.cy - edge.cy), 'same place after a reload').toBeLessThan(3);
});

test('phone: the loupe, when switched on, drags and stays on screen', async ({ page }) => {
  await open(page, 390, 844);
  await page.locator('[data-e6b="more"]').click();
  await page.locator('[data-e6b="loupe"]').click();
  await page.waitForTimeout(150);
  await expect(page.locator('.e6b-loupe')).toBeVisible();
  for (const to of [{ x: 0, y: 0 }, { x: 390, y: 844 }]) {
    await dragLoupe(page, to);
    const s = await loupeState(page);
    expect(s.onScreen && s.inside, `on screen after a drag toward ${to.x},${to.y}`).toBe(true);
    expect(Math.hypot(s.shows.x - s.under.x, s.shows.y - s.under.y)).toBeLessThan(4);
  }
});

test('the whole computer turns as one piece and the View dial sets it upright', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  const page = await context.newPage();
  await open(page, 1440, 900);
  await page.evaluate(() => (window as unknown as { e6b: E6B }).e6b.setMode('free'));
  const readout = () => page.locator('.e6b-readpanel').innerText();
  const g = await geometry(page);
  const s0 = await snap(page);
  const r0 = await readout();
  const same = async (label: string) => {
    const s = await snap(page);
    expect(Math.abs(turn(s.theta - s0.theta)), `${label}: disc setting unchanged`).toBeLessThan(0.01);
    expect(Math.abs(turn(s.cursor - s0.cursor)), `${label}: hairline setting unchanged`).toBeLessThan(0.01);
    expect(await readout(), `${label}: reading unchanged`).toBe(r0);
    return s;
  };

  // Two fingers twisting on the instrument.
  const cdp = await context.newCDPSession(page);
  const finger = (a: number, id: number) => ({ x: g.cx + 0.5 * g.R * Math.sin(a * Math.PI / 180), y: g.cy - 0.5 * g.R * Math.cos(a * Math.PI / 180), id });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger(0, 1), finger(180, 2)] });
  for (let d = 2; d <= 40; d += 2) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger(d, 1), finger(180 + d, 2)] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(100);
  let s = await same('two-finger twist');
  expect(Math.abs(turn(s.viewAngle - s0.viewAngle - 40)), `turned 40° (${s.viewAngle})`).toBeLessThan(2);

  // A mouse drag on the bare rim outside the printed face (1520–1580 units).
  const v1 = s.viewAngle;
  await arcDrag(page, 0.985, 200, 214, 4);
  s = await same('margin drag');
  expect(Math.abs(turn(s.viewAngle - v1 - 14)), `turned 14° (${s.viewAngle})`).toBeLessThan(1.5);

  // Scroll / two-finger swipe over the dial: the whole computer turns, down and right clockwise.
  await page.mouse.move(g.cx - g.R * 0.35, g.cy + g.R * 0.2);
  const v3 = s.viewAngle;
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 40);
  for (let i = 0; i < 2; i++) await page.mouse.wheel(40, 0);
  await page.waitForTimeout(250);
  s = await same('wheel');
  expect(Math.abs(turn(s.viewAngle - v3 - 70)), `wheel turned 70° clockwise (${v3} → ${s.viewAngle})`).toBeLessThan(0.5);
  // Off the dial the wheel is the page's: not cancelled.
  const prevented = async (x: number, y: number) => {
    await page.evaluate(() => { const w = window as unknown as { __wheel: boolean[] }; w.__wheel = []; window.addEventListener('wheel', (e) => w.__wheel.push(e.defaultPrevented), { once: true }); });
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(50);
    return page.evaluate(() => (window as unknown as { __wheel: boolean[] }).__wheel[0]);
  };
  expect(await prevented(g.cx - g.R * 0.35, g.cy + g.R * 0.2), 'over the dial the instrument takes the scroll').toBe(true);
  const strip = (await page.locator('.e6b-strip').boundingBox())!;
  expect(await prevented(strip.x + strip.width / 2, strip.y + strip.height / 2), 'elsewhere the page scrolls').toBe(false);
  s = await same('wheel off the dial');

  // The View dial: drag turns the whole computer, a tap sets it upright.
  const knob = page.locator('.e6b-view-knob');
  await expect(knob).toBeVisible();
  const kb = (await knob.boundingBox())!;
  const v2 = s.viewAngle;
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  await arcStep(page, g, kb, 25);
  await page.mouse.up();
  s = await same('View dial drag');
  expect(Math.abs(turn(s.viewAngle - v2)), 'View dial turned it').toBeGreaterThan(5);
  await knob.click();
  await page.waitForTimeout(400);
  s = await same('upright');
  expect(Math.abs(turn(s.viewAngle)), 'tap sets it upright').toBeLessThan(0.5);
  await context.close();
});

/** Move the held pointer from the knob round the instrument centre by `deg`. */
async function arcStep(page: Page, g: { cx: number; cy: number }, kb: { x: number; y: number; width: number; height: number }, deg: number) {
  const x0 = kb.x + kb.width / 2 - g.cx, y0 = kb.y + kb.height / 2 - g.cy;
  for (let i = 1; i <= 20; i++) {
    const a = (deg * i / 20) * Math.PI / 180;
    await page.mouse.move(g.cx + x0 * Math.cos(a) - y0 * Math.sin(a), g.cy + x0 * Math.sin(a) + y0 * Math.cos(a));
  }
}

/** Dark ink pixels in a circle of radius r (CSS px) about (x, y), from a real screenshot. */
async function ink(page: Page, x: number, y: number, r: number): Promise<number> {
  const png = await page.screenshot({ clip: { x: x - r, y: y - r, width: 2 * r, height: 2 * r } });
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      const dx = x - c.width / 2, dy = y - c.height / 2;
      if (dx * dx + dy * dy > (c.width / 2) ** 2) continue;
      const i = (y * c.width + x) * 4;
      if (0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2] < 110) n++;
    }
    return n / (c.width * c.height);
  }, png.toString('base64'));
}

/** What the lens shows against what is under it: the share of dark ink in the
 * lens (inner 80 %) and in the same patch of the dial itself, photographed with
 * the lens hidden. A lens that renders blank over printed ink fails this. */
async function lensVsDial(page: Page) {
  const s = await loupeState(page);
  const power = await page.evaluate(() => {
    const lens = document.querySelector<HTMLElement>('.e6b-loupe')!;
    const vb = lens.querySelector('svg')!.viewBox.baseVal;
    const unit = document.querySelector<SVGSVGElement>('.e6b-svg')!.getScreenCTM()!.a;
    return lens.getBoundingClientRect().width / (vb.width * unit);
  });
  const lens = await ink(page, s.cx, s.cy, s.w * 0.4);
  await page.evaluate(() => { document.querySelector<HTMLElement>('.e6b-loupe')!.style.visibility = 'hidden'; });
  const dial = await ink(page, s.cx, s.cy, (s.w * 0.4) / power);
  await page.evaluate(() => { document.querySelector<HTMLElement>('.e6b-loupe')!.style.visibility = ''; });
  return { lens, dial, power };
}

// Owner, 8 Oct (2000×1290 window): the loupe got stuck at the dial's edge and
// showed nothing there. It parks anywhere over the instrument's area, shows the
// face's ink wherever its centre is over print, and the desk off the face.
for (const [w, h, dpr] of [[2000, 1290, 2], [1440, 900, 1]] as const) {
  test(`desktop ${w}×${h}: the loupe parks off the dial on every side and always shows what is under it`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    await open(page, w, h);
    await page.evaluate(() => (window as unknown as { e6b: E6B }).e6b.setMode('free'));
    await page.waitForTimeout(200);
    const g = await geometry(page);
    const area = (await page.locator('.e6b').boundingBox())!;
    const agrees = async (label: string) => {
      const m = await lensVsDial(page);
      expect(m.power, `${label}: magnifies`).toBeGreaterThan(1.5);
      if (m.dial > 0.02) expect(m.lens, `${label}: print under it (${m.dial.toFixed(3)}), so ink in the lens`).toBeGreaterThan(m.dial * 0.35);
      if (m.dial < 0.002) expect(m.lens, `${label}: nothing under it, so the lens is clear`).toBeLessThan(0.02);
      return m;
    };
    expect((await agrees('at the hairline crossing')).lens, 'ink at the hairline crossing').toBeGreaterThan(0.02);
    // Round the face over printed scales, then off each side and back.
    const at = (deg: number, k: number) => ({ x: g.cx + g.R * k * Math.sin(deg * Math.PI / 180), y: g.cy - g.R * k * Math.cos(deg * Math.PI / 180) });
    let printed = 0;
    for (const deg of [20, 75, 130, 200, 250, 320]) for (const k of [0.62, 0.72, 0.82]) {
      await dragLoupe(page, at(deg, k));
      const s = await loupeState(page);
      expect(Math.hypot(s.cx - at(deg, k).x, s.cy - at(deg, k).y), `dropped at ${deg}°`).toBeLessThan(3);
      expect(Math.hypot(s.shows.x - s.under.x, s.shows.y - s.under.y), 'magnifies the point under its centre').toBeLessThan(4);
      if ((await agrees(`${deg}° × ${k}`)).dial > 0.02) printed++;
    }
    expect(printed, 'some of those places were over print').toBeGreaterThan(6);
    const sides = { left: { x: area.x + 40, y: g.cy }, right: { x: area.x + area.width - 40, y: g.cy }, top: { x: g.cx + g.R * 1.2, y: area.y + 40 }, bottom: { x: g.cx + g.R * 1.2, y: area.y + area.height - 40 } };
    for (const [side, to] of Object.entries(sides)) {
      await dragLoupe(page, to);
      const s = await loupeState(page);
      expect(s.inside && s.onScreen, `${side}: whole and on screen`).toBe(true);
      if (side === 'left' || side === 'right') expect(Math.abs(s.cx - g.cx), `${side}: parked off the dial`).toBeGreaterThan(g.R + s.w / 2 - 2);
      await agrees(side);
      await dragLoupe(page, at(0, 0.72));
      await agrees(`back from the ${side}`);
    }
    // Turned and zoomed, it still shows what is under it.
    await page.evaluate(() => (window as unknown as { e6b: { setViewRotation(a: number): void } }).e6b.setViewRotation(40));
    await page.locator('.e6b-svg:not(.e6b-wind)').focus();
    await page.keyboard.press('+');
    await page.waitForTimeout(700);
    const zg = await geometry(page);
    await dragLoupe(page, { x: zg.cx + zg.R * 0.2, y: zg.cy - zg.R * 0.5 });
    const z = await loupeState(page);
    expect(Math.hypot(z.shows.x - z.under.x, z.shows.y - z.under.y), 'zoomed and turned: magnifies the point under it').toBeLessThan(4);
    await agrees('zoomed and turned');
    await context.close();
  });
}
