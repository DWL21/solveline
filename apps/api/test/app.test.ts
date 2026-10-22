import { describe, expect, it } from 'vitest';
import { templateFor, type ProblemInput, type RunRequest } from '@codetest/shared';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { CaseInputError, normalizeLiteral, toRunnerCases } from '../src/runner.ts';

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
  folderId: null,
  description: '',
  mode: 'function',
  params: ['numbers'],
  cases: [{ id: 'a', args: ['[1, 2]'], stdin: '', expected: '3', hidden: false }],
  language: 'python',
  code: { java: templateFor('java', 'function'), python: templateFor('python', 'function') },
  lastSubmission: null,
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
    const body: RunRequest = { language: 'python', mode: 'function', code: 'x', cases: [{ id: 'a', args: ['[1, 2'], stdin: '', expected: '3', hidden: false }] };
    const res = await s.app.request('/api/run', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  });
});

async function authed() {
  const s = setup();
  const cookie = (await login(s)).headers.get('set-cookie')!.split(';')[0]!;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await s.app.request(path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { data: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any -- 테스트 응답 파싱
  };
  return call;
}

describe('제출 결과', () => {
  it('마지막 제출 결과를 저장하고 목록에 보여 준다', async () => {
    const call = await authed();
    const p = (await call('POST', '/api/problems', problem)).body.data;
    expect(p.lastSubmission).toBeNull();
    const sub = { score: 80, passed: 8, total: 10, language: 'java', at: '2026-10-22T00:00:00.000Z' };
    await call('PUT', '/api/problems/' + p.id, { ...problem, lastSubmission: sub });
    expect((await call('GET', '/api/problems')).body.data[0].lastSubmission).toEqual(sub);
  });
});

describe('폴더', () => {
  it('문제를 폴더에 넣고, 폴더를 지우면 문제는 폴더 없음으로 남는다', async () => {
    const call = await authed();
    const f = (await call('POST', '/api/folders', { name: '그래프' })).body.data;
    expect((await call('POST', '/api/folders', { name: '그래프' })).status).toBe(409);
    const p = (await call('POST', '/api/problems', { ...problem, folderId: f.id })).body.data;
    expect(p.folderId).toBe(f.id);
    expect((await call('GET', '/api/problems')).body.data[0].folderId).toBe(f.id);
    expect((await call('PUT', '/api/folders/' + f.id, { name: '그래프 탐색' })).body.data.name).toBe('그래프 탐색');
    expect((await call('DELETE', '/api/folders/' + f.id)).status).toBe(200);
    expect((await call('GET', '/api/problems/' + p.id)).body.data.folderId).toBeNull();
  });

  it('없는 폴더로는 저장할 수 없다', async () => {
    const call = await authed();
    const res = await call('POST', '/api/problems', { ...problem, folderId: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('folder_not_found');
  });
});

describe('컬렉션', () => {
  it('한 문제가 여러 컬렉션에 순서대로 들어가고, 컬렉션을 지워도 문제는 남는다', async () => {
    const call = await authed();
    const a = (await call('POST', '/api/problems', { ...problem, title: 'A' })).body.data;
    const b = (await call('POST', '/api/problems', { ...problem, title: 'B' })).body.data;
    const c1 = (await call('POST', '/api/collections', { name: '세트 1' })).body.data;
    const c2 = (await call('POST', '/api/collections', { name: '세트 2', description: '복습' })).body.data;
    expect((await call('PUT', `/api/collections/${c1.id}/items`, { problemIds: [b.id, a.id, b.id] })).body.data.problemIds).toEqual([b.id, a.id]);
    await call('PUT', `/api/collections/${c2.id}/items`, { problemIds: [a.id] });
    const list = (await call('GET', '/api/collections')).body.data;
    expect(list.map((c: { problemIds: string[] }) => c.problemIds)).toEqual([[b.id, a.id], [a.id]]);
    expect((await call('PUT', `/api/collections/${c1.id}/items`, { problemIds: ['nope'] })).status).toBe(400);
    await call('DELETE', '/api/problems/' + b.id);
    expect((await call('GET', '/api/collections')).body.data[0].problemIds).toEqual([a.id]);
    expect((await call('DELETE', '/api/collections/' + c2.id)).status).toBe(200);
    expect((await call('GET', '/api/problems/' + a.id)).status).toBe(200);
  });
});

describe('입력값 파싱', () => {
  it('JSON과 작은따옴표 배열을 받고, 텍스트 그대로 넘긴다', () => {
    expect(normalizeLiteral(' [[1, 2], [3]] ', 'x')).toBe('[[1, 2], [3]]');
    expect(normalizeLiteral("['a', 'b']", 'x')).toBe('["a", "b"]');
    expect(normalizeLiteral('"abc"', 'x')).toBe('"abc"');
    expect(() => normalizeLiteral('abc', 'x')).toThrow(CaseInputError);
  });

  it('2^53을 넘는 정수를 바꾸지 않는다', () => {
    expect(normalizeLiteral('123456789012345678901', 'x')).toBe('123456789012345678901');
  });

  it('빈 기댓값은 비교하지 않는다(null)', () => {
    const cases = toRunnerCases({ language: 'java', mode: 'function', code: '', cases: [{ id: 'a', args: ['1'], stdin: '', expected: ' ', hidden: false }] });
    expect(cases[0]).toEqual({ argsJson: ['1'], expectedJson: null });
  });
});
