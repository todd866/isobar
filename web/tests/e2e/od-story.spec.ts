import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { StoryCase, StoryPayload } from '../../src/lib/od/story/types';
import { STORY_STORAGE_KEY } from '../../src/lib/od/story/types';

const shotRoot = path.resolve(new URL('../../../build/od-qa/story', import.meta.url).pathname);

function row(shift: number, index: number, failing = false): StoryCase {
  return {
    id: `shift-${shift}-${index}`,
    decreeId: shift === 1 ? 'forecast-coverage' : 'destination-alternate',
    strand: 'charts',
    difficulty: 0,
    failing,
    weatherBad: failing,
    route: 'KES–ORL',
    clock: '1840Z',
    fact: failing ? 'TAF ends 1800Z' : 'TAF covers 2100Z',
  };
}

const payload: StoryPayload = {
  seed: 4,
  shifts: {
    1: [0, 1, 2, 3, 4].map(index => row(1, index, index === 1 || index === 2)),
    2: [0, 1, 2, 3, 4].map(index => row(2, index, index === 2)),
  },
  strands: {
    1: { before: { charts: 0 }, after: { charts: 0.4 } },
    2: { before: { charts: 0.4 }, after: { charts: 0.4 } },
  },
};

async function openStory(page: Page) {
  await page.addInitScript(({ key, story, theme }) => {
    localStorage.setItem('isobar-theme', theme);
    sessionStorage.setItem(key, JSON.stringify(story));
  }, { key: STORY_STORAGE_KEY, story: payload, theme: 'light' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/decide?story=1');
  await expect(page.getByRole('heading', { name: 'Operational Decision' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'RELEASE', exact: true })).toBeVisible();
}

async function stamp(page: Page, name: 'RELEASE' | 'REFUSE') {
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button', { name: /Next dossier|Close shift/ }).click();
}

test('shifts 1 and 2 play scripted pressure on mocked dossiers', async ({ page }) => {
  test.setTimeout(90_000);
  mkdirSync(shotRoot, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openStory(page);

  await stamp(page, 'RELEASE');
  await expect(page.getByText('Something on this sheet is wrong. I think.')).toBeVisible();
  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await expect(page.getByText('The TAF ends before the ETA.')).toBeVisible();
  await stamp(page, 'REFUSE');
  await expect(page.getByText('Sign it before the minute turns.')).toBeVisible();
  await expect(page.getByText('The TAF ends before the ETA.')).toBeVisible();
  await page.screenshot({ path: path.join(shotRoot, 'captain-light.png') });
  await stamp(page, 'RELEASE');
  await stamp(page, 'RELEASE');
  await expect(page.getByText('Diversion report')).toBeVisible();
  await page.screenshot({ path: path.join(shotRoot, 'report-light.png') });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await stamp(page, 'RELEASE');

  const ledger = page.getByRole('list', { name: 'Shift ledger' });
  await expect(ledger).toBeVisible();
  await expect(page.locator('[data-meter=dossiers]')).toContainText('5');
  await expect(page.locator('[data-meter=dossiers]')).toContainText('filed');
  await expect(page.locator('[data-meter=correct]')).toContainText('4');
  await expect(page.locator('[data-meter=citations]')).toContainText('1');
  await expect(page.locator('[data-meter=quota] strong')).toHaveText('3');
  await expect(page.locator('[data-meter=quota]')).toContainText('of 2 on time');
  await expect(page.locator('[data-meter=strands]')).toContainText('charts up');
  await page.screenshot({ path: path.join(shotRoot, 'summary-light.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);

  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.screenshot({ path: path.join(shotRoot, 'summary-dark.png') });
  await page.getByRole('button', { name: 'Next shift', exact: true }).click();
  await expect(page.locator('.od-shift')).toContainText('02');
  await page.screenshot({ path: path.join(shotRoot, 'shift2-dark.png') });

  await page.getByRole('button', { name: 'Listen', exact: true }).click();
  await expect(page.getByText('Nothing on the sheet. I was wrong.')).toBeVisible();
  await stamp(page, 'RELEASE');
  await expect(page.getByText('The count is one short.')).toBeVisible();
  await page.getByRole('button', { name: 'Report', exact: true }).click();
  await expect(page.getByText('The list goes in the Ministry tray.')).toBeVisible();
  await stamp(page, 'RELEASE');
  await page.getByRole('button', { name: 'REFUSE', exact: true }).click();
  await page.getByRole('button', { name: 'Next dossier', exact: true }).click();
  await stamp(page, 'RELEASE');
  await expect(page.getByText('Diversion report')).toHaveCount(0);
  await stamp(page, 'RELEASE');
  await expect(page.locator('[data-meter=quota]')).toContainText('held 1');
  await expect(page.locator('[data-meter=strands]')).toContainText('flat');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: path.join(shotRoot, 'summary-dark-phone.png') });
  expect(errors).toEqual([]);
});
