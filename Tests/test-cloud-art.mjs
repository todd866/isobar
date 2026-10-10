import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../tools/clouds/package.json', import.meta.url));
const { createCanvas, loadImage } = require(process.env.CANVAS_MODULE || '@napi-rs/canvas');

async function pixels(name) {
  const image = await loadImage(fileURLToPath(new URL(`../tools/clouds/assets/${name}.webp`, import.meta.url)));
  const c = createCanvas(image.width, image.height), ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
  return { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
}
test('painted sprites preserve real alpha and neutral cloud colour', async () => {
  for (const name of ['painted-atlas', 'stratus', 'nimbostratus']) {
    const { data } = await pixels(name); let clear = 0, solid = 0, warm = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) clear++;
      if (data[i + 3] >= 128) { solid++; if (data[i] > data[i + 1] + 12 && data[i] > data[i + 2] + 12) warm++; }
    }
    assert.ok(clear > 100, `${name}: transparent background is required`);
    assert.ok(solid > 100, `${name}: visible cloud is required`);
    assert.ok(warm / solid < .001, `${name}: no salmon/pink cloud palette`);
  }
});
test('painted nimbostratus has a nearly level top, not cauliflower turrets', async () => {
  const { width, height, data } = await pixels('nimbostratus'); const tops = [], bottoms = [];
  for (let x = Math.floor(width * .15); x < width * .85; x++) {
    let top = -1, bottom = -1;
    for (let y = 0; y < height; y++) if (data[(y * width + x) * 4 + 3] >= 128) { if (top === -1) top = y; bottom = y; }
    if (top >= 0) { tops.push(top); bottoms.push(bottom); }
  }
  tops.sort((a,b) => a-b); bottoms.sort((a,b) => a-b);
  assert.ok(tops.length > width * .6, 'continuous bank across central width');
  const middle = Math.floor(tops.length / 2), depth = bottoms[middle] - tops[middle];
  const variation = tops[Math.floor(tops.length * .9)] - tops[Math.floor(tops.length * .1)];
  assert.ok(variation / depth < .15, `top variation ${variation} / depth ${depth} must stay sheet-like`);
});
