import { expect, type Page } from '@playwright/test';

/** 페이지 객체: 관리자 모드(마스터 비밀번호) */
export class AdminPage {
  constructor(readonly page: Page) {}

  async login(password: string) {
    await this.page.goto('/admin');
    await this.page.getByLabel('비밀번호').fill(password);
    await this.page.getByRole('button', { name: '들어가기' }).click();
    await expect(this.page.getByText('관리자 모드').first()).toBeVisible();
  }

  async openUser(email: string) {
    await this.page.getByRole('textbox', { name: '사용자 검색' }).fill(email);
    await this.page.getByText(email, { exact: true }).first().click();
  }

  async grantEditor() {
    await this.page.getByRole('button', { name: '편집 권한 주기' }).click();
    await expect(this.page.getByRole('button', { name: '편집 권한 회수' })).toBeVisible();
  }
}
