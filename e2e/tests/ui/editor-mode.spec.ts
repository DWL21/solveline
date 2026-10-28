import { test, expect } from '../../src/fixtures.ts';

/** 편집 권한: 편집 모드에서 바꾼 공용 내용은 모든 사용자에게 보인다 */
test('편집 모드에서 제목을 바꾸면 다른 사용자에게도 적용된다', { tag: '@R5' }, async ({ page, pageSignIn, api, signIn, seedProblem, workspace }) => {
  const p = await seedProblem();
  await pageSignIn({ editor: true });
  await workspace.open(p.id);
  await page.getByRole('button', { name: '편집 모드' }).click();
  await expect(page.getByText(/편집 모드 · 바꾼 내용은 모든 사용자에게/)).toBeVisible();
  const title = page.getByRole('textbox', { name: '문제 제목' });
  await title.fill(`${p.title} (수정)`);
  await signIn();
  await expect.poll(async () => (await api.problem(p.id)).title, { timeout: 45_000 }).toBe(`${p.title} (수정)`);
});

test('편집 권한이 없으면 편집 모드 버튼이 없다', { tag: ['@R5', '@R2'] }, async ({ page, pageSignIn, seedProblem, workspace }) => {
  const p = await seedProblem();
  await pageSignIn();
  await workspace.open(p.id);
  await expect(page.getByRole('button', { name: '편집 모드' })).toHaveCount(0);
});
