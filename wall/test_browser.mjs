import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const baseURL = process.env.WALL_URL || 'http://127.0.0.1:8080/';
const browser = await chromium.launch({ headless: true, channel: 'chromium' }).catch(async () =>
  chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }));
try {
  for (const viewport of [{ width: 1024, height: 600 }, { width: 1280, height: 720 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const movieRequests = [];
    page.on('request', request => { if (request.url().includes('.mp4')) movieRequests.push(request.url()); });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.locator('.wall').waitFor({ state: 'visible' });
    const result = await page.evaluate(() => {
      const cards = document.querySelector('.cards').getBoundingClientRect();
      const controls = [...document.querySelectorAll('button,input')].every(el => {
        const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom <= innerHeight + 1;
      });
      return { overflow: document.documentElement.scrollHeight > innerHeight + 12, cardsReachable: cards.bottom <= innerHeight + 12, controls };
    });
    if (result.overflow) await page.screenshot({ path: `/private/tmp/isobar-wall-overflow-${viewport.width}x${viewport.height}.png` });
    assert.equal(result.overflow, false, `${viewport.width}x${viewport.height} overflow`);
    assert.equal(result.cardsReachable, true, `${viewport.width}x${viewport.height} cards clipped`);
    assert.equal(result.controls, true, `${viewport.width}x${viewport.height} control clipped`);
    await page.evaluate(() => document.body.style.fontSize = '200%');
    const enlarged = await page.evaluate(() => [...document.querySelectorAll('button,input')].every(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.bottom <= document.documentElement.scrollHeight + 1; }));
    assert.equal(enlarged, true, `${viewport.width}x${viewport.height} controls unreachable at 200% text`);
    const play = page.locator('#play');
    if (await play.isEnabled()) {
      await play.click();
      await page.waitForTimeout(120);
      await page.locator('#scrub').fill('1');
      await play.click();
      const beforeOffline = await page.locator('#time').textContent();
      assert.equal(movieRequests.length, 1, `${viewport.width}x${viewport.height} expected one movie request`);
      await page.context().setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
      await page.waitForTimeout(250);
      await page.locator('#scrub').fill('2');
      assert.notEqual(await page.locator('#time').textContent(), 'Preparing…', `${viewport.width}x${viewport.height} lost working clip offline`);
      assert.equal(movieRequests.length, 1, `${viewport.width}x${viewport.height} fetched movie again offline`);
      await page.context().setOffline(false);
    }
    await page.screenshot({ path: `/private/tmp/isobar-wall-${viewport.width}x${viewport.height}.png` });
    await page.close();
  }
} finally { await browser.close(); }
console.log('wall viewport QA passed');
