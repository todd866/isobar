import { expect, test } from '@playwright/test';

const collections = [
  { id: 'dday', title: 'D-Day', manifest: '/history/dday-manifest.json', days: ['1944-06-05', '1944-06-06'] },
  { id: 'cyclone-tracy', title: 'Cyclone Tracy', manifest: '/history/tracy-manifest.json', days: ['1974-12-25'] },
];

function weather(id: string, days: string[]) {
  const times = days.flatMap(day => Array.from({ length: 24 }, (_, hour) => `${day}T${String(hour).padStart(2, '0')}:00Z`));
  return { schema_version: 1, product: 'isobar-historical-weather', event: { id }, model: 'ERA5',
    units: { pressure_msl: 'hPa', u: 'knots', v: 'knots' },
    grid: { nx: 4, ny: 3, longitudes: [-180, -90, 0, 90], latitudes: [90, 0, -90], step_degrees: 90 }, times,
    frames: times.map((time, hour) => ({ time, pressure_msl: Array.from({ length: 12 }, (_, i) => 980 + i * 4 + hour), u: Array(12).fill(10), v: Array(12).fill(4) })),
  };
}

test('historical days replay offline; a failed collection cannot leave the old map visible', async ({ page, context }) => {
  let failTracy = true;
  const requests: string[] = [];
  await page.route('**/history/**', async route => {
    const name = new URL(route.request().url()).pathname;
    requests.push(name);
    if (name.endsWith('/catalog.json')) return route.fulfill({ json: { schema_version: 1, collections: collections.map(item => ({ ...item, days: item.days.map(date => ({ date, complete: true })) })) } });
    const collection = collections.find(item => item.manifest === name);
    if (collection) return route.fulfill({ json: { weather: `/history/${collection.id}.json` } });
    const data = collections.find(item => name === `/history/${item.id}.json`);
    if (data) {
      if (data.id === 'cyclone-tracy' && failTracy) return route.fulfill({ status: 503, body: 'Unavailable' });
      return route.fulfill({ json: weather(data.id, data.days) });
    }
    return route.abort();
  });
  await page.goto('/historical');
  const canvas = page.locator('[data-historical-map] canvas');
  const hour = page.getByRole('slider', { name: 'Historical hour' });
  await expect(hour).toHaveAttribute('max', '23');
  await expect(canvas).toBeVisible();
  const count = requests.length;
  await context.setOffline(true);
  await page.getByRole('combobox', { name: 'Available historical days' }).selectOption('1944-06-06');
  await expect(page.locator('[aria-label="Historical playback controls"]')).toContainText('06 Jun');
  await hour.fill('12');
  await page.getByRole('button', { name: 'Play historical weather', exact: true }).click();
  await expect.poll(async () => Number(await hour.inputValue())).toBeGreaterThan(12);
  await page.getByRole('button', { name: 'Pause historical weather', exact: true }).click();
  expect(requests).toHaveLength(count);
  await context.setOffline(false);
  await page.getByRole('combobox', { name: 'Historical collection' }).selectOption('cyclone-tracy');
  await expect(page.getByRole('alert').filter({ hasText: 'Historical weather unavailable' })).toContainText('503');
  await expect(canvas).toBeHidden();
  await expect(page.getByRole('button', { name: 'Show Normandy view' })).toHaveCount(0);
  failTracy = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Historical weather unavailable' })).toHaveCount(0);
  await expect(page.locator('[aria-label="Historical playback controls"]')).toContainText('25 Dec');
});
