import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../../src/fixtures.ts';

/**
 * 접근성 자동 점검(axe). 치명적(critical) 위반은 실패로 막고, 심각(serious) 이하는 리포트에 첨부해 추세를 본다.
 * 기준을 한 번에 올리지 않고 단계적으로 조인다(품질 게이트를 현실에 맞게 운영).
 */
for (const [name, path] of [
  ['첫 화면', '/#/'],
  ['로그인', '/login'],
  ['약관', '/terms'],
] as const) {
  test(`접근성: ${name}`, async ({ page }, testInfo) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const summary = result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
    await testInfo.attach('axe-violations.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
    testInfo.annotations.push({ type: 'a11y', description: summary.map((v) => `${v.impact}:${v.id}(${v.nodes})`).join(', ') || '없음' });
    expect(result.violations.filter((v) => v.impact === 'critical'), JSON.stringify(summary)).toEqual([]);
  });
}
