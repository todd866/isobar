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
    if (!name.startsWith("/history/")) return route.continue();
    requests.push(name);
    if (name.endsWith('/world-coast.bin')) return route.continue();
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
  await page.goto('/history?event=dday&date=1944-06-05&hour=0');
  const canvas = page.locator('[data-map-ready=true]');
  const hour = page.getByRole('slider', { name: 'Forecast time' });
  await expect(canvas).toBeVisible({timeout:15000});
  await expect(hour).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(canvas).toBeVisible();
  const count = requests.length;
  await context.setOffline(true);
  await page.getByRole('combobox', { name: 'Historical day' }).selectOption('1944-06-06');
  await expect(page.getByRole('combobox', {name: 'Historical day', exact: true})).toHaveValue('1944-06-06');
  await hour.focus(); await page.keyboard.press('ArrowRight');
  const minute = Number(await hour.getAttribute('aria-valuenow'));
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await hour.getAttribute('aria-valuenow'))).toBeGreaterThan(minute);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  expect(requests).toHaveLength(count);
  await context.setOffline(false);
  await page.getByRole('combobox', { name: 'Historical event' }).selectOption('cyclone-tracy');
  await expect(page.getByRole('alert').filter({hasText:'Historical'})).toContainText('503');
  await expect(canvas).toBeHidden();
  await expect(page.getByRole('slider', {name: 'Forecast time'})).toHaveCount(0);
  await expect(page.getByRole('link', {name: 'Back to present day'})).toBeVisible();
  failTracy = false;
  await page.getByRole('button', { name: 'Retry historical chart', exact: true }).click();
  await expect(canvas).toBeVisible();
  await expect(page.getByRole('alert').filter({hasText:'Historical'})).toHaveCount(0);
  await expect(page.getByRole('combobox', {name: 'Historical day', exact: true})).toHaveValue('1974-12-25');
});


test('cold historical failure keeps its selected event and date on retry', async ({page}) => {
  await page.addInitScript(() => localStorage.setItem('isobar.speed','0'));
  let failing = true;
  await page.route('**/history/cyclone-tracy-*.json', route => failing ? route.fulfill({status:503, body:'Unavailable'}) : route.continue());
  await page.goto('/history?event=cyclone-tracy&date=1974-12-25&hour=6');
  await expect(page.getByRole('alert').filter({hasText:'Historical'})).toContainText('503');
  await expect(page.getByRole('link', {name:'Back to present day',exact:true})).toBeVisible();
  failing=false;
  await page.getByRole('button',{name:'Retry historical chart',exact:true}).click();
  const stage=page.locator('[data-map-ready=true]');await expect(stage).toBeVisible();
  await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Historical event'})).toHaveValue('cyclone-tracy');
  await expect(page.getByRole('combobox',{name:'Historical day'})).toHaveValue('1974-12-25');
  const time=Number(await stage.getAttribute('data-valid-ms'));
  expect(Math.abs(time-Date.parse('1974-12-25T06:00:00Z'))).toBeLessThan(60000);
});
