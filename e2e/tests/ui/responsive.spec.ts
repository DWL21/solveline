import { test, expect } from '../../src/fixtures.ts';
import { sumSolutions } from '../../src/builders.ts';
import { evidence } from '../../src/evidence.ts';

/** 휴대폰(@mobile)·태블릿(@tablet) 배치. 프로젝트(기기)별로 같은 시나리오가 돈다. */
test.describe('휴대폰 문제 화면 @mobile', { tag: '@R8' }, () => {
  test('코드 탭은 상단 메뉴를 숨기고, 실행하면 결과 탭으로 넘어간다', async ({ page, pageSignIn, seedProblem, workspace }) => {
    const p = await seedProblem({ language: 'python' });
    await pageSignIn();
    await workspace.open(p.id);

    await expect(workspace.tabs).toBeVisible();
    await workspace.showPane('코드');
    await expect(page.getByTitle('문제 선택 화면으로')).toBeHidden();
    await workspace.setCode(sumSolutions.python.correct);
    await workspace.run();
    await expect(workspace.tabs.getByRole('button', { name: /결과/ })).toHaveAttribute('aria-pressed', 'true');
    await workspace.waitResult();
    await expect(page.getByText('2개 중 2개 성공')).toBeVisible();
    await evidence(page, '휴대폰에서 실행하면 결과 탭으로 넘어가고 상단 메뉴를 숨긴다');
    // 결과 탭도 상단 메뉴를 숨긴다
    await expect(page.getByTitle('문제 선택 화면으로')).toBeHidden();
    await workspace.showPane('문제');
    await expect(page.getByTitle('문제 선택 화면으로')).toBeVisible();
  });

  test('화면이 옆으로 넘치지 않는다', async ({ page, seedProblem }) => {
    const p = await seedProblem();
    for (const path of ['/#/', `/#/p/${p.id}`, '/terms']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });
});

test.describe('태블릿 @tablet', { tag: '@R8' }, () => {
  test('문제와 에디터를 좌우로 나눠 보여 준다(탭 없음)', async ({ page, seedProblem, workspace }) => {
    const p = await seedProblem();
    await workspace.open(p.id);
    await expect(workspace.tabs).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '코드 에디터' })).toBeVisible();
    await expect(page.getByText(p.title).first()).toBeVisible();
    await evidence(page, '태블릿은 문제와 에디터를 좌우로 나눠 보여 준다');
  });
});
