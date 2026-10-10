/** Real DOM lifecycle checks: run the bundled mount, including child listeners
 * and animation. No network, native bridge, or shared globals in production. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { launch } from '../tools/browser.mjs';
import { labPreview } from '../src/instruments/lab.ts';
import type { Trainer, TrainerOptions } from '../src/mount.ts';

declare global {
  interface Window {
    MountTest: { mountTrainer(host: HTMLElement, options?: TrainerOptions): Trainer };
    trainers: Trainer[];
    retained: HTMLElement;
    pendingFrames: Set<number>;
  }
}

test('Lab query parameters are shared by native and web adapters', () => {
  assert.deepEqual(labPreview(new URLSearchParams()), {});
  for (const id of ['e6b', 'wind', 'atmosphere', 'interpolation', 'balance', 'profile']) {
    assert.deepEqual(labPreview(new URLSearchParams(`lab=${id}&mode=free`)), { page: 'lab', labInstrument: id, labMode: 'free' });
  }
  assert.deepEqual(labPreview(new URLSearchParams('lab=bogus&mode=bogus')), { page: 'lab', labInstrument: 'e6b', labMode: 'learn' });
});

test('Lab and contextual support preserve state only for their mounted lifetime', { timeout: 60_000 }, async () => {
  const bundle = await build({ entryPoints: [new URL('../src/mount.ts', import.meta.url).pathname], bundle: true, write: false, format: 'iife', globalName: 'MountTest' });
  const browser = await launch();
  assert.ok(browser);
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error: Error) => errors.push(error.message));
    const css = ['app.css', 'instruments/instruments.css'].map((file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')).join('\n');
    await page.setContent(`<style>${css} html,body { margin:0; height:100%; } #a { height:100%; } #b { display:none; }</style><div id="a"></div><div id="b"></div>`);
    await page.addScriptTag({ content: bundle.outputFiles![0].text });
    await page.evaluate(() => {
      const raf = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      window.pendingFrames = new Set();
      window.requestAnimationFrame = (callback) => {
        const id = raf((time) => { window.pendingFrames.delete(id); callback(time); });
        window.pendingFrames.add(id); return id;
      };
      window.cancelAnimationFrame = (id) => { window.pendingFrames.delete(id); cancel(id); };
      window.trainers = ['a', 'b'].map((id) => window.MountTest.mountTrainer(document.getElementById(id)!, {
        navigation: 'tabs', preview: { page: 'lab', labInstrument: 'wind', labMode: 'free' },
      }));
    });
    assert.equal(await page.locator('#a [data-lab-select] option').count(), 6);
    await page.locator('#a [data-lab-select]').selectOption('balance');
    assert.equal(await page.locator('#b [data-instrument-id]').getAttribute('data-instrument-id'), 'wind');
    await page.locator('#a [data-i-mode="learn"]').click();
    // Rebuilding the instrument must keep the shared picker and its listeners.
    assert.equal(await page.locator('#a [data-lab-select]').inputValue(), 'balance');
    await page.locator('#a [data-i-entry]').fill('20');
    await page.locator('#a [data-i-answer]').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.locator('#a [data-i-watch]').click();
    await page.evaluate(() => { window.retained = document.querySelector('#a [data-lab-stage]')!; });
    await page.locator('#a [data-page="profile"]').click();
    assert.equal(await page.evaluate(() => window.retained.childElementCount), 0);
    assert.equal(await page.evaluate(() => window.pendingFrames.size), 0, 'leaving Lab cancels its worked example');
    await page.locator('#a [data-page="lab"]').click();
    assert.equal(await page.locator('#a [data-lab-select]').inputValue(), 'balance');
    await page.locator('#a [data-lab-select]').selectOption('e6b');
    assert.equal(await page.locator('#a .e6b').count(), 1);
    await page.locator('#a [data-lab-select]').selectOption('profile');
    assert.equal(await page.locator('#a .e6b').count(), 0);
    await page.evaluate(() => window.trainers.forEach((trainer) => { trainer.dispose(); trainer.dispose(); }));
    assert.equal(await page.evaluate(() => window.pendingFrames.size), 0, 'all child frames cancelled');
    assert.equal(await page.locator('#a > *, #b > *').count(), 0);

    await page.evaluate(() => {
      window.trainers = [window.MountTest.mountTrainer(document.getElementById('a')!, { navigation: 'tabs', preview: { card: 'drill.interpolate.r2' } })];
    });
    await page.locator('[data-numeric]').fill('999999');
    await page.locator('[data-numeric]').press('Enter');
    assert.equal(await page.locator('[data-instrument-id]').getAttribute('data-instrument-id'), 'interpolation');
    await page.evaluate(() => { window.retained = document.querySelector('[data-instrument-support]')!; });
    await page.locator('[data-i-input]:not(:disabled)').first().evaluate((input: HTMLInputElement) => { input.value = String(Number(input.value) + Number(input.step)); input.dispatchEvent(new Event('input', { bubbles: true })); });
    const state = await page.locator('[data-i-input]:not(:disabled)').first().inputValue();
    await page.locator('[data-step]').first().fill('123');
    assert.equal(await page.evaluate(() => window.retained === document.querySelector('[data-instrument-support]')), true);
    assert.equal(await page.locator('[data-i-input]:not(:disabled)').first().inputValue(), state);
    const draft = await page.locator('[data-step]').first().inputValue();
    await page.locator('[data-page="lab"]').click();
    assert.equal(await page.evaluate(() => window.retained.childElementCount), 0, 'support destroyed on leaving review');
    await page.locator('[data-page="review"]').click();
    assert.equal(await page.locator('[data-step]').first().inputValue(), draft, 'Lab return preserves worksheet');
    await page.locator('[data-instrument-open]').click();
    await page.locator('[data-support-return]').click();
    assert.equal(await page.locator('[data-instrument-support]').count(), 0);
    await page.locator('[data-instrument-open]').click();
    await page.evaluate(() => {
      window.retained = document.querySelector('[data-instrument-support]')!;
      window.trainers[0].dispose();
      window.trainers[0].setTheme('dark');
    });
    assert.equal(await page.evaluate(() => window.retained.childElementCount), 0);
    assert.equal(await page.evaluate(() => window.pendingFrames.size), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
