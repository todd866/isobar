import { expect, test } from '@playwright/test';

// Owner, 7 Oct: "dragging the outer ring should move it, not move the red line".
// Whatever is under the pointer moves; everything else stays put on screen.
type Snap = { theta: number; cursor: number; viewAngle: number };
const screen = (s: Snap) => ({ disc: ((s.theta + s.viewAngle) % 360 + 360) % 360, ring: ((s.viewAngle % 360) + 360) % 360, hairline: ((s.cursor + s.viewAngle) % 360 + 360) % 360 });
const near = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180) < 1;

test('dragging the black ring turns the ring only', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('isobar.e6b.hinted', '1'));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e6b');
  await page.waitForFunction(() => (window as unknown as { e6b?: unknown }).e6b);
  await page.waitForTimeout(400);
  const snap = () => page.evaluate(() => (window as unknown as { e6b: { snapshot(): Snap } }).e6b.snapshot());
  const geo = await page.evaluate(() => {
    const r = document.querySelector('.e6b svg')!.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, R: Math.min(r.width, r.height) / 2 };
  });
  const at = (deg: number, k: number) => ({ x: geo.cx + geo.R * k * Math.sin(deg * Math.PI / 180), y: geo.cy - geo.R * k * Math.cos(deg * Math.PI / 180) });
  const before = screen(await snap());
  let q = at(250, 0.88);
  await page.mouse.move(q.x, q.y);
  await page.mouse.down();
  for (let d = 250; d <= 280; d += 2) { q = at(d, 0.88); await page.mouse.move(q.x, q.y); }
  await page.mouse.up();
  const after = screen(await snap());
  expect(near(after.ring, before.ring + 30), `ring ${before.ring}→${after.ring}`).toBe(true);
  expect(near(after.disc, before.disc), 'disc stays put on screen').toBe(true);
  expect(near(after.hairline, before.hairline), 'hairline stays put on screen').toBe(true);
});
