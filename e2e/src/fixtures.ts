import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type { Problem } from '@solveline/shared';
import { Api } from './api.ts';
import { aProblem, uid } from './builders.ts';
import { HomePage } from './pages/HomePage.ts';
import { WorkspacePage } from './pages/WorkspacePage.ts';

/**
 * 공용 픽스처. 테스트마다 새 사용자·새 데이터를 만든다(공유 상태 없음 → 병렬 실행·재실행에 안전).
 *   api        브라우저 없는 API 클라이언트(API 테스트용, 처음엔 비회원)
 *   signIn     api를 새 사용자로 로그인시킨다. editor: 편집 권한
 *   pageApi    브라우저 페이지와 쿠키를 함께 쓰는 API 클라이언트(UI 테스트용)
 *   pageSignIn 브라우저 페이지를 새 사용자로 로그인시킨다(Google 왕복 대신 테스트 전용 로그인)
 *   editorApi  편집 권한 사용자의 별도 API 클라이언트(데이터 준비용)
 *   seedProblem  편집 권한으로 문제를 만든다(빌더 기본값 + 덮어쓰기)
 *   home, workspace  페이지 객체
 */
type SignIn = (opts?: { editor?: boolean }) => Promise<{ email: string }>;
type Fixtures = {
  api: Api;
  signIn: SignIn;
  pageApi: Api;
  pageSignIn: SignIn;
  editorApi: Api;
  seedProblem: (overrides?: Parameters<typeof aProblem>[0]) => Promise<Problem>;
  home: HomePage;
  workspace: WorkspacePage;
};

export const emailFor = (role: string) => `${role}-${uid()}@e2e.test`;

const signInWith = (api: Api): SignIn => async (opts = {}) => {
  const email = emailFor(opts.editor ? 'editor' : 'user');
  await api.signIn(email, opts);
  return { email };
};

export const test = base.extend<Fixtures>({
  api: async ({ request }, use) => use(new Api(request)),
  signIn: async ({ api }, use) => use(signInWith(api)),
  pageApi: async ({ context }, use: (a: Api) => Promise<void>) => use(new Api((context as BrowserContext).request)),
  pageSignIn: async ({ pageApi }, use) => use(signInWith(pageApi)),
  editorApi: async ({ playwright, baseURL }, use) => {
    const request = await playwright.request.newContext({ baseURL });
    const api = new Api(request);
    await api.signIn(emailFor('seed-editor'), { editor: true });
    await use(api);
    await request.dispose();
  },
  seedProblem: async ({ editorApi }, use) => use((overrides) => editorApi.createProblem(aProblem(overrides))),
  home: async ({ page }, use) => use(new HomePage(page)),
  workspace: async ({ page }, use) => use(new WorkspacePage(page)),
});

export { expect, type Page };
