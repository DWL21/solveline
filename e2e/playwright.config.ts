import { defineConfig, devices } from '@playwright/test';
import { env } from './src/env.ts';

/**
 * 프로젝트(실행 단위)
 *   api              브라우저 없이 API 블랙박스(계약·권한·채점 상태) — 가장 빠르고 많이
 *   desktop-chromium UI 전체 시나리오
 *   desktop-webkit   UI 핵심 경로(@cross) — Safari 계열 호환
 *   mobile-iphone / mobile-pixel / tablet-ipad   반응형·터치 시나리오(@mobile, @tablet)
 *   smoke            운영 사이트 읽기 전용 확인(정기 실행)
 *
 * 요구사항 태그(@R1…@R11)로 기능별 실행: --grep @R3. 추적표는 docs/quality/test-cases.md
 * 시연 모드(E2E_DEMO=1)는 통과한 테스트도 영상·trace·스크린샷을 남긴다.
 *
 * 비결정적 실패를 숨기지 않도록 CI에서만 재시도 2회. 재시도로 통과한 테스트는 "불안정(flaky)"으로 집계해 리포트에 드러낸다.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './reports/artifacts',
  fullyParallel: true,
  forbidOnly: env.ci,
  failOnFlakyTests: env.ci,
  retries: env.ci ? 2 : 0,
  workers: env.ci ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    [env.ci ? 'github' : 'list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
    ['json', { outputFile: 'reports/results.json' }],
  ],
  use: {
    baseURL: env.baseURL,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: env.demo ? 'on' : 'retain-on-failure',
    screenshot: env.demo ? 'on' : 'only-on-failure',
    video: env.demo ? 'on' : 'retain-on-failure',
  },
  projects: [
    { name: 'api', testDir: './tests/api' },
    { name: 'desktop-chromium', testDir: './tests/ui', grepInvert: /@mobile|@tablet/, use: { ...devices['Desktop Chrome'] } },
    { name: 'desktop-webkit', testDir: './tests/ui', grep: /@cross/, use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-iphone', testDir: './tests/ui', grep: /@mobile/, use: { ...devices['iPhone 15'] } },
    { name: 'mobile-pixel', testDir: './tests/ui', grep: /@mobile/, use: { ...devices['Pixel 7'] } },
    { name: 'tablet-ipad', testDir: './tests/ui', grep: /@tablet/, use: { ...devices['iPad (gen 7)'] } },
    { name: 'smoke', testDir: './tests/smoke', use: { baseURL: env.productionURL } },
  ],
});
