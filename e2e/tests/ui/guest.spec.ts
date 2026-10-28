import { test, expect } from '../../src/fixtures.ts';
import { evidence } from '../../src/evidence.ts';

/** 비회원: 둘러보기는 되고, 코드 작성·실행은 로그인 뒤 */
test.describe('비회원 둘러보기 @cross', { tag: '@R1' }, () => {
  test('첫 화면의 컬렉션 카드에서 문제를 열면 읽기 전용이고, 로그인하기가 보인다', async ({ page, home, seedProblem, editorApi }) => {
    const p = await seedProblem();
    const col = await editorApi.createCollection({ name: `E2E 둘러보기/${p.id.slice(0, 6)}`, description: '첫 줄 설명\n둘째 줄은 카드에 안 보인다' });
    await editorApi.setCollectionItems(col.id, [p.id]);

    await home.open();
    const card = home.card(col.name.split('/')[0]!);
    await expect(card).toBeVisible();
    await card.click();
    await page.getByRole('button', { name: p.title }).click();

    await expect(page.getByRole('heading', { level: 1, name: p.title })).toBeVisible();
    await expect(page.getByRole('link', { name: '로그인하기' }).first()).toBeVisible();
    // 구현(속성)이 아니라 동작으로 확인한다: 입력해도 코드가 바뀌지 않는다
    const editor = page.getByRole('textbox', { name: '코드 에디터' });
    const before = await editor.textContent();
    await editor.click();
    await page.keyboard.insertText('// 비회원 입력');
    await expect(editor).toHaveText(before ?? '');
    await evidence(page, '비회원은 문제를 읽기 전용으로 보고 로그인하기 안내를 본다');
  });

  test('로고를 누르면 컬렉션 카드가 보이는 첫 화면 맨 위로 간다', async ({ page, home, seedProblem }) => {
    const p = await seedProblem();
    await page.goto(`/#/p/${p.id}`);
    await page.getByTitle('문제 선택 화면으로').click();
    await expect(home.heading).toContainText('전체 문제');
    await expect(page).toHaveURL(/#\/$/);
  });
});
