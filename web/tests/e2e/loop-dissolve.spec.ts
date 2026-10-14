import {expect, test} from '@playwright/test';
import {createLoopDissolve} from '../../src/lib/loop-dissolve';

test('dissolve captures the visible fallback plate despite its hidden class', async ({page}) => {
  await page.setContent('<style>.hidden {display:none}</style><div id="stage"><canvas class="hidden" style="display:block" width="8" height="8"></canvas><canvas style="display:none" width="8" height="8"></canvas></div>');
  await page.addScriptTag({content: `window.createLoopDissolve = ${createLoopDissolve.toString()}`});
  const pixel = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('#stage')!;
    const layers = [...stage.querySelectorAll('canvas')];
    for (const [i, layer] of layers.entries()) {
      const ctx = layer.getContext('2d')!;
      ctx.fillStyle = i === 0 ? '#ff0000' : '#0000ff';
      ctx.fillRect(0, 0, 8, 8);
    }
    const dissolve = (window as any).createLoopDissolve(stage);
    try {
      dissolve.capture(layers);
      dissolve.draw(.5);
      const canvas = stage.querySelector<HTMLCanvasElement>('[data-loop-dissolve]')!;
      return {rgba: [...canvas.getContext('2d')!.getImageData(4, 4, 1, 1).data], display: getComputedStyle(canvas).display, opacity: canvas.style.opacity};
    } finally { dissolve.destroy(); }
  });
  expect(pixel).toEqual({rgba: [255, 0, 0, 255], display: 'block', opacity: '0.5'});
});
