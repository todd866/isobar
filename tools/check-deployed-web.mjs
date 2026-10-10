#!/usr/bin/env node
/** Exercise the same public web contract against preview and production URLs.
 * Disposable headless browsers only. No build, deploy, signed-in profile or
 * external writes. Browser progress is discarded when each context closes.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { auditViewport } from './viewport-fit.mjs';

const require = createRequire(import.meta.url);
const urls = [];
let out = resolve('build/deployment-web');
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' && args[i + 1]) urls.push(args[++i]);
  else if (args[i] === '--out' && args[i + 1]) out = resolve(args[++i]);
  else if (args[i] === '--help') {
    console.log('Usage: PLAYWRIGHT_MODULE=/path/to/@playwright/test node tools/check-deployed-web.mjs --url https://preview.example --url https://isobar.md --out build/deployment-web');
    process.exit(0);
  } else { console.error(`Unknown or incomplete option: ${args[i]}`); process.exit(2); }
}
if (!urls.length || urls.length > 4) { console.error('Supply one to four explicit --url targets.'); process.exit(2); }
for (const value of urls) {
  let url;
  try { url = new URL(value); } catch { console.error('Invalid target URL.'); process.exit(2); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    console.error('Targets must be HTTP(S) origins without credentials, paths, queries or fragments.'); process.exit(2);
  }
}

const report = { checked_at: new Date().toISOString(), contract: 'isobar-web-behavior-v1', targets: [], ok: false };
const sizes = [
  ['laptop', 1280, 720], ['short-laptop', 1024, 600],
  ['phone', 390, 844], ['landscape-phone', 844, 390],
];
const check = (condition, detail) => { if (!condition) throw new Error(detail); };
mkdirSync(out, { recursive: true });
let browser;
try {
  const { chromium, expect } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
  check(chromium && expect, 'PLAYWRIGHT_MODULE must resolve @playwright/test (browser and assertions).');
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' }),
    args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  for (const [index, origin] of urls.entries()) {
    const target = { origin, checks: [], screenshots: [], renderers: [] };
    report.targets.push(target);
    const record = async (id, task) => {
      try { await task(); target.checks.push({ id, status: 'pass' }); }
      catch (error) { target.checks.push({ id, status: 'fail', detail: error.message }); }
    };
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ colorScheme: theme, viewport: { width: 1280, height: 720 }, extraHTTPHeaders: { 'isobar-test': '1' } });
      try {
        await context.addInitScript((mode) => localStorage.setItem('isobar-theme', mode), theme);
        const page = await context.newPage();
        page.setDefaultTimeout(12000);
        const pageErrors = [];
        const assetErrors = [];
        let offline = false;
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
          if (!offline && message.type() === 'error') pageErrors.push(`${message.text()} (${message.location().url || 'unknown source'})`);
        });
        const essential = (value) => {
          const url = new URL(value);
          return url.origin === new URL(origin).origin && (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/data/'));
        };
        page.on('response', (response) => {
          if (!offline && essential(response.url()) && response.status() >= 400) assetErrors.push(`${new URL(response.url()).pathname}: HTTP ${response.status()}`);
        });
        page.on('requestfailed', (request) => {
          // Leaving a page legitimately aborts its unfinished streaming frames.
          const reason = request.failure()?.errorText;
          if (!offline && essential(request.url()) && reason !== 'net::ERR_ABORTED') assetErrors.push(`${new URL(request.url()).pathname}: ${reason}`);
        });
        const open = async (path) => {
          const response = await page.goto(new URL(path, origin).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
          check(response?.ok(), `${path}: HTTP ${response?.status()}`);
        };
        const capture = async (name, primary, controls) => {
          await page.evaluate(async () => {
            await document.fonts.ready;
            await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          });
          const filename = `${index + 1}-${theme}-${name}.png`;
          await page.screenshot({ path: join(out, filename), fullPage: false });
          target.screenshots.push(filename);
          // Responsive desktop/mobile controls may coexist in the DOM. Check
          // the rendered variants, including any that are outside the viewport.
          // If all variants are hidden, retain the original selector so it fails.
          const rendered = async (items, prefix) => {
            const result = [];
            for (const [n, item] of items.entries()) {
              const target = typeof item === 'string' ? { selector: item } : item;
              const token = `${prefix}${n}`;
              const count = await page.evaluate(({ selector, token }) => {
                for (const old of document.querySelectorAll(`[data-coherence-target~="${token}"]`)) old.removeAttribute('data-coherence-target');
                const visible = [...document.querySelectorAll(selector)].filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
                for (const element of visible) element.setAttribute('data-coherence-target', token);
                return visible.length;
              }, { selector: target.selector, token });
              result.push({ ...target, label: target.selector, selector: count ? `[data-coherence-target="${token}"]` : target.selector });
            }
            return result;
          };
          const geometry = await auditViewport(page, { primary: await rendered(primary, 'p'), controls: await rendered(controls, 'c') });
          check(geometry.passed, geometry.failures.map((item) => `${item.label}: ${item.detail}`).join('; '));
        };
        const largeText = async (name, primary, controls) => {
          await page.setViewportSize({ width: 1280, height: 720 });
          await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
          try { await capture(`${name}-large-text`, primary, controls); }
          finally { await page.evaluate(() => { document.documentElement.style.fontSize = ''; }); }
        };
        await record(`${theme}.map.interaction`, async () => {
          await open('/');
          await expect(page.locator('[data-map-ready="true"]')).toBeVisible();
          const speeds = await page.locator('#playback-speed:visible option').evaluateAll((items) => items.map((item) => item.value));
          check(JSON.stringify(speeds) === JSON.stringify(['1', '2', '4', '8', '16', '32', '64', '128', '256']), 'Playback speed choices differ from the shared contract.');
          for (const lens of ['Pressure', 'Rain', 'Wind', 'Temp', 'Fly']) await expect(page.getByRole('radio', { name: lens, exact: true })).toBeEnabled();
          for (const lens of ['Kite', 'Surf']) await expect(page.getByRole('radio', { name: lens, exact: true })).toBeDisabled();
          await page.getByRole('radio', { name: 'Rain', exact: true }).click();
          await expect(page.getByRole('radio', { name: 'Rain', exact: true })).toHaveAttribute('aria-checked', 'true');
          await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
          await page.getByRole('radio', { name: 'Pressure', exact: true }).click();
          await page.getByRole('button', { name: 'Pause', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
          await page.getByRole('button', { name: 'Play', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
          const time = page.getByRole('slider', { name: 'Forecast time' });
          const before = await time.getAttribute('aria-valuenow');
          await expect.poll(() => time.getAttribute('aria-valuenow'), { timeout: 5000 }).not.toBe(before);
          const renderer = await page.evaluate(() => {
            const canvas = document.querySelector('[data-map-ready] canvas');
            const gl = canvas?.getContext('webgl2');
            const debug = gl?.getExtension('WEBGL_debug_renderer_info');
            return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unverified';
          });
          target.renderers.push(renderer);
        });
        for (const input of ['two-finger-scroll', 'ctrl-wheel', 'safari-pinch']) {
          await record(`${theme}.map.${input}`, async () => {
            const canvas = page.locator('canvas[aria-label^="Mean sea level pressure"]');
            await expect(canvas).toBeVisible();
            await canvas.press('Home');
            await page.getByRole('button', { name: 'Pause', exact: true }).click();
            // The visible timestamp follows the render clock at 140 ms; let
            // that last pre-pause sample settle before testing a held time.
            await page.waitForTimeout(200);
            const time = page.getByRole('slider', { name: 'Forecast time' });
            const held = await time.getAttribute('aria-valuenow');
            try {
              const result = await canvas.evaluate((element, kind) => {
                const stage = document.querySelector('[data-api="1"]');
                const api = stage?.chartApi;
                if (!api?.camera) throw new Error('Map camera diagnostics unavailable.');
                const rect = element.getBoundingClientRect();
                // MouseEvent coordinates are integer CSS pixels in Chromium.
                const clientX = Math.round(rect.left + rect.width * .6), clientY = Math.round(rect.top + rect.height * .4);
                const clip = { X: (clientX - rect.left) / rect.width * 2 - 1, Y: 1 - (clientY - rect.top) / rect.height * 2 };
                const before = { ...api.camera() };
                if (kind === 'safari-pinch') {
                  for (const [name, scale] of [['gesturestart', 1], ['gesturechange', 1.25], ['gesturechange', 2], ['gestureend', 2]]) {
                    element.dispatchEvent(Object.assign(new Event(name, { bubbles: true, cancelable: true }), { scale, clientX, clientY }));
                  }
                } else {
                  element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: kind === 'ctrl-wheel', deltaY: -Math.log(2) / .012, clientX, clientY }));
                }
                const after = { ...api.camera() };
                return { before, after, clip };
              }, input);
              check(Math.abs(result.after.halfWidth / result.before.halfWidth - .5) < .005, `${input} did not zoom the map 2×.`);
              for (const axis of ['X', 'Y']) {
                const half = axis === 'X' ? 'halfWidth' : 'halfHeight';
                const key = `center${axis}`;
                const error = (result.after[key] + result.clip[axis] * result.after[half]) - (result.before[key] + result.clip[axis] * result.before[half]);
                check(Math.abs(error) < 1e-6, `${input} moved the geographic point under the pinch.`);
              }
              check(await time.getAttribute('aria-valuenow') === held, 'Map gestures changed the forecast time.');
            } finally {
              await canvas.press('Home');
              const play = page.getByRole('button', { name: 'Play', exact: true });
              if (await play.isVisible()) await play.click();
            }
          });
        }
        await record(`${theme}.map.hold-drag-time`, async () => {
          const canvas = page.locator('canvas[aria-label^="Mean sea level pressure"]');
          const box = await canvas.boundingBox();
          check(box, 'Map has no pointer surface.');
          const time = page.getByRole('slider', { name: 'Forecast time' });
          const camera = () => page.evaluate(() => ({ ...document.querySelector('[data-api="1"]').chartApi.camera() }));
          try {
            await canvas.press('Home');
            await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
            await page.mouse.wheel(0, -50);
            const before = await camera();
            await page.mouse.down();
            await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
            await page.waitForTimeout(200);
            const held = await time.getAttribute('aria-valuenow');
            await page.mouse.move(box.x + box.width * .6, box.y + box.height * .5, { steps: 5 });
            await page.waitForTimeout(400);
            check(await time.getAttribute('aria-valuenow') === held, 'Click-and-hold did not freeze forecast time.');
            const after = await camera();
            check(Math.abs(after.centerX - before.centerX) > 1e-8 && Math.abs(after.halfWidth - before.halfWidth) < 1e-8, 'Click-drag did not pan without zooming.');
            await page.mouse.up();
            await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
            await expect.poll(() => time.getAttribute('aria-valuenow'), { timeout: 3000 }).not.toBe(held);
            const resumed = Number(await time.getAttribute('aria-valuenow'));
            check(Math.abs(resumed - Number(held)) < 5, 'Release jumped forecast time instead of resuming it.');
            await page.getByRole('button', { name: 'Pause', exact: true }).click();
            await page.waitForTimeout(200);
            const paused = await time.getAttribute('aria-valuenow');
            await canvas.click();
            await page.waitForTimeout(250);
            await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
            check(await time.getAttribute('aria-valuenow') === paused, 'Click changed an already paused forecast.');
          } finally {
            await page.mouse.up();
            await canvas.press('Home');
            const play = page.getByRole('button', { name: 'Play', exact: true });
            if (await play.isVisible()) await play.click();
          }
        });
        await record(`${theme}.map.place-home`, async () => {
          const manifest = await (await context.request.get(`${origin}/data/manifest.json`)).json();
          const place = page.getByRole('combobox', { name: 'Place', exact: true });
          const time = page.getByRole('slider', { name: 'Forecast time' });
          const original = await place.inputValue();
          await page.getByRole('button', { name: 'Pause', exact: true }).click();
          await page.waitForTimeout(200);
          const held = await time.getAttribute('aria-valuenow');
          try {
            for (const selected of manifest.places.slice(0, 2)) {
              await place.selectOption(selected.id);
              await page.waitForTimeout(150);
              if (manifest.grid.wraps_longitude) {
                const camera = await page.evaluate(() => ({ ...document.querySelector('[data-api="1"]').chartApi.camera() }));
                const longitudeError = ((camera.centerX - selected.lon + 540) % 360) - 180;
                check(Math.abs(longitudeError) < .01 && Math.abs(camera.centerY - selected.lat) < .01, 'Global map home does not follow the selected forecast place.');
              }
              check(await time.getAttribute('aria-valuenow') === held, 'Changing place reset forecast time.');
              await expect(page.getByRole('radio', { name: 'Pressure', exact: true })).toHaveAttribute('aria-checked', 'true');
            }
          } finally {
            await place.selectOption(original);
            await page.getByRole('button', { name: 'Play', exact: true }).click();
          }
        });
        for (const [size, width, height] of sizes) {
          await record(`${theme}.map.${size}`, async () => {
            await page.setViewportSize({ width, height });
            await expect(page.locator('[data-map-ready="true"]')).toBeVisible();
            await capture(`map-${size}`, ['[data-map-ready]'], ['#playback-speed', '[aria-label="Forecast time"]', '[data-lens-bar]']);
          });
        }
        await record(`${theme}.map.fly-panel`, async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.getByRole('radio', { name: 'Fly', exact: true }).click();
          await expect(page.locator('[data-fly-panel], aside[aria-label="Aerodrome"]').first()).toBeVisible();
          try { await capture('map-fly-phone', ['[data-map-ready]'], ['[data-lens-bar]', '[aria-label="Forecast time"]']); }
          finally { await page.getByRole('radio', { name: 'Pressure', exact: true }).click(); }
        });
        await record(`${theme}.map.large-text`, () => largeText('map', ['[data-map-ready]'], ['#playback-speed', '[data-lens-bar]']));
        await record(`${theme}.train.review-persistence-cached-offline`, async () => {
          await page.setViewportSize({ width: 1280, height: 720 });
          await open('/train');
          await expect(page.locator('.review-card')).toBeVisible();
          await page.locator('[data-mode]').selectOption('met');
          await page.locator('[data-reveal]').click();
          await expect(page.locator('[data-grade]')).toHaveCount(4);
          await page.locator('[data-grade="3"]').click();
          const saved = await page.evaluate(() => localStorage.getItem('isobar.training.v1'));
          check(saved !== null, 'Review progress was not saved.');
          await page.reload({ waitUntil: 'domcontentloaded' });
          await expect(page.locator('.review-card')).toBeVisible();
          check(await page.evaluate(() => localStorage.getItem('isobar.training.v1')) === saved, 'Progress changed across reload without a new answer.');
          await page.waitForLoadState('networkidle', { timeout: 10000 });
          offline = true;
          await context.setOffline(true);
          try {
            const sections = page.getByRole('navigation', { name: 'Training sections' });
            await sections.getByRole('button', { name: 'Profile', exact: true }).click();
            await expect(page.locator('.profile-card')).toBeVisible();
            await sections.getByRole('button', { name: 'Review', exact: true }).click();
            await expect(page.locator('.review-card')).toBeVisible();
          } finally { await context.setOffline(false); offline = false; }
        });
        for (const [size, width, height] of sizes) {
          await record(`${theme}.train.${size}`, async () => {
            await page.getByRole('navigation', { name: 'Training sections' }).getByRole('button', { name: 'Review', exact: true }).click();
            await expect(page.locator('.review-card')).toBeVisible();
            await page.setViewportSize({ width, height });
            await capture(`train-${size}`, [{ selector: '.trainer .stage', fit: 'visible', minHeight: 100 }], ['.trainer .sections', '.trainer .action']);
          });
        }
        await record(`${theme}.train.large-text`, () => largeText('train', [{ selector: '.trainer .stage', fit: 'visible', minHeight: 100 }], ['.trainer .sections', '.trainer .action']));
        await record(`${theme}.e6b.ready`, async () => {
          await open('/e6b');
          await expect(page.getByRole('region', { name: 'E6-B flight computer' })).toBeVisible();
          await expect(page.locator('.e6b input').first()).toBeVisible();
        });
        for (const [size, width, height] of sizes) {
          await record(`${theme}.e6b.${size}`, async () => {
            await page.setViewportSize({ width, height });
            await capture(`e6b-${size}`, ['.e6b-dial'], ['.e6b-task', '.e6b .strip']);
          });
        }
        await record(`${theme}.e6b.menu`, async () => {
          await page.setViewportSize({ width: 390, height: 844 });
          await page.locator('[data-e6b="more"]').click();
          await expect(page.locator('.e6b .more-panel')).toBeVisible();
          try { await capture('e6b-menu-phone', ['.e6b-dial'], ['.e6b-task', '.e6b .more-panel', '.e6b .readout']); }
          finally { await page.locator('[data-e6b="more"]').click(); }
        });
        await record(`${theme}.e6b.large-text`, () => largeText('e6b', ['.e6b-dial'], ['.e6b-task', '.e6b .strip']));
        await record(`${theme}.runtime`, async () => check(pageErrors.length === 0, pageErrors.join('; ')));
        await record(`${theme}.assets`, async () => check(assetErrors.length === 0, [...new Set(assetErrors)].join('; ')));
      } finally { await context.close(); }
    }
  }
  report.ok = report.targets.every((target) => target.checks.length > 0 && target.checks.every((item) => item.status === 'pass'));
} catch (error) {
  report.error = error.message;
} finally {
  if (browser) await browser.close();
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
for (const target of report.targets) {
  const failures = target.checks.filter((item) => item.status !== 'pass');
  console.log(`${failures.length ? 'FAIL' : 'PASS'} ${target.origin}: ${target.checks.length - failures.length}/${target.checks.length} checks`);
  for (const item of failures) console.log(`  ${item.id}: ${item.detail}`);
}
if (report.error) console.error(report.error);
console.log(`Evidence: ${join(out, 'report.json')}`);
process.exitCode = report.ok ? 0 : 1;
