import { test, expect } from '../../src/fixtures.ts';
import { evidence } from '../../src/evidence.ts';

/** 비회원: 둘러보기는 되고, 코드 작성·실행은 로그인 뒤 */
test.describe('비회원 둘러보기 @cross', { tag: '@R1' }, () => {
  test('첫 화면의 컬렉션 카드에서 문제를 열면 읽기 전용이고, 로그인하기가 보인다', async ({ page, home, seedProblem, editorApi }) => {
    const p = await seedProblem();
    const col = await editorApi.createCollection({ name: `E2E 둘러보기/${p.id.slice(0, 6)}`, description: '첫 줄 설명\n둘째 줄은 카드에 안 보인다' });
    await editorApi.setCollectionItems(col.id, [p.id]);

    await home.openCollections();
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

  test('컬렉션 경로의 제목과 돌아가기로 상위로 이동한다', async ({ page, home, seedProblem, editorApi }) => {
    const p = await seedProblem();
    const rootName = `E2E 계층 ${p.id.slice(0, 6)}`;
    const childName = `하위 ${p.id.slice(0, 6)}`;
    const grandchildName = `손자 ${p.id.slice(0, 6)}`;
    await editorApi.createCollection({ name: rootName, description: '' });
    await editorApi.createCollection({ name: `${rootName}/${childName}`, description: '' });
    await editorApi.createCollection({ name: `${rootName}/${childName}/${grandchildName}`, description: '' });

    await home.openCollections();
    const card = home.collectionCards.filter({ hasText: rootName });
    await expect(home.card(rootName)).toBeVisible();
    await expect(card.getByRole('button', { name: new RegExp(childName) })).toBeVisible();
    await expect(card.getByRole('button', { name: new RegExp(grandchildName) })).toHaveCount(0);
    await expect(home.search).toHaveCount(0);
    await expect(home.row(p.title)).toHaveCount(0);

    await home.card(rootName).click();
    await expect(home.heading).toContainText(rootName);
    await page.getByRole('navigation', { name: '컬렉션 경로' }).getByRole('button', { name: '컬렉션', exact: true }).click();
    await expect(home.heading).toContainText('컬렉션');
    await expect(home.card(rootName)).toBeVisible();

    await card.getByRole('button', { name: new RegExp(childName) }).click();
    await expect(home.heading).toContainText(childName);
    await page.getByRole('navigation', { name: '컬렉션 경로' }).getByRole('button', { name: rootName, exact: true }).click();
    await expect(home.heading).toContainText(rootName);
    await page.getByRole('region', { name: '하위 컬렉션' }).getByRole('button', { name: new RegExp(childName) }).click();
    await expect(home.heading).toContainText(childName);
    await page.getByRole('button', { name: '돌아가기', exact: true }).click();
    await expect(home.heading).toContainText(rootName);
  });

  test('첫 화면에서 전체 보기를 열고 새로고침해도 전체 문제를 볼 수 있다 @mobile', async ({ page, home, seedProblem, editorApi }) => {
    const p = await seedProblem();
    const col = await editorApi.createCollection({ name: `E2E 홈/${p.id.slice(0, 6)}`, description: '' });
    await editorApi.setCollectionItems(col.id, [p.id]);

    await home.openCollections();
    await expect(home.card(col.name.split('/')[0]!)).toBeVisible();
    await expect(home.search).toHaveCount(0);
    await expect(home.row(p.title)).toHaveCount(0);

    await home.showAll();
    await expect(page).toHaveURL(/#\/all$/);
    await expect(home.collectionCards).toHaveCount(0);
    await home.search.fill(p.title);
    await expect(home.row(p.title)).toBeVisible();

    await page.reload();
    await expect(home.heading).toContainText('전체 문제');
    await expect(page).toHaveURL(/#\/all$/);
    await home.search.fill(p.title);
    await expect(home.row(p.title)).toBeVisible();
    await home.logo().click();
    await expect(home.heading).toContainText('컬렉션');
    await expect(page).toHaveURL(/#\/$/);
  });

  test('로고를 누르면 컬렉션 카드가 보이는 첫 화면 맨 위로 간다', async ({ page, home, seedProblem }) => {
    const p = await seedProblem();
    await page.goto(`/#/p/${p.id}`);
    await page.getByTitle('문제 선택 화면으로').click();
    await expect(home.heading).toContainText('컬렉션');
    await expect(page).toHaveURL(/#\/$/);
  });
});
