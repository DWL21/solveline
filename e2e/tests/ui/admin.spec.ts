import { test, expect, emailFor } from '../../src/fixtures.ts';
import { Api } from '../../src/api.ts';
import { AdminPage } from '../../src/pages/AdminPage.ts';
import { env } from '../../src/env.ts';

test('관리자 모드에서 편집 권한을 주면 그 사용자가 바로 편집할 수 있다', { tag: '@R6' }, async ({ page, playwright, baseURL }) => {
  const userApi = new Api(await playwright.request.newContext({ baseURL }));
  const email = emailFor('promote');
  await userApi.signIn(email);
  expect((await userApi.session()).user?.editor).toBe(false);

  const admin = new AdminPage(page);
  await admin.login(env.masterPassword);
  await admin.openUser(email);
  await admin.grantEditor();

  expect((await userApi.session()).user?.editor).toBe(true);
  await userApi.request.dispose();
});

test('마스터 비밀번호가 틀리면 들어갈 수 없다', { tag: ['@R6', '@R2'] }, async ({ page }) => {
  await page.goto('/admin');
  await page.getByLabel('비밀번호').fill('wrong-password-for-e2e-0000');
  await page.getByRole('button', { name: '들어가기' }).click();
  await expect(page.getByRole('alert')).toContainText('비밀번호');
});
