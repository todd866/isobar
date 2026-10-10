#!/usr/bin/env node
// Canvas2D design renders when a sandbox cannot launch a browser. These use the
// SAME prepareScene code as the browser, but are not DOM/viewport/perf evidence.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skies, styles } from './fixtures.mjs';
import { prepareScene, prepareSprites } from './render.mjs';
const require = createRequire(import.meta.url);
const { createCanvas, loadImage, Path2D } = require(process.env.CANVAS_MODULE || '@napi-rs/canvas');
globalThis.Path2D = Path2D;
globalThis.document = { createElement: () => createCanvas(1, 1) };
const root = fileURLToPath(new URL('.', import.meta.url));
const output = resolve(root, '../../build/clouds'); mkdirSync(output, { recursive: true });
const sprites = prepareSprites({ atlas: await loadImage(resolve(root, 'assets/painted-atlas.webp')), stratus: await loadImage(resolve(root, 'assets/stratus.webp')), nimbostratus: await loadImage(resolve(root, 'assets/nimbostratus.webp')) });
const timings = [];
for (const dark of [false, true]) for (const [size, width, height] of [['phone', 390, 236], ['desktop', 600, 320]]) {
  const theme = dark ? 'dark' : 'light', gap = 14, margin = 20, heading = 66, rowLabel = 32;
  const rowHeight = height + rowLabel + gap;
  const sheet = createCanvas(width * 3 + gap * 2 + margin * 2, heading + rowHeight * 4 + 28), ctx = sheet.getContext('2d');
  ctx.fillStyle = dark ? '#101a23' : '#edf1f3'; ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.fillStyle = dark ? '#dce5ec' : '#223748'; ctx.font = '600 17px -apple-system, sans-serif';
  ctx.fillText(`Cloud study · ${theme} · ${width}px sections`, margin, 25);
  for (let column = 0; column < styles.length; column++) {
    ctx.font = '14px -apple-system, sans-serif'; ctx.fillText(styles[column].title, margin + column * (width + gap), 52);
  }
  for (let row = 0; row < skies.length; row++) for (let column = 0; column < styles.length; column++) {
    const scene = skies[row], style = styles[column], start = performance.now();
    const prepared = prepareScene(scene, style.id, width, height, dark, sprites, 2);
    timings.push({ scene: scene.id, style: style.id, size, theme, prepareMs: performance.now() - start });
    const x = margin + column * (width + gap), y = heading + row * rowHeight;
    ctx.fillStyle = dark ? '#dce5ec' : '#223748'; ctx.font = '600 13px -apple-system, sans-serif'; ctx.fillText(scene.title, x, y + 19);
    ctx.drawImage(prepared, x, y + rowLabel, width, height);
    writeFileSync(resolve(output, `${scene.id}-${style.id}-${theme}-${size}.png`), prepared.toBuffer('image/png'));
  }
  ctx.font = '11px -apple-system, sans-serif'; ctx.fillStyle = dark ? '#9bb0bd' : '#536b7c';
  ctx.fillText('Synthetic fixtures · same data in each style · Canvas2D design render (not a browser screenshot)', margin, sheet.height - 12);
  writeFileSync(resolve(output, `comparison-${theme}-${width}.png`), sheet.toBuffer('image/png'));
}
writeFileSync(resolve(output, 'offline-validation.json'), JSON.stringify({ renderer: 'Same Canvas2D prepareScene via @napi-rs/canvas', viewportVerification: 'blocked: sandbox Chrome launch SIGABRT', phonePerformance: 'not measured', timings }, null, 2));
console.log('Rendered 4 comparison sheets and 48 individual cloud panels with shared Canvas2D code.');
