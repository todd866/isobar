#!/usr/bin/env node
// Reproducible, local-only Phase 1 capture; never drives an owner's window.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../training/node_modules/playwright-core/index.mjs';
import { assertViewport } from '../viewport-fit.mjs';
import { skies } from './fixtures.mjs';

const source = fileURLToPath(new URL('.', import.meta.url));
const output = resolve(source, '../../build/clouds'), root = resolve(output, 'preview');
mkdirSync(root, { recursive: true });
for (const name of ['index.html', 'sheet.mjs', 'render.mjs', 'rules.mjs', 'fixtures.mjs', 'assets']) cpSync(resolve(source, name), resolve(root, name), { recursive: true });
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.webp': 'image/webp' };
let browser;
const checks = [], errors = [], requests = [];
try {
  // Intercepted origin: no listening port and no network access required.
  const url = 'http://cloud-study.test';
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => requests.push(r.url()));
  await page.route('**/*', async route => {
    const request = new URL(route.request().url());
    if (request.origin !== url) throw new Error(`Unexpected external request: ${request.origin}`);
    const path = resolve(root, `.${request.pathname === '/' ? '/index.html' : request.pathname}`);
    if (!path.startsWith(root + sep)) return route.fulfill({ status: 403, body: '' });
    if (extname(path) === '.webp') await new Promise(r => setTimeout(r, 120));
    try { await route.fulfill({ contentType: types[extname(path)] || 'application/octet-stream', body: readFileSync(path) }); }
    catch { await route.fulfill({ status: 404, body: '' }); }
  });
  const ready = async () => { await page.waitForFunction(() => window.cloudStudy?.ready); await page.waitForTimeout(120); };
  const controls = [{ selector: '#theme', minWidth: 60, minHeight: 40 }, { selector: '#sky', minWidth: 100, minHeight: 40 }];
  for (const theme of ['light', 'dark']) {
    for (const [name, width, height] of [['desktop', 1280, 720], ['phone', 390, 844]]) {
      await page.setViewportSize({ width, height }); await page.goto(`${url}/?theme=${theme}`); await ready();
      checks.push(await assertViewport(page, { documentY: 'allow', primary: [{ selector: 'figure:first-child canvas', minWidth: 300, minHeight: 200 }], controls, screenshotPath: resolve(output, `${name}-${theme}-viewport.png`) }));
      await page.screenshot({ path: resolve(output, `${name}-${theme}-sheet.png`), fullPage: true });
      if (name === 'phone') {
        for (const sky of skies) for (const style of ['procedural', 'painted', 'flat']) {
          await page.locator(`figure[data-scene="${sky.id}"][data-style="${style}"]`).screenshot({ path: resolve(output, `${sky.id}-${style}-${theme}-phone.png`) });
        }
      }
    }
    await page.setViewportSize({ width: 1226, height: 720 }); await page.goto(`${url}/?theme=${theme}&contact=1`); await ready();
    await page.screenshot({ path: resolve(output, `comparison-${theme}-390.png`), fullPage: true });
  }
  // Decode first, then operate with all networking unavailable. Changing theme,
  // fixture, and viewport must reuse those three loaded images.
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${url}/`); await ready();
  const loadedRequests = requests.length; await page.context().setOffline(true);
  await page.locator('#theme').selectOption('dark'); await page.locator('#sky').selectOption('stratus-cirrus'); await ready();
  if (requests.length !== loadedRequests) throw new Error('prepared navigation made a new request');
  await page.locator('#sky').selectOption('all'); await ready();
  const cdp = await page.context().newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const performance = await page.evaluate(() => ({ draw: window.cloudStudy.benchmark(), preparation: window.cloudStudy.renders }));
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  for (const [name, width, height] of [['short-laptop', 1024, 600], ['phone-landscape', 844, 390]]) {
    await page.setViewportSize({ width, height }); await ready();
    checks.push(await assertViewport(page, { documentY: 'allow', primary: [{ selector: 'figure:first-child canvas', minWidth: 230, minHeight: 180 }], controls, screenshotPath: resolve(output, `${name}-dark-viewport.png`) }));
  }
  await page.setViewportSize({ width: 390, height: 844 }); await ready();
  await page.evaluate(() => { document.documentElement.style.fontSize = '28px'; });
  checks.push(await assertViewport(page, { documentY: 'allow', controls, screenshotPath: resolve(output, 'phone-dark-text-200.png') }));
  if (errors.length) throw new Error(errors.join('\n'));
  writeFileSync(resolve(output, 'validation.json'), JSON.stringify({ checks, errors, offlineNavigation: 'passed', imageRequestsPerLoad: 3,
    performanceScope: 'Headless desktop Chrome, 390 CSS pixels, CPU throttle 4x. Warm Canvas command submission only, NOT phone GPU/frame latency. Preparation is separate.', performance }, null, 2));
  console.log(`Cloud sheet: ${checks.length} viewport checks passed; offline navigation passed; 24 phone crops + 6 sheets. ${output}`);
} finally {
  await browser?.close();
}
