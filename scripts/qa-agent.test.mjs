import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTask, checkPatch, decideAgent, issueComment, kindOf, MARKER, prBody, title } from './qa-agent.mjs';

// 결정표: 한 줄이 판정 하나. policy.json의 agent를 바꾸면 이 표도 함께 고친다(0011)
const issue = (over = {}) => ({
  number: 7, title: 'test(e2e): 테마가 새로고침 뒤에도 유지된다', body: '## 범위\n\n```ts\ntest()\n```', labels: ['test', 'qa:llm', 'qa:agent'],
  label: 'qa:agent', state: 'open', isPullRequest: false, senderPermission: 'admin', ...over,
});
const table = [
  ['관리자가 테스트 이슈에 qa:agent', {}, 'run', 'test'],
  ['쓰기 권한자', { senderPermission: 'write' }, 'run', 'test'],
  ['읽기 권한자(외부인)', { senderPermission: 'read' }, 'skip', null],
  ['권한 없음', { senderPermission: 'none' }, 'skip', null],
  ['다른 레이블을 붙임', { label: 'bug' }, 'skip', null],
  ['닫힌 이슈', { state: 'closed' }, 'skip', null],
  ['PR에 붙임', { isPullRequest: true }, 'skip', null],
  ['아직 맡지 않는 종류(bug)', { labels: ['bug', 'qa:agent'] }, 'reject', null],
];
for (const [name, over, action, kind] of table) {
  test(`판정: ${name} → ${action}`, () => {
    const d = decideAgent(issue(over));
    assert.equal(d.action, action);
    assert.equal(d.kind, kind);
    assert.ok(d.reason);
  });
}

test('종류는 정책에 있는 레이블로만 고른다', () => {
  assert.equal(kindOf(['test']), 'test');
  assert.equal(kindOf(['docs', 'bug']), null);
});

test('작업서: 허용 경로를 담고 이슈 글은 길이를 자른다', () => {
  const t = buildTask(issue({ body: 'x'.repeat(20000) }), 'a'.repeat(40));
  assert.deepEqual(t.allowedPaths, ['e2e/']);
  assert.equal(t.kind, 'test');
  assert.equal(t.body.length, 12000);
  assert.equal(t.baseSha, 'a'.repeat(40));
});

const diffOf = (...files) =>
  files.map((f) => `diff --git a/${f} b/${f}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,2 @@\n+line1\n+line2\n`).join('');

test('패치 검사: 테스트 종류는 e2e/ 안만 허용한다', () => {
  assert.deepEqual(checkPatch(diffOf('e2e/tests/ui/theme.spec.ts'), 'test'), { ok: true, reason: '검사 통과', files: ['e2e/tests/ui/theme.spec.ts'], lines: 2 });
  assert.match(checkPatch(diffOf('e2e/tests/a.spec.ts', 'apps/web/src/App.tsx'), 'test').reason, /바꿀 수 없는 경로입니다: apps\/web\/src\/App\.tsx/);
});

test('패치 검사: 거부 목록(워크플로·QA 스크립트·의존성)은 허용 경로 안이어도 막는다', () => {
  for (const f of ['.github/workflows/ci.yml', 'scripts/llm-qa/policy.json', 'e2e/package.json', 'pnpm-lock.yaml', 'compose.test.yaml', 'AGENTS.md']) {
    assert.equal(checkPatch(diffOf(f), 'test').ok, false, f);
  }
});

test('패치 검사: 빈 패치·바이너리·크기 초과·모르는 종류는 막는다', () => {
  assert.equal(checkPatch('', 'test').reason, '바꾼 것이 없습니다');
  assert.equal(checkPatch(`${diffOf('e2e/a.png')}GIT binary patch\nliteral 1\n`, 'test').reason, '바이너리 파일은 받지 않습니다');
  assert.match(checkPatch(diffOf(...Array.from({ length: 21 }, (_, i) => `e2e/t${i}.spec.ts`)), 'test').reason, /파일이 너무 많습니다/);
  const big = `diff --git a/e2e/a.spec.ts b/e2e/a.spec.ts\n--- a/e2e/a.spec.ts\n+++ b/e2e/a.spec.ts\n${'+x\n'.repeat(801)}`;
  assert.match(checkPatch(big, 'test').reason, /줄이 너무 많습니다\(801줄/);
  assert.match(checkPatch(diffOf('e2e/a.spec.ts'), 'bug').reason, /모르는 종류/);
});

test('패치 검사: 파일 이름을 바꾼 경우 옛 경로와 새 경로를 모두 본다', () => {
  const rename = 'diff --git a/apps/web/x.ts b/e2e/x.ts\nsimilarity index 100%\nrename from apps/web/x.ts\nrename to e2e/x.ts\n';
  assert.equal(checkPatch(rename, 'test').ok, false);
});

test('제목은 Conventional Commits 형식이고 이슈의 접두사는 바꾼다', () => {
  assert.equal(title(issue(), 'test'), 'test(e2e): 테마가 새로고침 뒤에도 유지된다');
  assert.equal(title(issue({ title: '저장 버튼 확인' }), 'test'), 'test(e2e): 저장 버튼 확인');
});

test('PR 본문: 사람 검토 안내·변경·검증 표·Closes를 담고 멘션을 끊는다', () => {
  const body = prBody({
    issue: issue(),
    report: { summary: '@owner 테스트를 더했다', changes: [{ file: 'e2e/tests/ui/theme.spec.ts', what: '테마 유지' }], notes: '' },
    verify: { steps: [{ name: 'e2e 타입 검사', result: 'pass', detail: '' }, { name: '바뀐 e2e 실행', result: 'fail', detail: '1 failed | 2 passed' }] },
    check: { ok: true, files: ['e2e/tests/ui/theme.spec.ts'], lines: 30 },
    runUrl: 'https://run',
  });
  assert.match(body, /사람이 검토한 뒤 머지/);
  assert.match(body, /\| 패치 검사\(경로·크기\) \| ✓ 통과 \| 1개 파일, 30줄 \|/);
  assert.match(body, /\| 바뀐 e2e 실행 \| ✗ 실패 \| 1 failed \\\| 2 passed \|/);
  assert.match(body, /Closes #7/);
  assert.ok(!body.includes('@owner'));
});

test('이슈 진행 댓글은 표식으로 시작한다', () => {
  assert.ok(issueComment({ state: 'start', runUrl: 'https://run' }).startsWith(MARKER));
  assert.match(issueComment({ state: 'failed', reason: '바꾼 것이 없습니다', runUrl: 'r' }), /PR을 만들지 못했습니다: 바꾼 것이 없습니다/);
});
