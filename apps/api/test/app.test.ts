import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUTH_MESSAGE_PREFIX, templateFor, type ProblemInput, type RunRequest } from '@codetest/shared';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { CaseInputError, parseLiteral, toRunnerCases } from '../src/runner.ts';

function setup() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x!;
  const config = loadConfig({ ACCESS_PUBLIC_KEY: x, SESSION_SECRET: 'x'.repeat(40), DATA_DIR: ':memory:' });
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
  return { app, privateKey, calls };
}

async function login(s: ReturnType<typeof setup>, key = s.privateKey) {
  const ch = (await (await s.app.request('/api/auth/challenge', { method: 'POST' })).json()) as { data: { nonce: string } };
  const signature = sign(null, Buffer.from(AUTH_MESSAGE_PREFIX + ch.data.nonce), key).toString('base64url');
  return s.app.request('/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce: ch.data.nonce, signature }),
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

  it('등록되지 않은 키의 서명은 거부한다', async () => {
    const s = setup();
    const other = generateKeyPairSync('ed25519').privateKey;
    expect((await login(s, other)).status).toBe(401);
  });

  it('nonce는 한 번만 쓸 수 있다', async () => {
    const s = setup();
    const ch = (await (await s.app.request('/api/auth/challenge', { method: 'POST' })).json()) as { data: { nonce: string } };
    const signature = sign(null, Buffer.from(AUTH_MESSAGE_PREFIX + ch.data.nonce), s.privateKey).toString('base64url');
    const req = () =>
      s.app.request('/api/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nonce: ch.data.nonce, signature }) });
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(401);
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
