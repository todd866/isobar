/**
 * Sky section preview: renders YPPH and YSSY now, +12 h and +24 h, light and
 * dark, desktop and phone, plus a synthetic gallery, into PNGs; then
 * benchmarks scrubbing frame times on a phone viewport (4× CPU throttle).
 * Headless only. Reads web/public/data (run `npm run export-data` first).
 *
 *   npx tsx scripts/sky-preview.ts [outDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..');
const out = process.argv[2] ?? path.join(os.homedir(), '.local', 'state', 'isobar-sky', 'shots');
fs.mkdirSync(out, { recursive: true });

const bundle = await build({ entryPoints: [path.join(here, 'sky-preview-entry.ts')], bundle: true, write: false, format: 'iife', target: 'es2022' });
const data = {
  sky: JSON.parse(fs.readFileSync(path.join(web, 'public', 'data', 'sky.json'), 'utf8')),
  aviation: JSON.parse(fs.readFileSync(path.join(web, 'public', 'data', 'aviation.json'), 'utf8')),
  nowMs: Number(process.env.SKY_NOW_MS ?? Date.now()),
};
const html = `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>window.SKY_DATA=${JSON.stringify(data)}</script><script>${bundle.outputFiles[0].text}</script>`;
const page0 = path.join(out, '..', 'preview.html');
fs.writeFileSync(page0, html);

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const devices = [
    { name: 'desktop', width: 368, height: 280, dpr: 2, viewport: { width: 1440, height: 900 } },
    { name: 'phone', width: 366, height: 236, dpr: 3, viewport: { width: 390, height: 844 } },
  ];
  const log: string[] = [];
  for (const device of devices) {
    const context = await browser.newContext({ viewport: device.viewport, deviceScaleFactor: device.dpr });
    const page = await context.newPage();
    page.on('pageerror', (error) => log.push(`pageerror ${error.message}`));
    await page.goto(`file://${page0}`);
    const cases: { file: string; spec: unknown }[] = [];
    for (const icao of ['YPPH', 'YSSY']) for (const offsetH of [0, 12, 24]) cases.push({ file: `${icao}-${offsetH === 0 ? 'now' : `+${offsetH}h`}`, spec: { kind: 'real', icao, offsetH } });
    for (const name of ['cb-ts', 'stratus-dz-br', 'cumulus-fair', 'cirrus-only', 'fog', 'ac-as-virga', 'sc-night']) cases.push({ file: `gallery-${name}`, spec: { kind: 'synthetic', name } });
    for (const item of cases) for (const dark of [false, true]) {
      const info = await page.evaluate(([spec, size]) => window.renderCase(spec as never, size as never), [item.spec, { width: device.width, height: device.height, dark }] as const);
      const file = path.join(out, `${item.file}-${device.name}-${dark ? 'dark' : 'light'}.png`);
      await page.locator('#sky').screenshot({ path: file });
      if (!dark && device.name === 'desktop') log.push(`${item.file}: ${info}`);
    }
    await context.close();
  }
  // Scrub benchmark on a phone viewport.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  const page = await context.newPage();
  await page.goto(`file://${page0}`);
  const cdp = await context.newCDPSession(page);
  for (const throttle of [1, 4]) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    for (const icao of ['YPPH', 'YSSY']) {
      const result = await page.evaluate((spec) => window.scrubBench(spec), { icao, width: 366, height: 236, dark: false, frames: 480 });
      log.push(`bench ${icao} cpu×${throttle}: ${JSON.stringify(result)}`);
    }
  }
  await context.close();
  fs.writeFileSync(path.join(out, '..', 'preview-log.txt'), `${log.join('\n')}\n`);
  console.log(log.join('\n'));
  console.log(`shots in ${out}`);
} finally {
  await browser.close();
}
