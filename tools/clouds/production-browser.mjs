#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from '../../training/node_modules/esbuild/lib/main.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = resolve(root, 'build/clouds-phase2');
const htmlPath = resolve(outDir, 'phone-benchmark.html');
const entryPath = resolve(dirname(fileURLToPath(import.meta.url)), 'production-browser-entry.mjs');

function buildPage() {
  mkdirSync(outDir, { recursive: true });
  return import(pathToFileURL(resolve(root, 'tools/clouds/production-scenes.mjs')).href).then(async ({ scenes }) => {
    const atlas = readFileSync(resolve(root, 'web/public/sky/painted-clouds.webp')).toString('base64');
    const entry = readFileSync(entryPath, 'utf8')
      .replace('__SCENES__', JSON.stringify(scenes))
      .replace('__ATLAS__', JSON.stringify(`data:image/webp;base64,${atlas}`));
    const bundle = await esbuild.build({
      stdin: { contents: entry, resolveDir: root, sourcefile: 'production-browser-entry.mjs', loader: 'js' },
      bundle: true, format: 'iife', target: 'safari17', write: false, minify: false, legalComments: 'none',
    });
    const script = bundle.outputFiles[0].text;
    const html = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;width:100%;min-height:100%;background:#edf1f3;color:#182e40;font-size:14px;font-family:system-ui,sans-serif}body{font-size:1rem;background:inherit;color:inherit}html[data-theme=dark]{background:#101922;color:#dde7ef}#bar{min-height:44px;display:flex;align-items:center;gap:8px;padding:5px 12px;box-sizing:border-box;flex-wrap:wrap;background:color-mix(in srgb,currentColor 8%,transparent)}button,select{padding:6px 8px;font:inherit}#sky{display:block;width:100%;height:236px;max-width:600px}#note{opacity:.8}#summary{display:block;padding:8px 12px;font-size:.86rem;line-height:1.35}details{margin:0 12px 12px}#result{white-space:pre-wrap;overflow:auto;max-height:180px;font:.8rem ui-monospace,monospace}</style>
<div id="bar"><label>Scene <select id="scene">${scenes.map((s, i) => `<option value="${i}">${['A · Rain','B · Cu','C · CB','D · St/Ci'][i]}</option>`).join('')}</select></label><label>Theme <select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label><button id="run">Run benchmark</button></div><canvas id="sky" aria-label="Production sky preview"></canvas><div id="note">Ready</div><output id="summary" aria-live="polite">Select a scene and run the benchmark.</output><details><summary>Full JSON results</summary><button id="copy">Copy JSON</button><button id="download">Download JSON</button><pre id="result"></pre></details>
<script>${script}</script>`;
    writeFileSync(htmlPath, html);
    return htmlPath;
  });
}

const html = await buildPage();
if (process.argv.includes('--build-only')) {
  console.log(JSON.stringify({ html, bytes: readFileSync(html).byteLength }));
  process.exit(0);
}

const { chromium } = await import(resolve(root, 'training/node_modules/playwright-core/index.mjs'));
const helper = resolve(root, 'tools/viewport-fit.mjs');
const shots = resolve(outDir, 'browser-shots');
mkdirSync(shots, { recursive: true });
const matrix = [
  ['laptop', 1280, 720], ['phone', 390, 844], ['landscape', 844, 390],
];
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const results = [];
try {
  for (const [name, width, height] of matrix) for (const theme of ['light', 'dark']) for (const textScale of [1, 2]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: name === 'phone' ? 3 : 1, colorScheme: theme });
    const requests = [];
    const errors = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url()); requests.push(url.href);
      if (url.origin === 'http://clouds.local' && url.pathname === '/') return route.fulfill({ contentType:'text/html', body:readFileSync(htmlPath,'utf8') });
      if (url.origin === 'http://clouds.local' && url.pathname === '/atlas.webp') {
        await new Promise(resolve => setTimeout(resolve, 120));
        return route.fulfill({ contentType:'image/webp', body:readFileSync(resolve(root,'web/public/sky/painted-clouds.webp')) });
      }
      errors.push(`Unexpected request ${url.href}`); await route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://clouds.local/?external=1');
    await page.evaluate(({ theme: nextTheme, textScale: scale }) => { document.documentElement.dataset.theme = nextTheme; document.documentElement.style.fontSize = `${scale * 100}%`; document.querySelector('#theme').value = nextTheme; }, { theme, textScale });
    await page.selectOption('#theme', theme);
    const viewportHelper = await import(pathToFileURL(helper).href);
    await page.waitForFunction(() => window.__PRODUCTION_READY && window.__VISIBLE_READY && document.querySelector('#sky')?.getBoundingClientRect().height >= 120);
    await viewportHelper.assertViewport(page, { documentY: 'allow', primary: [{ selector: '#sky', minWidth: 250, minHeight: 120 }], controls: [{ selector: '#run', minWidth: 36, minHeight: 30 }] });
    await context.setOffline(true);
    await page.screenshot({ path: resolve(shots, `${name}-${theme}-${textScale}x-before.png`), fullPage: false });
    const before = requests.length;
    await page.click('#run');
    await page.waitForFunction(() => Boolean(window.__BENCHMARK_RESULT));
    if (requests.length !== before) throw new Error(`offline benchmark fetched ${requests.length - before} requests`);
    if (errors.length) throw new Error(errors.join('\n'));
    if (requests.filter(r => r.includes('/atlas.webp')).length !== 1) throw new Error('Atlas decode was not deduplicated');
    for (const scene of ['1','2','3']) { await page.selectOption('#scene', scene); await page.waitForFunction(() => window.__VISIBLE_READY); }
    if (requests.length !== before || errors.length) throw new Error('Offline scene navigation fetched or failed');
    const payload = await page.evaluate(() => window.__BENCHMARK_RESULT);
    results.push({ name, theme, textScale, payload });
    await page.screenshot({ path: resolve(shots, `${name}-${theme}-${textScale}x-after.png`), fullPage: false });
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(resolve(outDir, 'browser-timing.json'), JSON.stringify({ scope: 'Browser contexts only; 390px CSS viewport is desktop browser emulation, not physical-phone certification.', results }, null, 2));
console.log(JSON.stringify({ html, screenshots: shots, results: results.length }, null, 2));
