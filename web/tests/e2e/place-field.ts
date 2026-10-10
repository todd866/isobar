import { expect, type Page } from '@playwright/test';

/** Type a query and choose that catalog row, the way the place field is used. */
export async function choosePlace(page: Page, query: string, id: string) {
  const expand = page.locator('[data-expand-place]');
  if (await expand.isVisible()) await expand.click();
  const field = page.getByRole('combobox', { name: 'Place', exact: true });
  await field.click();
  await expect(page.locator('[data-place-menu]')).toBeVisible();
  await field.fill(query);
  const option = page.locator(`[data-place-option="${id}"]`);
  await expect(option).toBeVisible();
  await option.click();
  await expect(field).toHaveAttribute('data-place', id);
  await expect(page.locator('[data-place-menu]')).toHaveCount(0);
}
