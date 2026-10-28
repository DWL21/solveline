import { defineConfig } from 'vitest/config';

/** 단위·통합(인메모리) 테스트. 커버리지는 SonarQube가 읽는 lcov와 리포트용 요약(json-summary)으로 남긴다. */
export default defineConfig({
  test: {
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'reports/junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      reporter: ['text-summary', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      // 래칫: 내려가면 실패. 올라가면 기준도 올린다.
      thresholds: { lines: 90, statements: 88, functions: 88, branches: 72 },
    },
  },
});
