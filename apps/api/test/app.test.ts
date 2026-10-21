import { describe, expect, it } from 'vitest';
import { templateFor, type ProblemInput, type RunRequest } from '@codetest/shared';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { CaseInputError, parseLiteral, toRunnerCases } from '../src/runner.ts';

const PASSWORD = 'test-password-0123456789abcdef';

function setup() {
  const config = loadConfig({ ACCESS_PASSWORD: PASSWORD, SESSION_SECRET: 'x'.repeat(40), DATA_DIR: ':memory:' });
  const calls: RunRequest[] = [];
  const runner = {
    run: async (req: RunRequest) => {
      calls.push(req);
      toRunnerCases(req);
      return { compile: { ok: true, output: '' }, results: req.cases.map((c) => ({ id: c.id, status: 'pass' as const, actual: '1', stdout: '', stderr: '', timeMs: 1, memoryMb: 10 })) };
    },
    runtime: async () => ({ runner: 'up' as const, versions: { java: '17', python: '3.8' } }),
  };
  const app = createApp({ config, db: openDb(':memory:'), runner });
  return { app, calls };
}

function login(s: ReturnType<typeof setup>, password = PASSWORD) {
  return s.app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
}

const problem: ProblemInput = {
  title: '두 수의 합',
  description: '',
  mode: 'function',
  params: ['numbers'],
  cases: [{ id: 'a', args: ['[1, 2]'], stdin: '', expected: '3' }],
  language: 'python',
  code: { java: templateFor('java', 'function'), python: templateFor('python', 'function') },
};

describe('인증', () => {
  it('세션 없이는 문제·실행 API를 막는다', async () => {
    const { app } = setup();
    expect((await app.request('/api/problems')).status).toBe(401);
    expect((await app.request('/api/run', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/health')).status).toBe(200);
  });

  it('틀린 비밀번호는 거부하고 세션을 주지 않는다', async () => {
    const s = setup();
    const res = await login(s, 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('IP별로 로그인 시도를 제한한다', async () => {
    const s = setup();
    for (let i = 0; i < 5; i++) expect((await login(s, 'wrong')).status).toBe(401);
    expect((await login(s)).status).toBe(429);
  });

  it('로그아웃하면 세션이 무효가 된다', async () => {
    const s = setup();
    const cookie = (await login(s)).headers.get('set-cookie')!.split(';')[0]!;
    expect((await s.app.request('/api/problems', { headers: { cookie } })).status).toBe(200);
    await s.app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect((await s.app.request('/api/problems', { headers: { cookie } })).status).toBe(401);
  });
});

describe('설정', () => {
  it('운영 환경은 비밀번호가 없거나 짧으면 시작하지 않는다', () => {
    const base = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) };
    expect(() => loadConfig(base)).toThrow(/ACCESS_PASSWORD/);
    expect(() => loadConfig({ ...base, ACCESS_PASSWORD: 'short' })).toThrow(/24자/);
  });
});

describe('문제·실행', () => {
  it('로그인 후 문제를 만들고 고치고 지운다', async () => {
    const s = setup();
    const res = await login(s);
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie, 'content-type': 'application/json' };

    const created = (await (await s.app.request('/api/problems', { method: 'POST', headers, body: JSON.stringify(problem) })).json()) as { data: { id: string } };
    const id = created.data.id;
    const upd = await s.app.request(`/api/problems/${id}`, { method: 'PUT', headers, body: JSON.stringify({ ...problem, title: '바뀐 제목' }) });
    expect(((await upd.json()) as { data: { title: string } }).data.title).toBe('바뀐 제목');
    const list = (await (await s.app.request('/api/problems', { headers })).json()) as { data: unknown[] };
    expect(list.data).toHaveLength(1);
    expect((await s.app.request(`/api/problems/${id}`, { method: 'DELETE', headers })).status).toBe(200);
    expect((await s.app.request(`/api/problems/${id}`, { headers })).status).toBe(404);
  });

  it('잘못된 입력값은 400으로 알린다', async () => {
    const s = setup();
    const cookie = (await login(s)).headers.get('set-cookie')!.split(';')[0]!;
    const body: RunRequest = { language: 'python', mode: 'function', code: 'x', cases: [{ id: 'a', args: ['[1, 2'], stdin: '', expected: '3' }] };
    const res = await s.app.request('/api/run', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  });
});

describe('입력값 파싱', () => {
  it('JSON과 작은따옴표 배열을 받는다', () => {
    expect(parseLiteral('[[1, 2], [3]]', 'x')).toEqual([[1, 2], [3]]);
    expect(parseLiteral("['a', 'b']", 'x')).toEqual(['a', 'b']);
    expect(parseLiteral('"abc"', 'x')).toBe('abc');
    expect(() => parseLiteral('abc', 'x')).toThrow(CaseInputError);
  });

  it('빈 기댓값은 비교하지 않는다(null)', () => {
    const cases = toRunnerCases({ language: 'java', mode: 'function', code: '', cases: [{ id: 'a', args: ['1'], stdin: '', expected: ' ' }] });
    expect(cases[0]).toEqual({ args: [1], expected: null });
  });
});
