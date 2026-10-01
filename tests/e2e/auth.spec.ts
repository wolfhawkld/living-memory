import { request as playwrightRequest } from '@playwright/test';
import { expect, test, TEST_OWNER_PASSWORD, TEST_OWNER_USERNAME } from './fixtures';

test('authenticated browser sessions reject anonymous API clients, logout, and survive re-login', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('.account-name')).toHaveText(TEST_OWNER_USERNAME);
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();

  const anonymous = await playwrightRequest.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const response = await anonymous.get('/api/snapshot');
    expect(response.status()).toBe(401);
  } finally {
    await anonymous.dispose();
  }

  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录你的知识空间', exact: true })).toBeVisible();

  const afterLogout = await context.request.get('/api/snapshot');
  expect(afterLogout.status()).toBe(401);

  await page.getByLabel('用户名', { exact: true }).fill(TEST_OWNER_USERNAME);
  await page.getByLabel('密码', { exact: true }).fill(TEST_OWNER_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.account-name')).toHaveText(TEST_OWNER_USERNAME);
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();

  const afterLogin = await context.request.get('/api/snapshot');
  expect(afterLogin.status()).toBe(200);

  await page.reload();
  await expect(page.locator('.account-name')).toHaveText(TEST_OWNER_USERNAME);
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
});
