import { expect, type Locator, type Page } from '@playwright/test';

/** 페이지 객체: 첫 화면(문제 목록·컬렉션 카드). 화면 구조를 숨기고 사용자가 하는 일 단위로 메서드를 둔다. */
export class HomePage {
  readonly heading: Locator;
  readonly search: Locator;
  readonly collectionCards: Locator;

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { level: 1 });
    this.search = page.getByRole('textbox', { name: '문제 검색' });
    this.collectionCards = page.getByRole('region', { name: '컬렉션' }).getByRole('listitem');
  }

  async open() {
    await this.page.goto('/#/');
    await expect(this.heading).toContainText('전체 문제');
  }

  /** 제목으로 검색해 문제를 연다 */
  async openProblem(title: string) {
    await this.search.fill(title);
    await this.page.getByRole('button', { name: title }).click();
  }

  row(title: string) {
    return this.page.getByRole('button', { name: title });
  }

  card(name: string) {
    return this.collectionCards.filter({ hasText: name });
  }

  logo() {
    return this.page.getByRole('link', { name: 'Solveline' }).or(this.page.getByTitle('문제 선택 화면으로')).first();
  }
}
