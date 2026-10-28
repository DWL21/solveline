import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../../src/fixtures.ts';

/**
 * 접근성 자동 점검(axe). 치명적(critical)·심각(serious) 위반은 실패로 막고, 보통(moderate) 이하는 리포트에 첨부해 추세를 본다.
 * 색 대비는 디자인 토큰(index.css)에서 고친다. 새 색을 쓸 때 이 점검이 깨지면 토큰을 조정한다.
 */
for (const [name, path] of [
  ['첫 화면', '/#/'],
  ['로그인', '/login'],
  ['약관', '/terms'],
] as const) {
  test(`접근성: ${name}`, { tag: '@R9' }, async ({ page }, testInfo) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
    const summary = result.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
    await testInfo.attach('axe-violations.json', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' });
    testInfo.annotations.push({ type: 'a11y', description: summary.map((v) => `${v.impact}:${v.id}(${v.nodes})`).join(', ') || '없음' });
    const blocking = result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(blocking, JSON.stringify(summary)).toEqual([]);
  });
}
