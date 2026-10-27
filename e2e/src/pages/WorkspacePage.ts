import { expect, type Locator, type Page } from '@playwright/test';

/**
 * 페이지 객체: 문제 풀이 화면. 데스크톱(좌우 분할)과 휴대폰(문제·코드·결과 탭)을 같은 메서드로 다룬다.
 * 에디터(CodeMirror)는 붙여 넣기와 같은 insertText로 입력해 자동 들여쓰기·괄호 짝 영향을 받지 않게 한다.
 */
export class WorkspacePage {
  readonly editor: Locator;
  readonly runButton: Locator;
  readonly submitButton: Locator;
  readonly result: Locator;
  readonly saveState: Locator;
  readonly tabs: Locator;

  constructor(readonly page: Page) {
    this.editor = page.getByRole('textbox', { name: '코드 에디터' });
    this.runButton = page.getByRole('button', { name: '코드 실행' });
    this.submitButton = page.getByRole('button', { name: /^제출 후 채점/ });
    this.result = page.locator('section').filter({ has: page.getByText(/실행 결과가 여기에|테스트 \d|테스트 결과|채점|컴파일 에러|실행할 테스트/) }).last();
    this.saveState = page.getByText(/저장됨|저장 중|저장 실패/).first();
    this.tabs = page.getByRole('navigation', { name: '문제 화면' });
  }

  async open(problemId: string) {
    await this.page.goto(`/#/p/${problemId}`);
    await expect(this.page.getByRole('heading', { level: 1 })).toBeVisible();
  }

  /** 휴대폰 탭(문제·코드·결과). 데스크톱에서는 아무것도 하지 않는다. */
  async showPane(name: '문제' | '코드' | '결과') {
    if (!(await this.tabs.isVisible())) return;
    await this.tabs.getByRole('button', { name: new RegExp(name) }).click();
  }

  /** 에디터 내용을 통째로 바꾼다 */
  async setCode(code: string) {
    await this.showPane('코드');
    await this.editor.click();
    await this.page.keyboard.press('ControlOrMeta+A');
    await this.page.keyboard.press('Delete');
    await this.page.keyboard.insertText(code);
  }

  async language(name: 'Java' | 'Python3') {
    await this.page.getByRole('combobox', { name: '언어' }).selectOption({ label: name });
  }

  /** 휴대폰에서는 키보드(에디터 초점)가 열려 있으면 실행 바가 숨는다 → 초점을 빼고 누른다 */
  private async focusOut() {
    await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }

  async run() {
    await this.focusOut();
    await this.runButton.click();
  }

  async submit() {
    await this.focusOut();
    await this.submitButton.click();
  }

  /** 실행·채점이 끝날 때까지 기다린 뒤 결과 영역 텍스트 */
  async waitResult(timeout = 60_000) {
    await expect(this.page.getByText(/개 중 \d+개 (성공|통과)|컴파일 에러|정답입니다|실행하지 못했어요/).first()).toBeVisible({ timeout });
  }

  verdict(n: number) {
    return this.page.getByText(`테스트 ${n}`, { exact: true }).locator('..');
  }
}
