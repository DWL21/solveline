import { test, expect } from '../../src/fixtures.ts';
import { sumSolutions } from '../../src/builders.ts';
import { evidence } from '../../src/evidence.ts';

/** 핵심 사용자 여정: 문제를 열고, 코드를 쓰고, 실행하고, 제출해 맞힌다 */
test.describe('문제 풀기', { tag: '@R3' }, () => {
  test.beforeEach(async ({ pageSignIn }) => {
    await pageSignIn();
  });

  test('정답 코드를 실행하고 제출하면 맞힘 표시가 남는다 @cross', async ({ page, home, workspace, seedProblem }) => {
    const p = await seedProblem();
    await workspace.open(p.id);
    await workspace.setCode(sumSolutions.java.correct);

    await workspace.run();
    await workspace.waitResult();
    await expect(page.getByText('2개 중 2개 성공')).toBeVisible();
    await evidence(page, '정답 코드를 실행하면 공개 테스트 2개가 모두 통과한다');

    await workspace.submit();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('정답입니다', { timeout: 60_000 });
    await evidence(page, '제출하면 히든 테스트로 채점하고 정답 대화상자를 보여 준다');
    await dialog.getByRole('button', { name: /닫기/ }).click();
    await page.getByTitle('문제 선택 화면으로').click();
    await expect(home.heading).toContainText('컬렉션');
    await home.showAll();
    await home.search.fill(p.title);
    await expect(home.row(p.title).getByLabel('해결')).toBeVisible();
    await evidence(page, '문제 목록에 해결(✓) 표시가 남는다');
  });

  test('오답이면 기댓값과 실행 결과를 비교해 보여 준다', async ({ page, workspace, seedProblem }) => {
    const p = await seedProblem({ language: 'python' });
    await workspace.open(p.id);
    await workspace.setCode(sumSolutions.python.wrong);
    await workspace.run();
    await workspace.waitResult();
    await expect(page.getByText('2개 중 0개 성공')).toBeVisible();
    await expect(page.getByText('✗ 실패').first()).toBeVisible();
    await evidence(page, '오답은 기댓값과 실제 값을 나란히 보여 준다');
  });

  test('컴파일 에러를 그대로 보여 준다', async ({ page, workspace, seedProblem }) => {
    const p = await seedProblem();
    await workspace.open(p.id);
    await workspace.setCode(sumSolutions.java.compileError);
    await workspace.run();
    await workspace.waitResult();
    await expect(page.getByText('컴파일 에러')).toBeVisible();
    await evidence(page, '컴파일 에러 메시지를 그대로 보여 준다');
  });

  test('작성한 코드는 서버에 자동 저장되어 새로고침해도 남는다', { tag: '@R7' }, async ({ page, pageApi, workspace, seedProblem }) => {
    const p = await seedProblem({ language: 'python' });
    await workspace.open(p.id);
    const marker = `# 자동 저장 ${Date.now()}`;
    await workspace.setCode(`${marker}\n${sumSolutions.python.correct}`);
    // 서버 동기화(입력이 멈추고 몇 초 뒤)를 기다린다 — 고정 대기 대신 조건을 폴링한다
    await expect.poll(async () => (await pageApi.problem(p.id)).code.python, { timeout: 45_000 }).toContain(marker);
    await page.reload();
    await expect(page.getByRole('textbox', { name: '코드 에디터' })).toContainText(marker);
  });
});
