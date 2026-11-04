import { test, expect } from '@playwright/test';

test('rejects an invalid login without entering the app', async ({ page }) => {
  await page.goto('/');
  await page.locator('#login').fill('admin');
  await page.locator('#password').fill('invalid-ci-password');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#login')).toBeVisible();
});

test('signs in, preserves the session after reload, then signs out', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.locator('#login').fill('admin');
  await page.locator('#password').fill(process.env.CI_BROWSER_PASSWORD);
  await page.locator('button[type="submit"]').click();
  const userMenu = page.getByRole('button', { name: 'User menu: Admin', exact: true });
  await expect(userMenu).toBeVisible();
  await page.reload();
  await expect(userMenu).toBeVisible();
  await userMenu.click();
  await page.getByRole('menuitem', { name: 'Log out', exact: true }).click();
  await expect(page.locator('#login')).toBeVisible();
  expect(errors).toEqual([]);
});
