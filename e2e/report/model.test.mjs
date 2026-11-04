import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, parseCases, parseLlmQa, parseRequirements, parseThresholds } from './model.mjs';
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
  assert.equal(m.id, 'QA-TCR-PR7');
  assert.equal(m.version, '0.1');
  assert.equal(m.requirements.find((r) => r.id === 'R11').status, 'notRun');
  assert.match(m.deviations.join(), /R11.*머지 후/);
});
test('열린 잔여 위험이 있으면 조건부', () => {
  const m = buildModel(base({ register: { defects: [], risks: [{ id: 'RR-1', status: '열림' }], lessons: [] } }));
  assert.equal(m.verdict.status, 'conditional');
});
for (const [name, over, criterion] of [
  ['커버리지가 기준보다 낮으면', { metrics: metrics({ unit: { tests: 10, failed: 0, coverage: { lines: 79, branches: 70 } } }) }, 'Coverage thresholds met'],
  ['불안정 테스트가 있으면', { metrics: metrics({ e2e: { ...metrics().e2e, flaky: 1 } }) }, 'No flaky tests'],
  ['Sonar 게이트가 실패하면', { metrics: metrics({ sonar: { gate: 'ERROR' } }) }, 'Static analysis quality gate'],
  ['품질 리포트가 없으면', { metrics: null }, 'Unit tests all pass'],
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
  assert.match(broken.blockers.join(), /Production deployment/);
});
test('PR 제목 같은 외부 입력은 댓글과 문서에서 무력화한다', () => {
  const m = buildModel(base());
  const md = toMarkdown(m, {});
  assert.ok(md.startsWith(MARKER));
  assert.ok(!md.includes('<b>x</b>'));
  assert.ok(!md.includes('@someone'));
  assert.ok(!toHtml(m, {}).includes('<b>x</b>'));
});

test('PDF 링크가 있으면 댓글에 표지 미리보기와 PDF 링크를 싣는다', () => {
  const ctx = { ...base().context, links: { pdf: 'https://example.test/r.pdf', cover: 'https://example.test/c.png' } };
  const md = toMarkdown(buildModel(base({ context: ctx })), {});
  assert.match(md, /\*\*PDF:\*\* \[QA-TCR-PR7 v0\.1\.pdf\]\(https:\/\/example\.test\/r\.pdf\)/);
  assert.match(md, /<img src="https:\/\/example\.test\/c\.png"/);
});
test('개정 이력은 이전 판을 잇고 같은 판은 이번 것으로 바꾼다', () => {
  const ctx = { ...base().context, kind: 'final', version: '1.0', deploy: { conclusion: 'success' }, history: [{ version: '0.1', date: '2026-10-28T00:00:00Z', note: 'PR stage report (CI #1)' }, { version: '1.0', date: 'x', note: 'old' }] };
  const html = toHtml(buildModel(base({ context: ctx, smoke: { stats: { expected: 1 } } })), {});
  assert.match(html, /PR stage report \(CI #1\)/);
  assert.ok(!html.includes('>old<'));
});

test('LLM QA 결과가 있으면 절과 측정치에 더하고, 판정은 바꾸지 않는다', () => {
  const llmQa = parseLlmQa({
    request: { pr: 7, sha: 'a'.repeat(40) },
    result: { summary: '요약', scenarios: [{ title: '테마 유지', criterion: '새로고침해도 유지', verdict: 'pass', actual: '유지됨' }, { title: '제목 크기', criterion: '22px', verdict: 'fail', actual: '16px' }, { title: '첫 그리기', criterion: '깜빡임 없음', verdict: 'blocked', actual: '측정 못 함' }] },
    meta: { model: 'gpt-6.1-terra', effort: 'medium', seconds: 120 },
    error: null,
  });
  assert.deepEqual([llmQa.passed, llmQa.failed, llmQa.blocked], [1, 1, 1]);
  const m = buildModel(base({ llmQa, context: { ...base().context, note: 'PR stage report + LLM e2e QA (CI #1, LLM QA #2)' } }));
  assert.equal(m.verdict.status, 'pass');
  const comment = toMarkdown(m, { llm: 'https://llm' });
  assert.match(comment, /\*\*LLM e2e QA \(advisory\)\*\* — Pass 1 · Fail 1 · Not verified 1 · gpt-6.1-terra\/medium · 2 min · \[run\]\(https:\/\/llm\)/);
  assert.match(comment, /\| Fail \| 제목 크기 \| 22px \|/);
  const html = toHtml(m);
  assert.match(html, /6\.4 LLM e2e QA \(Advisory\)/);
  assert.match(html, /PR stage report \+ LLM e2e QA \(CI #1, LLM QA #2\)/);
  assert.equal(parseLlmQa({ request: null, result: null, meta: null, error: null }), null);
});
test('LLM QA를 끝내지 못했으면 계획 대비 차이에 적는다', () => {
  const llmQa = parseLlmQa({ request: { pr: 7 }, result: null, meta: null, error: '테스트 환경이 뜨지 않았습니다.\n' });
  const m = buildModel(base({ llmQa }));
  assert.ok(m.deviations.includes('LLM QA를 끝내지 못했다: 테스트 환경이 뜨지 않았습니다.'));
  assert.match(toMarkdown(m), /Error: 테스트 환경이 뜨지 않았습니다\./);
});
test('댓글은 최신 판만 펼치고 이전 판은 접은 목록에 PDF 링크와 함께 둔다', () => {
  const history = [
    { version: '0.1', date: '2026-11-03T16:49:52Z', note: 'PR stage report (CI #1)' },
    { version: '0.2', date: '2026-11-03T16:51:58Z', note: 'PR stage report + LLM e2e QA (CI #1, LLM QA #2)' },
  ];
  const m = buildModel(base({ context: { ...base().context, version: '0.3', history, links: { pdf: 'https://x/pr-7/QA-TCR-PR7-v0.3.pdf' } } }));
  const comment = toMarkdown(m);
  assert.match(comment.split('\n')[1], /^<!-- version: 0\.3 -->$/);
  assert.match(comment, /<details><summary>이전 판 2개<\/summary>/);
  assert.ok(comment.indexOf('| 0.2 |') < comment.indexOf('| 0.1 |'), '최근 판이 위');
  assert.match(comment, /\[v0\.1\]\(https:\/\/x\/pr-7\/QA-TCR-PR7-v0\.1\.pdf\)/);
  assert.equal(toMarkdown(buildModel(base())).includes('이전 판'), false);
});
