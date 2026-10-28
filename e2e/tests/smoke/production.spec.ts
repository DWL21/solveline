import { test, expect } from '@playwright/test';

/**
 * 운영 스모크(읽기 전용, 정기 실행). 데이터를 만들거나 바꾸지 않는다.
 * 배포 뒤 핵심 경로가 살아 있는지 빠르게 확인하는 "건강 신호"다.
 */
test('API가 살아 있고 공개 설정을 돌려준다', { tag: '@R11' }, async ({ request }) => {
  expect((await request.get('/api/health')).ok()).toBe(true);
  const cfg = await (await request.get('/api/public/config')).json();
  expect(cfg.data.googleEnabled).toBe(true);
});

test('첫 화면이 컬렉션과 문제 목록을 보여 준다', { tag: ['@R11', '@R1'] }, async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('전체 문제');
  await expect(page.getByRole('region', { name: '컬렉션' }).getByRole('listitem').first()).toBeVisible();
});

test('문제 화면이 열리고 비회원은 로그인하기를 본다', { tag: ['@R11', '@R1'] }, async ({ page }) => {
  await page.goto('/#/');
  await page.getByRole('region', { name: '컬렉션' }).getByRole('listitem').first().click();
  // 문제 행의 버튼(제목 + 지원 언어)을 사용자가 보는 이름으로 찾는다
  await page.getByRole('listitem').getByRole('button', { name: /지원 언어/ }).first().click();
  await expect(page).toHaveURL(/#\/p\//);
  await expect(page.getByRole('textbox', { name: '코드 에디터' })).toBeVisible();
  await expect(page.getByRole('link', { name: '로그인하기' }).first()).toBeVisible();
});

test('약관·개인정보처리방침이 열린다', { tag: '@R11' }, async ({ page }) => {
  for (const [path, title] of [
    ['/terms', '이용약관'],
    ['/privacy', '개인정보처리방침'],
  ]) {
    await page.goto(path!);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(title!);
  }
});
