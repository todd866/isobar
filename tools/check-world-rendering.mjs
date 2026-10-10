#!/usr/bin/env node
/** Capture world-map cases in disposable headless browsers.
 * Images are evidence for manual visual review; this tool never claims visual pass.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
let origin = null;
let out = resolve('build/world-rendering');
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--url' && args[i + 1]) origin = args[++i];
  else if (args[i] === '--out' && args[i + 1]) out = resolve(args[++i]);
  else if (args[i] === '--help') {
    console.log('Usage: PLAYWRIGHT_MODULE=/path/to/@playwright/test node tools/check-world-rendering.mjs --url https://isobar.md --out build/world-rendering');
    process.exit(0);
  } else { console.error(`Unknown or incomplete option: ${args[i]}`); process.exit(2); }
}
try {
  const parsed = new URL(origin || '');
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('URL must be an HTTP(S) origin without credentials, path, query or fragment');
  origin = parsed.origin;
} catch (error) { console.error(error.message); process.exit(2); }

const report = { checked_at: new Date().toISOString(), origin, contract: 'isobar-world-rendering-evidence-v1', manual_visual_review_required: true, manifest: {}, renderers: [], captures: [], checks: [], errors: [], ok: false };
const check = (condition, detail) => { if (!condition) throw new Error(detail); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
mkdirSync(out, { recursive: true });
let browser;
try {
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' }), args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  for (const mode of ['webgl', 'canvas2d', 'webgl-init-failed']) {
    const fallback = mode !== 'webgl';
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', extraHTTPHeaders: { 'isobar-test': '1' } });
    try {
      if (mode === 'webgl-init-failed') await context.addInitScript(() => {
        WebGL2RenderingContext.prototype.createProgram = () => null;
      });
      if (mode === 'canvas2d') await context.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
          if (kind === 'webgl' || kind === 'webgl2') return null;
          return original.call(this, kind, ...rest);
        };
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => report.errors.push({ mode: mode, detail: error.message }));
      page.setDefaultTimeout(20000);
      const response = await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      check(response?.ok(), `map page HTTP ${response?.status()}`);
      await page.locator('[data-map-ready="true"]').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('[data-map-ready="true"]')?.dataset.frames === 'complete', null, { timeout: 30000 });
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.waitForTimeout(200);
      const manifestResponse = await context.request.get(`${origin}/data/manifest.json`);
      const manifestBytes = await manifestResponse.body();
      const manifest = JSON.parse(manifestBytes.toString('utf8'));
      check(manifest.schema === 2 && manifest.contract === 'isobar-web', 'manifest is not web schema 2');
      check(manifest.grid?.nx === 720 && manifest.grid?.ny === 361 && manifest.grid?.wraps_longitude === true, 'manifest is not global 720x361 seam-wrapped data');
      report.manifest = { schema: manifest.schema, run: manifest.run, grid: manifest.grid, sha256: hash(manifestBytes) };
      const renderer = await page.locator('[data-map-ready="true"]').getAttribute('data-renderer');
      report.renderers.push({ mode: mode, renderer: renderer || 'unknown' });
      if (fallback) check(renderer === 'canvas', `forced fallback selected ${renderer}`);
      else {
        check(renderer === 'webgl2', `WebGL requested but ${renderer} selected`);
        const device = await page.evaluate(() => {
          const gl = document.querySelector('[data-chart-layer="webgl"]')?.getContext('webgl2');
          const debug = gl?.getExtension('WEBGL_debug_renderer_info');
          return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown';
        });
        report.renderers[report.renderers.length - 1].device = device;
        check(device !== 'unknown' && !/swiftshader|llvmpipe|software/i.test(device), `Hardware renderer unverified: ${device}`);
      }
      const cases = [
        ['world', 0, 0, 180, 90], ['dateline', 0, 180, 90, 90],
        ['london', 51.5, -0.1, 45, 30], ['tokyo', 35.7, 139.7, 45, 30],
        ['north-polar-boundary', 80, 0, 90, 20], ['south-polar-boundary', -80, 0, 90, 20],
      ];
      const setCamera = async (lat, lon, halfWidth, halfHeight) => page.evaluate(({ lat, lon, halfWidth, halfHeight }) => {
        const stage = document.querySelector('[data-api="1"]');
        const camera = stage?.chartApi?.camera?.();
        if (!camera) throw new Error('chart camera API unavailable');
        const rect = stage.getBoundingClientRect();
        halfHeight = halfWidth / (rect.width / rect.height);
        const centerY = Math.max(-90 + halfHeight, Math.min(90 - halfHeight, lat));
        Object.assign(camera, { centerX: lon, centerY, halfWidth, halfHeight });
        stage.chartApi.redraw();
        return { ...camera };
      }, { lat, lon, halfWidth, halfHeight });
      for (const field of ['pressure', 'temperature', 'wind']) {
        if (field !== 'pressure') {
          const label = field === 'temperature' ? 'Temp' : 'Wind';
          const control = page.getByRole('radio', { name: label, exact: true });
          await control.click();
          await page.locator('[data-legend="ready"]').waitFor({ state: 'visible' });
        }
        for (const [name, lat, lon, halfWidth, halfHeight] of cases) {
          const camera = await setCamera(lat, lon, halfWidth, halfHeight);
          await page.waitForTimeout(fallback ? 200 : 120);
          if (fallback) {
            const pixels = await page.locator('[data-chart-layer="canvas2d"]').evaluate((canvas) => {
              const ctx = canvas.getContext('2d');
              if (!ctx) return null;
              const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
              let opaque = 0, bright = 0;
              for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] === 255) opaque++;
                if (data[i] + data[i + 1] + data[i + 2] > 60) bright++;
              }
              return { opaque: opaque / (data.length / 4), bright: bright / (data.length / 4) };
            });
            check(pixels && pixels.opaque > .99 && pixels.bright > .99, `Fallback canvas is blank/black at ${field}/${name}: ${JSON.stringify(pixels)}`);
          }
          const filename = `${mode}-${field}-${name}.png`;
          await page.screenshot({ path: join(out, filename), fullPage: false });
          report.captures.push({ mode: mode, field, case: name, filename, camera, review: 'manual visual review required' });
        }
      }
      if (fallback) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(250);
        const bounds = await page.locator('[data-chart-layer="canvas2d"]').boundingBox();
        check(bounds && bounds.width > 100 && bounds.width < 391 && bounds.height > 80, 'Fallback resize lost the map surface');
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.waitForTimeout(250);
        await page.getByRole('link', { name: 'Train', exact: true }).first().click();
        await page.waitForURL('**/train');
        await page.waitForTimeout(150);
        check(await page.locator('[data-chart-layer]').count() === 0, 'Chart remained mounted after navigation');
        report.checks.push({ id: `${mode}.resize-and-dispose`, status: 'pass' });
      }
    } catch (error) { report.errors.push({ mode: mode, detail: error.message }); }
    finally { await context.close(); }
  }
  const downloadContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { 'isobar-test': '1' } });
  try {
    const page = await downloadContext.newPage();
    await page.goto(`${origin}/download`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const link = page.getByRole('link', { name: /Download Isobar for Mac/i });
    await link.scrollIntoViewIfNeeded();
    const href = await link.getAttribute('href');
    const visible = await link.isVisible();
    check(visible && href && /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+\.dmg$/.test(href), 'download anchor is not a visible published DMG link at 200% text');
    report.checks.push({ id: 'download.anchor', status: 'pass', detail: href });
  } catch (error) { report.errors.push({ mode: 'download', detail: error.message }); }
  finally { await downloadContext.close(); }
} catch (error) { report.errors.push({ mode: 'launch', detail: error.message }); }
finally { report.ok = report.errors.length === 0 && report.captures.length === 54; if (browser) await browser.close(); writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(`${report.ok ? 'EVIDENCE' : 'FAIL'} ${report.captures.length} captures; manual visual review required`);
console.log(`Evidence: ${join(out, 'report.json')}`);
process.exitCode = report.ok ? 0 : 1;
