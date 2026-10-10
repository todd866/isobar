/** Exercise the built, offline worksheet flow in an isolated headless browser.
 * Optional VIEWPORT_HELPER points at the owner's reusable viewport-fit.mjs. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './browser.mjs';

const out = resolve(process.argv[2] ?? '../build/qa/training-worksheets');
mkdirSync(out, { recursive: true });
const helper = process.env.VIEWPORT_HELPER ? await import(pathToFileURL(process.env.VIEWPORT_HELPER).href) : null;
const url = new URL('../dist/index.html', import.meta.url).href;
const reports = [];
const browser = await launch();
if (!browser) throw new Error('Headless Chromium required');
try {
  for (const [width, height] of [[1280, 820], [390, 844], [1280, 720], [844, 390]]) {
    for (const theme of ['light', 'dark']) {
      const cards = height === 720 || width === 844
        ? ['cg-shift.r2', 'groundspeed.r4']
        : ['tas-mach.r1', 'etp.r1', 'pnr.r2', 'cg-shift.r2', 'met-level.r3', 'wind-component.r2', 'groundspeed.r4'];
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.context().setOffline(true);
      for (const card of cards) {
        const where = `${card}-${width}x${height}-${theme}`;
        await page.goto(`${url}?theme=${theme}&card=drill.${card}`);
        await page.waitForFunction(() => window.__TRAINING_READY);
        await page.locator('[data-numeric]').fill('9999');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.worksheet', { state: 'attached' });
        // Instrument support is a companion; phone learners return to the
        // retained worksheet before continuing the existing calculation flow.
        if (await page.locator('[data-support-return]').count()) await page.locator('[data-support-return]').click();
        if (helper) reports.push({ where, report: await helper.assertViewport(page, {
          primary: [{ selector: '.stage', minWidth: 280, minHeight: 150 }],
          controls: [{ selector: '[data-numeric-submit]', minHeight: 44 }, { selector: '.rail [data-page="profile"]', minWidth: 32, minHeight: 32 }],
        }) });
        const steps = await page.evaluate(() => window.__TRAINING_STEPS());
        await page.locator(`[data-step="${steps[0].id}"]`).fill('99999999');
        assert.equal(await page.locator('.ws-step.bad').count(), 1, where);
        assert.equal(await page.locator('.grades').count(), 0, where);
        for (const step of steps) {
          const field = page.locator(`[data-step="${step.id}"]`);
          await field.scrollIntoViewIfNeeded();
          const fits = await field.evaluate((node) => {
            const r = node.getBoundingClientRect(), s = document.querySelector('.stage').getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth && r.top >= s.top - 1 && r.bottom <= s.bottom + 1;
          });
          assert.ok(fits, `${where}: unreachable ${step.id}`);
          await field.fill(step.text);
        }
        await page.waitForSelector('.grades');
        assert.equal(await page.locator('.verdict.good').count(), 1, where);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, where);
        await page.keyboard.press('3');
        await page.waitForSelector('[data-numeric]');
        assert.match(await page.locator('.eyebrow').textContent(), /New numbers/, where);
        assert.equal(errors.length, 0, errors.join('\n'));
      }
      await page.close();
    }
  }
  // Enlarged worksheet text in a phone viewport; the worksheet intentionally
  // scrolls, while its Check and navigation controls stay available.
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${url}?theme=dark&card=drill.cg-shift.r2`);
  await page.waitForFunction(() => window.__TRAINING_READY);
  await page.locator('[data-numeric]').fill('9999');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.worksheet', { state: 'attached' });
  if (await page.locator('[data-support-return]').count()) await page.locator('[data-support-return]').click();
  await page.locator('[data-step]').last().fill('11.4');
  await page.evaluate(() => {
    for (const node of document.querySelectorAll('.review-card *')) {
      if (node.children.length === 0) node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * 2}px`;
    }
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '200% text: page overflow');
  assert.ok(await page.locator('.ws-label').evaluateAll((nodes) => nodes.every((node) => node.getBoundingClientRect().width >= 100)), '200% text: readable label width');
  assert.ok(await page.locator('.ws-step').evaluateAll((nodes) => nodes.every((node) => node.getBoundingClientRect().height < 500)), '200% text: words must wrap, not single letters');
  await page.locator('[data-step]').last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/cg-200pct-text-390x844-dark.png` });
  if (helper) reports.push({ where: '200% text', report: await helper.assertViewport(page, {
    primary: [{ selector: '.stage', minWidth: 280, minHeight: 150 }], controls: [{ selector: '[data-numeric-submit]', minHeight: 44 }],
  }) });
  await page.close();
} finally { await browser.close(); }
writeFileSync(`${out}/viewport-report.json`, JSON.stringify(reports, null, 2));
console.log(`Offline worksheet flows and viewport checks passed; ${reports.length} viewport reports in ${out}`);
