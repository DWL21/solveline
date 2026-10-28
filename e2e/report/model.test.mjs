import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, parseCases, parseRequirements, parseThresholds } from './model.mjs';
import { MARKER, toHtml, toMarkdown } from './render.mjs';

const requirements = parseRequirements('| 번호 | 요구사항 |\n|---|---|\n| R1 | 둘러보기 | 중간 | UI 4 |\n| R11 | 운영 | 큼 | 스모크 4 |\n| TC-01 | R1 | x |');
const results = {
  suites: [{
    title: 'ui/a.spec.ts', file: 'ui/a.spec.ts',
    suites: [{
      title: '비회원 @cross', file: 'ui/a.spec.ts',
      specs: [{
        title: '문제를 연다', tags: ['R1', 'cross'],
        tests: [{ projectName: 'desktop-chromium', status: 'expected', results: [{ duration: 1200, attachments: [{ name: 'evidence: 읽기 전용', path: '/home/runner/work/x/e2e/reports/artifacts/t/evidence-1.png' }, { name: 'trace', path: '/x/trace.zip' }] }] }],
      }],
    }],
  }],
};
const metrics = (over = {}) => ({
  unit: { tests: 10, failed: 0, coverage: { lines: 90, branches: 70, functions: 90, statements: 90 } },
  e2e: { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0, firstTryPassRate: 100, byProject: { 'desktop-chromium': { total: 1, passed: 1, failed: 0, flaky: 0, skipped: 0, durationMs: 1200 } } },
  sonar: { gate: 'OK', measures: {} },
  ...over,
});
const base = (over = {}) => ({
  context: { kind: 'pr', sha: 'abcdef1234', pr: { number: 7, title: 'feat: <b>x</b> | y @someone' }, run: { id: 1, jobs: [{ name: 'check', conclusion: 'success' }] } },
  metrics: metrics(),
  results,
  smoke: null,
  register: { defects: [{ id: 'D-1', summary: 's', severity: 'S2', foundIn: '정적 분석', status: '해결' }], risks: [], lessons: [] },
  requirements,
  thresholds: parseThresholds('coverage: { thresholds: { lines: 80, branches: 66 } }'),
  ...over,
});

test('요구사항 표만 읽고 테스트 케이스 행은 건너뛴다', () => {
  assert.deepEqual(requirements.map((r) => r.id), ['R1', 'R11']);
});
test('describe 경로를 제목에 붙이고 증거 첨부를 아티팩트 상대 경로로 바꾼다', () => {
  const [c] = parseCases(results);
  assert.equal(c.title, '비회원 › 문제를 연다');
  assert.deepEqual(c.requirements, ['R1']);
  assert.deepEqual(c.evidence, [{ caption: '읽기 전용', path: 'artifacts/t/evidence-1.png' }]);
});
test('모든 종료 기준을 충족하면 머지 가능, R11은 머지 후 확인으로 차이에 남긴다', () => {
  const m = buildModel(base());
  assert.equal(m.verdict.status, 'pass');
  assert.equal(m.id, 'QA-TCR-PR7-P');
  assert.equal(m.requirements.find((r) => r.id === 'R11').status, 'notRun');
  assert.match(m.deviations.join(), /R11.*머지 후/);
});
test('열린 잔여 위험이 있으면 조건부', () => {
  const m = buildModel(base({ register: { defects: [], risks: [{ id: 'RR-1', status: '열림' }], lessons: [] } }));
  assert.equal(m.verdict.status, 'conditional');
});
for (const [name, over, criterion] of [
  ['커버리지가 기준보다 낮으면', { metrics: metrics({ unit: { tests: 10, failed: 0, coverage: { lines: 79, branches: 70 } } }) }, '커버리지 기준 이상'],
  ['불안정 테스트가 있으면', { metrics: metrics({ e2e: { ...metrics().e2e, flaky: 1 } }) }, '불안정 테스트 없음'],
  ['Sonar 게이트가 실패하면', { metrics: metrics({ sonar: { gate: 'ERROR' } }) }, '정적 분석 품질 게이트'],
  ['품질 리포트가 없으면', { metrics: null }, '단위 테스트 전부 통과'],
]) {
  test(`${name} 머지 보류`, () => {
    const m = buildModel(base(over));
    assert.equal(m.verdict.status, 'fail');
    assert.equal(m.criteria.find((c) => c.name === criterion).met, false);
  });
}
test('머지 후 보고서는 배포와 운영 스모크를 종료 기준에 더한다', () => {
  const ctx = { ...base().context, kind: 'final', deploy: { conclusion: 'success' } };
  const smoke = { stats: { expected: 4, unexpected: 0, flaky: 0, skipped: 0 } };
  const ok = buildModel(base({ context: ctx, smoke }));
  assert.equal(ok.verdict.status, 'pass');
  assert.equal(ok.requirements.find((r) => r.id === 'R11').passed, 4);
  const broken = buildModel(base({ context: { ...ctx, deploy: { conclusion: 'failure' } }, smoke }));
  assert.equal(broken.verdict.status, 'fail');
  assert.match(broken.blockers.join(), /운영 배포/);
});
test('PR 제목 같은 외부 입력은 댓글과 문서에서 무력화한다', () => {
  const m = buildModel(base());
  const md = toMarkdown(m, {});
  assert.ok(md.startsWith(MARKER.pr));
  assert.ok(!md.includes('<b>x</b>'));
  assert.ok(md.includes('\\|'));
  assert.ok(!md.includes('@someone'));
  assert.ok(!toHtml(m, {}).includes('<b>x</b>'));
});
