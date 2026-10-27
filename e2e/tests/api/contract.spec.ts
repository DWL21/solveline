import { test, expect } from '../../src/fixtures.ts';
import { aProblem } from '../../src/builders.ts';

/**
 * 계약 검사: 공개 API가 공유 계약(Zod)과 오류 봉투를 지키는지.
 * 화면이 아닌 HTTP 경계에서 검사하므로 빠르고, UI 변경과 무관하게 안정적이다(테스트 피라미드의 중간층).
 */
test.describe('API 계약', () => {
  test('비회원 조회 경로는 계약대로 응답한다', async ({ api, seedProblem }) => {
    const p = await seedProblem();
    const list = await api.problems();
    expect(list.some((x) => x.id === p.id)).toBe(true);
    const one = await api.problem(p.id);
    expect(one).toMatchObject({ id: p.id, title: p.title, memo: '', myCases: [] });
    await api.folders();
    await api.collections();
    expect(await api.publicConfig()).toMatchObject({ googleEnabled: true });
    expect(await api.session()).toEqual({ authenticated: false, expiresAt: null, user: null });
  });

  test('없는 경로·없는 문제·잘못된 본문은 오류 봉투로 답한다', async ({ api, signIn }) => {
    // 로그인 전에는 없는 경로도 401: 어떤 경로가 있는지 드러내지 않는다
    expect(await api.fail(api.request.get('/api/nope'))).toEqual({ status: 401, code: 'unauthorized' });
    expect(await api.fail(api.request.get('/api/problems/does-not-exist'))).toEqual({ status: 404, code: 'not_found' });
    await signIn();
    expect(await api.fail(api.request.get('/api/nope'))).toEqual({ status: 404, code: 'not_found' });
    expect(await api.fail(api.request.post('/api/submissions', { data: { kind: 'run' } }))).toEqual({ status: 400, code: 'invalid_request' });
  });

  test('API 응답에 보안 헤더가 있다(게이트웨이)', async ({ api }) => {
    const res = await api.request.get('/api/health');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['x-frame-options']).toBe('DENY');
    expect(res.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

/** 경계값 분석: 시간 제한은 100~10000ms(포함). 바로 바깥 값은 거부한다. */
test.describe('경계값: 문제 시간 제한', () => {
  for (const [ms, accepted] of [
    [99, false],
    [100, true],
    [10_000, true],
    [10_001, false],
  ] as const) {
    test(`${ms}ms → ${accepted ? '허용' : '거부(400)'}`, async ({ editorApi }) => {
      const req = editorApi.request.post('/api/problems', { data: aProblem({ timeLimitMs: ms }) });
      if (accepted) expect((await editorApi.ok(req, (await import('@solveline/shared')).Problem)).timeLimitMs).toBe(ms);
      else expect((await editorApi.fail(req)).status).toBe(400);
    });
  }
});
