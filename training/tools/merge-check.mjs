/** Offline headless merge regression for the built trainer.
 * Usage: TRAINING_SINGLE_PROCESS=1 node tools/merge-check.mjs [OUT]
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch } from './browser.mjs';

const out = resolve(process.argv[2] ?? '../build/qa/merge');
mkdirSync(out, { recursive: true });
const entry = pathToFileURL(resolve('dist/index.html')).href;

const e6b = {
  version: 1,
  memories: {},
  stages: { tas: 'guided' },
  bests: { tas: 12000 },
  daily: null,
  streak: { count: 2, lastDay: '2026-10-06' },
};
const skills = {
  'groundspeed': {
    support: 2, retests: 1, transfers: 0, closed: 0,
    lastSlip: 'wind component', lastAt: '2026-10-06T00:00:00.000Z',
  },
};
const progress = {
  version: 1,
  cards: {},
  streak: { count: 3, lastDay: '2026-10-06' },
  e6b,
  skills,
};

async function open(browser, query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.context().setOffline(true);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.__pageErrors = pageErrors;
  await page.addInitScript(({ progress: initial }) => {
    window.__SAVES = [];
    window.isobar = {
      progress: initial,
      save: (value) => window.__SAVES.push(JSON.parse(JSON.stringify(value))),
      close: () => { window.__CLOSED = true; },
    };
  }, { progress });
  await page.goto(`${entry}${query}`);
  await page.waitForFunction(() => window.__TRAINING_READY === true);
  return page;
}

async function waitScreen(page, screen) {
  await page.waitForFunction((wanted) => document.querySelector('[data-screen]')?.getAttribute('data-screen') === wanted, screen);
}

async function saved(page) {
  return page.evaluate(() => window.__SAVES ?? []);
}

function assertNoPageErrors(page) {
  assert.deepEqual(page.__pageErrors, [], 'built trainer has no page errors');
}

const browser = await launch();
if (!browser) throw new Error('no headless Chromium found');
try {
  const shell = await open(browser);
  for (const [screen, label] of [
    ['review', 'review'], ['live', 'live'], ['plan', 'plan'],
    ['exam', 'exam'], ['lab', 'lab'], ['profile', 'profile'],
  ]) {
    await shell.locator(`[data-page="${screen}"]`).first().click();
    await waitScreen(shell, screen);
    assert.equal(await shell.locator('[data-screen="' + screen + '"]').count(), 1, `${label} rail page`);
  }
  assertNoPageErrors(shell);
  await shell.screenshot({ path: `${out}/rail.png` });
  await shell.close();

  // A generated numeric card must make the complete wrong → worksheet → transfer loop.
  const drill = await open(browser, `?card=${encodeURIComponent('drill.interpolate.r1')}`);
  assert.equal(await drill.locator('[data-numeric]').count(), 1, 'numeric drill opens');
  await drill.locator('[data-numeric]').fill('4586');
  await drill.keyboard.press('Enter');
  await drill.waitForSelector('.worksheet');
  assert.match(await drill.locator('.eyebrow').innerText(), /Same problem, in steps/);
  const steps = await drill.evaluate(() => window.__TRAINING_STEPS?.() ?? []);
  for (const step of steps) {
    const field = drill.locator(`[data-step="${step.id}"]`);
    if (await field.count()) await field.fill(step.text);
  }
  await drill.waitForSelector('.grades');
  await drill.keyboard.press('3');
  await drill.waitForFunction(() => document.querySelector('.eyebrow')?.textContent?.includes('New numbers'));
  const afterDrill = await saved(drill);
  assert.ok(afterDrill.length > 0, 'numeric grading saves progress');
  const numericSave = afterDrill.at(-1);
  assert.deepEqual(numericSave.e6b, e6b, 'numeric save keeps E6-B state');
  assert.deepEqual(numericSave.skills?.groundspeed, skills.groundspeed, 'numeric save keeps existing adaptive skill');
  assert.ok(numericSave.skills?.interpolate, 'numeric save records the numeric skill');
  assertNoPageErrors(drill);
  await drill.screenshot({ path: `${out}/numeric-transfer.png` });
  await drill.close();

  // The Lab owns keyboard input. Enter and number keys must not reach trainer grading.
  const lab = await open(browser, '?');
  await lab.locator('[data-page="lab"]').click();
  await waitScreen(lab, 'lab');
  await lab.locator('[data-mode="practice"]').click();
  // Angular questions go straight to the reading; they have no magnitude estimate.
  if (await lab.locator('.e6b [data-e6b="estimate"]').count()) {
    await lab.locator('.e6b [data-e6b="estimate"]').fill('0');
    await lab.locator('.e6b form[data-e6b="answer"] button.go').click();
  }
  await lab.waitForSelector('.e6b [data-e6b="reading"]:not([disabled])');
  const beforeLab = await saved(lab);
  await lab.locator('.e6b [data-e6b="reading"]').fill('0');
  await lab.keyboard.press('Enter');
  await lab.keyboard.press('1');
  assert.equal(await lab.locator('[data-screen="lab"]').count(), 1, 'E6-B keys stay in Lab');
  assert.equal(await lab.locator('.grades').count(), 0, 'E6-B keys do not grade trainer cards');
  const afterLab = await saved(lab);
  assert.ok(afterLab.length > beforeLab.length, 'E6-B answer saves its record');
  const e6bSave = afterLab.at(-1);
  assert.ok(e6bSave.e6b, 'E6-B save contains E6-B state');
  assert.deepEqual(e6bSave.skills, skills, 'E6-B save keeps adaptive skills');
  assert.ok(Object.keys(e6bSave.e6b.memories ?? {}).length > 0, 'E6-B save records the answered skill');
  assertNoPageErrors(lab);
  await lab.screenshot({ path: `${out}/lab.png` });
  await lab.close();

} finally {
  await browser.close();
}
console.log(`merge checks passed; screenshots: ${out}`);
