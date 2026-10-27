import type { APIRequestContext } from '@playwright/test';
import { test, expect, emailFor } from '../../src/fixtures.ts';
import { Api } from '../../src/api.ts';
import { aProblem } from '../../src/builders.ts';
import { env } from '../../src/env.ts';

/**
 * 결정표(Decision Table) 기반 권한 검사: 역할 × 기능 → 기대 상태 코드.
 * 표 한 줄이 테스트 하나다. 권한 규칙이 바뀌면 표만 고치면 된다.
 */
type Role = 'guest' | 'user' | 'editor' | 'master';
type Op = { name: string; call: (r: APIRequestContext, ctx: { problemId: string }) => Promise<{ status(): number }>; expect: Record<Role, number> };

const ops: Op[] = [
  { name: '문제 목록 조회', call: (r) => r.get('/api/problems'), expect: { guest: 200, user: 200, editor: 200, master: 200 } },
  { name: '문제 만들기', call: (r) => r.post('/api/problems', { data: aProblem() }), expect: { guest: 401, user: 403, editor: 200, master: 401 } },
  { name: '히든 케이스 보기', call: (r, c) => r.get(`/api/problems/${c.problemId}/hidden`), expect: { guest: 401, user: 403, editor: 200, master: 401 } },
  { name: '히든 케이스 바꾸기', call: (r, c) => r.put(`/api/problems/${c.problemId}/hidden`, { data: { cases: [] } }), expect: { guest: 401, user: 403, editor: 200, master: 401 } },
  { name: '문제 삭제', call: (r) => r.delete('/api/problems/not-a-problem'), expect: { guest: 401, user: 403, editor: 404, master: 401 } },
  { name: '내 폴더 만들기', call: (r) => r.post('/api/folders', { data: { name: `폴더 ${Math.random()}` } }), expect: { guest: 401, user: 200, editor: 200, master: 401 } },
  { name: '공용 컬렉션 만들기', call: (r) => r.post('/api/collections', { data: { name: `묶음/${Math.random()}`, description: '' } }), expect: { guest: 401, user: 403, editor: 200, master: 401 } },
  {
    name: '코드 실행 제출',
    call: (r, c) => r.post('/api/submissions', { data: { problemId: c.problemId, kind: 'run', language: 'python', mode: 'function', code: 'def solution(numbers):\n    return 0\n', cases: aProblem().cases } }),
    expect: { guest: 401, user: 202, editor: 202, master: 401 },
  },
  { name: '관리자: 사용자 목록', call: (r) => r.get('/api/admin/users'), expect: { guest: 401, user: 401, editor: 401, master: 200 } },
];

test.describe('권한 결정표', () => {
  const roles: Role[] = ['guest', 'user', 'editor', 'master'];
  for (const role of roles) {
    test.describe(role, () => {
      let request: APIRequestContext;
      let problemId = '';
      test.beforeAll(async ({ playwright, baseURL }) => {
        request = await playwright.request.newContext({ baseURL });
        const api = new Api(request);
        if (role === 'user') await api.signIn(emailFor('user'));
        if (role === 'editor') await api.signIn(emailFor('editor'), { editor: true });
        if (role === 'master') await api.masterLogin(env.masterPassword);
        const seeder = new Api(await playwright.request.newContext({ baseURL }));
        await seeder.signIn(emailFor('seed'), { editor: true });
        problemId = (await seeder.createProblem(aProblem())).id;
        await seeder.request.dispose();
      });
      test.afterAll(async () => request.dispose());

      for (const op of ops) {
        test(`${op.name} → ${op.expect[role]}`, async () => {
          const res = await op.call(request, { problemId });
          expect(res.status()).toBe(op.expect[role]);
        });
      }
    });
  }
});
