import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRequest, comment, counts, fingerprint, issueDrafts, linkShots, MARKER, MAX_ISSUES, relevant, safe, section, status } from './llm-qa-report.mjs';

const script = fileURLToPath(new URL('./llm-qa-report.mjs', import.meta.url));
const scenario = (verdict, i = 1) => ({
  id: `S${i}`,
  title: `시나리오 ${i}`,
  criterion: '기기 설정을 따른다',
  steps: ['http://localhost:8091/ 을 연다', '새로고침한다'],
  expected: '라이트로 뜬다',
  actual: verdict === 'fail' ? '다크로 떴다' : '라이트로 떴다',
  verdict,
  evidence: ['스크린샷: page-2026-11-03T13-32-24-388Z.png', '콘솔 CSP 오류 2건'],
});
const result = (...verdicts) => ({ summary: '요약', scenarios: verdicts.map((v, i) => scenario(v, i + 1)), suggestions: [] });
const request = { pr: 171, sha: '9abf4260000000000000000000000000000000ff' };

test('화면·API 코드를 바꾼 PR만 대상이다', () => {
  assert.equal(relevant(['docs/a.md', '.github/workflows/ci.yml']), false);
  assert.equal(relevant(['apps/web/src/App.tsx']), true);
  assert.equal(relevant(['packages/shared/src/index.ts']), true);
});

test('모델·PR 글의 멘션과 이슈 자동 연결을 끊고 HTML을 막는다', () => {
  const s = safe('@owner 님 #12 확인 <img src=x>');
  assert.ok(!s.includes('@owner') && !s.includes('#12') && !s.includes('<img'));
  assert.equal(safe('가'.repeat(10), 5), '가가가가가…');
});

test('요청서: 이슈의 완료 기준과 PR의 변경 사항 절만 꺼낸다', () => {
  const body = '## 변경 사항\n\n- 테마 추가 ![x](y.png)\n\n## 검증\n\n- 실행';
  const issue = { number: 170, body: '## 배경\n\n..\n\n## 완료 기준\n\n- [ ] 기기 설정을 따른다\n- 새로고침해도 유지된다\n' };
  const r = buildRequest({ pr: 171, sha: 'a'.repeat(40), title: 't', body, files: ['apps/web/a.ts'], issues: [issue] });
  assert.deepEqual(r.criteria, ['#170: 기기 설정을 따른다', '#170: 새로고침해도 유지된다']);
  assert.equal(r.changes, '- 테마 추가');
  assert.equal(section('## 완료 기준\n- 끝', '완료 기준'), '- 끝');
});

test('상태: 실패가 있으면 failure, 확인 못 함만 섞이면 success에 설명으로 드러낸다', () => {
  assert.deepEqual(status({ result: result('pass', 'pass') }), { state: 'success', description: '통과 2 · 실패 0 · 확인 못 함 0' });
  assert.equal(status({ result: result('pass', 'blocked') }).description, '통과 1 · 실패 0 · 확인 못 함 1 — 댓글 확인');
  assert.equal(status({ result: result('pass', 'fail', 'blocked') }).state, 'failure');
  assert.equal(status({ result: result() }).state, 'error');
  const err = status({ error: '테스트 환경이 뜨지 않았습니다.'.repeat(20) });
  assert.equal(err.state, 'error');
  assert.ok(err.description.length <= 140);
});

test('댓글: 표식으로 시작하고, 결과를 ✓/✗/– 문구로, 실패는 재현 단계와 스크린샷 링크까지 적는다', () => {
  const body = comment({ result: result('pass', 'fail', 'blocked'), meta: { model: 'gpt-6.1-terra', effort: 'medium', seconds: 90 }, pr: 171, sha: request.sha, runUrl: 'https://run', shotsBase: 'https://shots' });
  assert.ok(body.startsWith(MARKER));
  assert.match(body, /통과 1 · 실패 1 · 확인 못 함 1/);
  assert.match(body, /✓ 통과 \| 시나리오 1/);
  assert.match(body, /### ✗ 실패: 시나리오 2/);
  assert.match(body, /1\. http:\/\/localhost:8091\/ 을 연다/);
  assert.match(body, /\[page-2026-11-03T13-32-24-388Z\.png\]\(https:\/\/shots\/page-2026-11-03T13-32-24-388Z\.png\)/);
  assert.match(body, /확인 못 한 시나리오 1개/);
});

test('이슈: 실패만, 최대 개수까지, 재현 정보와 지문을 담는다', () => {
  const drafts = issueDrafts({ result: result('fail', 'blocked', ...Array(7).fill('fail')), request, meta: { model: 'gpt-6.1-terra' }, runUrl: 'https://run', shotsBase: '' });
  assert.equal(drafts.length, MAX_ISSUES);
  const [d] = drafts;
  assert.match(d.title, /^bug\(qa\): 시나리오 1 — PR #171 LLM QA 실패$/);
  for (const h of ['## 배경', '## 재현 단계', '## 기대 결과', '## 실제 결과', '## 근거', '## 범위', '## 완료 기준']) assert.ok(d.body.includes(h), h);
  assert.ok(d.body.startsWith(`<!-- llm-qa:${fingerprint(171, scenario('fail', 1))} -->`));
  assert.equal(fingerprint(171, { title: '시나리오  1 ' }), fingerprint(171, { title: '시나리오 1' }));
});

test('스크린샷 링크는 보관 위치가 있을 때만 건다', () => {
  assert.equal(linkShots('page-a.png', ''), 'page-a.png');
  assert.equal(linkShots('page-a.png', 'https://s'), '[page-a.png](https://s/page-a.png)');
});

test('report(시험 모드): 결과 폴더로 댓글·상태·이슈 초안을 만들고, 오류 결과는 error 상태가 된다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'solveline-llm-qa-'));
  try {
    const env = { ...process.env, LLM_QA_DRY_RUN: '1', REPO: 'o/r', SHA: request.sha, RUN_URL: 'https://run', SHOTS_BASE: '' };
    writeFileSync(join(dir, 'request.json'), JSON.stringify(request));
    mkdirSync(join(dir, 'ok'));
    writeFileSync(join(dir, 'ok', 'result.json'), JSON.stringify(result('pass', 'fail')));
    writeFileSync(join(dir, 'ok', 'meta.json'), JSON.stringify({ model: 'gpt-6.1-terra', effort: 'medium', seconds: 60 }));
    const ok = spawnSync(process.execPath, [script, 'report', join(dir, 'ok'), join(dir, 'request.json')], { env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'ok', 'report', 'status.json'), 'utf8')).state, 'failure');
    assert.equal(readdirSync(join(dir, 'ok', 'report')).filter((f) => f.startsWith('issue-')).length, 1);

    mkdirSync(join(dir, 'bad'));
    writeFileSync(join(dir, 'bad', 'error.txt'), '테스트 환경이 뜨지 않았습니다.\n');
    const bad = spawnSync(process.execPath, [script, 'report', join(dir, 'bad'), join(dir, 'request.json')], { env, encoding: 'utf8' });
    assert.equal(bad.status, 0, bad.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'bad', 'report', 'status.json'), 'utf8')), { state: 'error', description: '오류: 테스트 환경이 뜨지 않았습니다.' });
    assert.equal(counts(null).pass, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
