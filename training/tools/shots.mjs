/** Headless preview shots of the review card: a fuel-flow drill before the
 * answer, the follow-up after a wrong answer, the transfer item after the
 * follow-up is solved, and one MCQ. Usage: node tools/shots.mjs OUTDIR
 * Needs `npm run build` first. Offscreen only; never opens a window. */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './browser.mjs';

const out = resolve(process.argv[2] ?? 'dist/shots');
mkdirSync(out, { recursive: true });
const page = pathToFileURL(resolve('dist/index.html')).href;
const DRILL = process.env.DRILL ?? 'drill.interpolate.r1';
const WRONG = process.env.WRONG ?? '4586';
const MCQ = process.env.MCQ ?? 'met.taf.wind';
const sizes = (process.env.SIZES ?? '1280x820,1440x900,390x844').split(',').map((s) => s.split('x').map(Number));
const themes = (process.env.THEMES ?? 'light,dark').split(',');

async function open(browser, w, h, theme, card) {
  const tab = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await tab.goto(`${page}?theme=${theme}&card=${encodeURIComponent(card)}`);
  await tab.waitForFunction(() => window.__TRAINING_READY);
  return tab;
}

async function solveWorksheet(tab) {
  // Fill each step with the value the card expects, read from the page's own data.
  const steps = await tab.evaluate(() => window.__TRAINING_STEPS?.() ?? []);
  for (const step of steps) {
    const field = tab.locator(`[data-step="${step.id}"]`);
    if (await field.count() === 0) break;
    await field.fill(step.text);
  }
}

const browser = await launch();
if (!browser) throw new Error('no headless Chromium found');
try {
  for (const [w, h] of sizes) {
    for (const theme of themes) {
      const tag = `${w}x${h}-${theme}`;
      let tab = await open(browser, w, h, theme, DRILL);
      await tab.screenshot({ path: `${out}/drill-ask-${tag}.png` });
      await tab.locator('[data-numeric]').fill(WRONG);
      await tab.keyboard.press('Enter');
      await tab.waitForSelector('.worksheet');
      // Two steps done, the third typed wrong, to show the live checks.
      const steps = await tab.evaluate(() => window.__TRAINING_STEPS?.() ?? []);
      if (steps[0]) await tab.locator(`[data-step="${steps[0].id}"]`).fill(steps[0].text);
      if (steps[1]) await tab.locator(`[data-step="${steps[1].id}"]`).fill(steps[1].text);
      await tab.screenshot({ path: `${out}/drill-followup-${tag}.png` });
      await solveWorksheet(tab);
      await tab.waitForSelector('.grades');
      await tab.screenshot({ path: `${out}/drill-followup-solved-${tag}.png` });
      await tab.keyboard.press('3');
      await tab.waitForSelector('.eyebrow');
      await tab.screenshot({ path: `${out}/drill-transfer-${tag}.png` });
      await tab.close();
      tab = await open(browser, w, h, theme, MCQ);
      await tab.keyboard.press('2');
      await tab.screenshot({ path: `${out}/mcq-ask-${tag}.png` });
      await tab.keyboard.press(' ');
      await tab.screenshot({ path: `${out}/mcq-revealed-${tag}.png` });
      await tab.close();
    }
  }
} finally {
  await browser.close();
}
console.log(out);
