import { test, expect } from '../../src/fixtures.ts';
import { aDailyProblem, sumSolutions } from '../../src/builders.ts';

/**
 * 일일 미니 문제: 문제은행에 넣을 때 실제 judge가 기준 풀이로 채점하고, 받은 문제는 일반 문제와 같은 IDE·채점으로 푼다.
 * 문제는 에이전트 경로(MCP 서버가 서명해 부르는 길)로 만든다. 테스트 환경에는 메일 발송 설정이 없어 인박스로만 받는다.
 */
test.describe('일일 미니 문제', { tag: '@R12' }, () => {
  test('기준 풀이가 틀린 문제는 실제 채점에서 걸러 저장하지 않는다', async ({ api }) => {
    const r = await api.createDailyProblem(aDailyProblem({ referenceSolution: { language: 'python', code: sumSolutions.python.wrong } }));
    expect(r.saved).toBe(false);
    expect(r.verify.score).toBeLessThan(100);
    expect(r.verify.failures.length).toBeGreaterThan(0);
  });

  test('저장한 미니 문제는 일반 목록·카탈로그에 없고 링크로만 열린다', async ({ api }) => {
    const r = await api.createDailyProblem(aDailyProblem());
    expect(r).toMatchObject({ saved: true, verify: { ok: true, score: 100 } });
    const id = r.id!;
    expect((await api.problems()).map((p) => p.id)).not.toContain(id);
    expect((await api.catalogIndex()).problems.map((p) => p.id)).not.toContain(id);
    const p = await api.dailyProblem(id);
    expect(p.cases.every((c) => !c.hidden)).toBe(true);
    expect(p.hiddenTestset?.count).toBe(3);
    expect((await api.dailyProblems()).find((x) => x.id === id)).toMatchObject({ source: 'agent:e2e', status: 'ready' });
  });

  test('구독하면 첫 문제가 바로 인박스에 오고, IDE와 같은 채점으로 풀면 해결로 바뀐다', async ({ api, signIn }) => {
    await api.createDailyProblem(aDailyProblem());
    await signIn();
    await api.saveDailySettings({ subscribed: true, mail: true, weekdays: [1, 2, 3, 4, 5] });
    const before = await api.inbox();
    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({ progress: 'none', read: false });

    // 테스트 환경의 미니 문제는 모두 '배열의 합'이라 어떤 문제를 받아도 같은 풀이로 맞힌다
    const item = before.items[0]!;
    const problem = await api.dailyProblem(item.problemId);
    const { submission } = await api.judge({ problemId: item.problemId, kind: 'submit', language: 'python', mode: 'function', code: sumSolutions.python.correct, cases: problem.cases });
    expect(submission.score).toBe(100);
    expect((await api.inbox()).items[0]).toMatchObject({ problemId: item.problemId, progress: 'solved' });
  });

  test('관리자 일일 메일 화면과 문제은행 내부 경로는 권한이 있어야 쓴다', async ({ api, signIn }) => {
    expect((await api.fail(api.request.get('/api/admin/daily/problems'))).status).toBe(401);
    expect((await api.fail(api.request.post('/api/internal/daily/bank', { data: { agent: 'x', tool: 'bank_overview', args: {} } }))).status).toBe(401);
    expect((await api.fail(api.request.post('/api/internal/daily/bank', { headers: { 'x-judge-timestamp': String(Date.now()), 'x-judge-signature': '0'.repeat(64) }, data: { agent: 'x', tool: 'bank_overview', args: {} } }))).status).toBe(401);
    await signIn();
    expect((await api.fail(api.request.post('/api/admin/daily/problems', { data: aDailyProblem() }))).status).toBe(401);
  });
});
