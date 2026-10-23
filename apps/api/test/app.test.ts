import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { templateFor, type ProblemInput, type TestCase } from '@solveline/shared';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb, UserStore, SignupSettingsStore } from '../src/db.ts';
import { GoogleAuthError, type GoogleClient } from '../src/auth/google.ts';
import { CaseInputError, normalizeLiteral, validateCases, type RunJob } from '../src/runner.ts';
import { SubmissionStore } from '../src/dispatcher.ts';

const OWNER = 'owner@example.com';
const MASTER = 'master-password-0123456789abcdef';

/** 가짜 Google: code가 곧 이메일이다. sub는 이메일에서 만든다. */
const fakeGoogle: GoogleClient = {
  authUrl: ({ state, redirectUri }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
  exchange: async ({ code }) => {
    if (code === 'bad') throw new GoogleAuthError('토큰 교환 실패');
    return { sub: `sub-${code}`, email: code, name: code.split('@')[0]!, picture: '' };
  },
};

/**
 * 가짜 runner: 기댓값이 '"fail"'인 케이스만 실패. 테스트셋은 첫 호출에 409를 흉내 내고 raw를 받아 캐시한다.
 * 코드가 'hold'면 cancel(jobId)이 올 때까지 끝나지 않는다(무한 루프 흉내).
 */
function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ SESSION_SECRET: 'x'.repeat(40), DATA_DIR: ':memory:', OWNER_EMAIL: OWNER, ...env });
  const calls: RunJob[] = [];
  const uploads: string[] = [];
  const held = new Map<string, () => void>();
  const runner = {
    run: async (job: RunJob) => {
      calls.push(job);
      if (job.code === 'hold') {
        await new Promise<void>((resolve) => held.set(job.jobId!, resolve));
        const skipped = { status: 'skipped' as const, actual: null, stdout: '', stderr: '중지', timeMs: 0, memoryMb: 0 };
        return { compile: { ok: true, output: '' }, results: (job.cases ?? []).map(() => skipped), cancelled: true };
      }
      let cases: TestCase[] = job.cases ?? [];
      if (job.testset) {
        if (!uploads.includes(job.testset.hash)) uploads.push(job.testset.hash);
        cases = JSON.parse(job.testset.raw() ?? '[]') as TestCase[];
      }
      return {
        compile: { ok: true, output: '' },
        results: cases.map((c) => ({ status: c.expected === '"fail"' ? ('fail' as const) : ('pass' as const), actual: '1', stdout: '', stderr: '', timeMs: 1, memoryMb: 10 })),
      };
    },
    runtime: async () => ({ runner: 'up' as const, versions: { java: '21.0.2', python: '3.13.13' } }),
    cancel: async (jobId: string) => {
      held.get(jobId)?.();
      return true;
    },
  };
  const db = openDb(':memory:');
  const { app, dispatcher } = createApp({ config, db, runners: [runner], google: fakeGoogle });
  return { app, db, dispatcher, calls, uploads, held };
}

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);

/** Google 왕복을 흉내 낸다. 결과: 돌아간 위치와 받은 쿠키 */
async function googleRoundTrip(s: ReturnType<typeof setup>, code: string, next = '/') {
  const start = await s.app.request(`/api/auth/google/start?next=${encodeURIComponent(next)}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  const oauth = cookieOf(start, 'solveline_oauth')!;
  const cb = await s.app.request(`/api/auth/google/callback?code=${encodeURIComponent(code)}&state=${state}`, { headers: { cookie: oauth } });
  return { location: cb.headers.get('location'), session: cookieOf(cb, 'solveline_session'), signup: cookieOf(cb, 'solveline_signup') };
}

function masterRequest(s: ReturnType<typeof setup>, password: string) {
  return s.app.request('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
}

/** 관리자 모드 쿠키 */
async function masterLogin(s: ReturnType<typeof setup>) {
  const res = await masterRequest(s, MASTER);
  expect(res.status).toBe(200);
  return cookieOf(res, 'solveline_admin')!;
}

const agree = { agreeAge: true, agreeTerms: true, agreePrivacy: true };

/** 처음이면 약관에 동의해 가입하고, 이미 있으면 로그인한다. 세션 쿠키를 돌려준다. */
async function login(s: ReturnType<typeof setup>, email = OWNER): Promise<string> {
  const r = await googleRoundTrip(s, email);
  if (r.session) return r.session;
  expect(r.location).toBe('/signup');
  const res = await s.app.request('/api/auth/signup', { method: 'POST', headers: { cookie: r.signup!, 'content-type': 'application/json' }, body: JSON.stringify(agree) });
  expect(res.status).toBe(200);
  return cookieOf(res, 'solveline_session')!;
}

const problem: ProblemInput = {
  title: '두 수의 합',
  folderId: null,
  description: '',
  mode: 'function',
  params: ['numbers'],
  timeLimitMs: 10_000,
  cases: [{ id: 'a', args: ['[1, 2]'], stdin: '', expected: '3', hidden: false }],
  language: 'python',
  code: { java: templateFor('java', 'function'), python: templateFor('python', 'function') },
  myCases: [],
  memo: '',
  lastSubmission: null,
};

describe('인증', () => {
  it('비회원은 문제·폴더를 볼 수만 있고, 저장·실행은 막는다', async () => {
    const s = setup();
    const { app } = s;
    const E = as(s, await login(s));
    const p = (await E('POST', '/api/problems', problem)).body.data.id;
    await E('PUT', `/api/problems/${p}`, { ...problem, memo: '운영자 메모', code: { java: '운영자 코드', python: '' } });
    const list = (await (await app.request('/api/problems')).json()) as { data: { id: string; lastSubmission: unknown }[] };
    expect(list.data.map((x) => x.id)).toEqual([p]);
    const one = (await (await app.request(`/api/problems/${p}`)).json()) as { data: { code: { python: string; java: string }; memo: string } };
    expect(one.data.code.python).toBe(problem.code.python);
    expect(one.data.memo).toBe('');
    expect((await app.request('/api/folders')).status).toBe(200);
    expect(((await (await app.request('/api/collections')).json()) as { data: unknown[] }).data).toEqual([]);
    expect((await app.request(`/api/problems/${p}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(problem) })).status).toBe(401);
    expect((await app.request(`/api/problems/${p}/hidden`)).status).toBe(401);
    expect((await app.request('/api/submissions', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/submissions')).status).toBe(401);
    expect((await app.request('/api/run', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/public/config')).status).toBe(200);
  });

  it('처음 로그인하면 약관 동의 화면으로 보내고, 동의해야 가입된다', async () => {
    const s = setup();
    const r = await googleRoundTrip(s, OWNER, '/p/abc');
    expect(r.location).toBe('/signup');
    expect(r.session).toBeUndefined();
    const pending = await s.app.request('/api/auth/signup', { headers: { cookie: r.signup! } });
    expect(((await pending.json()) as { data: { email: string } }).data.email).toBe(OWNER);
    const post = (body: unknown) =>
      s.app.request('/api/auth/signup', { method: 'POST', headers: { cookie: r.signup!, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ ...agree, agreePrivacy: false })).status).toBe(400);
    const ok = await post(agree);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { user: { email: string } } }).data.user.email).toBe(OWNER);
    // 두 번째부터는 동의 없이 바로 로그인하고 원래 경로로 돌아간다
    const again = await googleRoundTrip(s, OWNER, '/p/abc');
    expect(again.location).toBe('/p/abc');
    expect(again.session).toBeDefined();
  });

  it('state가 다르거나 Google 인증이 실패하면 세션을 주지 않는다', async () => {
    const s = setup();
    const start = await s.app.request('/api/auth/google/start');
    const oauth = cookieOf(start, 'solveline_oauth')!;
    const forged = await s.app.request('/api/auth/google/callback?code=a@x.com&state=forged', { headers: { cookie: oauth } });
    expect(forged.headers.get('location')).toBe('/?auth_error=invalid_state');
    expect(cookieOf(forged, 'solveline_session')).toBeUndefined();
    const bad = await googleRoundTrip(s, 'bad');
    expect(bad.location).toBe('/?auth_error=google_error');
  });

  it('바깥 주소로는 돌려보내지 않는다', async () => {
    const s = setup();
    await login(s);
    expect((await googleRoundTrip(s, OWNER, '//evil.example')).location).toBe('/');
    expect((await googleRoundTrip(s, OWNER, 'https://evil.example')).location).toBe('/');
  });

  it('신규 가입 중지 중에도 기존 회원은 로그인하고 기존 세션을 쓸 수 있다', async () => {
    const s = setup({ ACCESS_PASSWORD: MASTER });
    const cookie = await login(s, 'member@example.com');
    const A = as(s, await masterLogin(s));
    expect((await A('GET', '/api/admin/signup-settings')).body.data.signupEnabled).toBe(true);
    expect((await A('PUT', '/api/admin/signup-settings', { signupEnabled: false })).status).toBe(200);
    expect((await googleRoundTrip(s, 'new@example.com')).location).toBe('/?auth_error=signup_closed');
    expect((await googleRoundTrip(s, 'member@example.com')).session).toBeDefined();
    const session = await s.app.request('/api/auth/session', { headers: { cookie } });
    expect((await session.json()).data.authenticated).toBe(true);
    const config = await s.app.request('/api/public/config');
    expect((await config.json()).data.signupEnabled).toBe(false);
    expect(s.db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(1);
    await A('PUT', '/api/admin/signup-settings', { signupEnabled: true });
    expect((await login(s, 'new@example.com'))).toBeTruthy();
  });

  it('가입 대기 쿠키가 있어도 가입 중지 후에는 계정을 만들 수 없다', async () => {
    const s = setup({ ACCESS_PASSWORD: MASTER });
    const r = await googleRoundTrip(s, 'pending@example.com');
    const A = as(s, await masterLogin(s));
    await A('PUT', '/api/admin/signup-settings', { signupEnabled: false });
    expect((await s.app.request('/api/auth/signup', { headers: { cookie: r.signup! } })).status).toBe(403);
    const response = await s.app.request('/api/auth/signup', {
      method: 'POST', headers: { cookie: r.signup!, 'content-type': 'application/json' }, body: JSON.stringify(agree),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('signup_closed');
    expect(cookieOf(response, 'solveline_session')).toBeUndefined();
    expect(s.db.prepare('SELECT COUNT(*) FROM users').pluck().get()).toBe(0);
  });

  it('로그아웃하면 세션이 무효가 된다', async () => {
    const s = setup();
    const cookie = await login(s);
    expect((await s.app.request('/api/problems', { headers: { cookie } })).status).toBe(200);
    await s.app.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
    expect((await s.app.request('/api/collections', { method: 'POST', headers: { cookie } })).status).toBe(401);
  });
});

const as = (s: ReturnType<typeof setup>, cookie: string) => async (method: string, path: string, body?: unknown) => {
  const res = await s.app.request(path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { data: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any -- 테스트 응답 파싱
};

describe('공용 문제·사용자별 풀이', () => {
  it('변경분 저장은 최신 공용 내용·다른 언어·메모를 유지하고 계정을 확인한다', async () => {
    const s = setup();
    const ownerCookie = await login(s);
    const E = as(s, ownerCookie);
    const id = (await E('POST', '/api/problems', problem)).body.data.id;
    await E('PUT', `/api/problems/${id}`, { ...problem, title: '최신 제목', memo: '서버 메모', code: { java: 'java old', python: 'python latest' } });
    const patch = (body: unknown, owner = OWNER, cookie = ownerCookie) => s.app.request(`/api/problems/${id}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json', 'x-draft-owner': owner }, body: JSON.stringify(body),
    });
    const response = await patch({ code: { java: 'java draft' } });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ title: '최신 제목', memo: '서버 메모', code: { java: 'java draft', python: 'python latest' } });
    expect((await patch({ memo: 'wrong' }, 'other@example.com')).status).toBe(409);
    const member = await login(s, 'member@example.com');
    expect((await patch({ memo: 'old account' }, OWNER, member)).status).toBe(409);
    const memberPatch = await patch({ title: '금지된 변경', code: { python: 'member code' }, timer: { elapsedMs: 1000, solvedMs: null, paused: false } }, 'member@example.com', member);
    expect(memberPatch.status).toBe(200);
    expect((await memberPatch.json()).data).toMatchObject({ title: '최신 제목', code: { python: 'member code' }, timer: { elapsedMs: 1000 } });
    expect((await E('GET', `/api/problems/${id}`)).body.data.code.java).toBe('java draft');
    expect((await patch({ code: { java: 123 } })).status).toBe(400);
    expect((await patch({ timer: { elapsedMs: -1 } })).status).toBe(400);
  });

  it('문제·폴더는 모두가 같이 보고, 편집 권한이 없으면 만들거나 바꿀 수 없다', async () => {
    const s = setup();
    const E = as(s, await login(s)); // 운영자: 편집 권한
    const U = as(s, await login(s, 'user@example.com'));
    const folder = (await E('POST', '/api/folders', { name: '그래프' })).body.data.id;
    const p = (await E('POST', '/api/problems', { ...problem, folderId: folder })).body.data.id;
    expect((await U('GET', '/api/problems')).body.data.map((x: { id: string }) => x.id)).toEqual([p]);
    expect((await U('GET', '/api/folders')).body.data).toHaveLength(1);
    expect((await U('POST', '/api/problems', problem)).status).toBe(403);
    expect((await U('DELETE', `/api/problems/${p}`)).status).toBe(403);
    expect((await U('POST', '/api/folders', { name: 'x' })).status).toBe(403);
    expect((await U('PUT', `/api/folders/${folder}`, { name: 'x' })).status).toBe(403);
    expect((await U('GET', `/api/problems/${p}/hidden`)).status).toBe(403);
    expect((await U('PUT', `/api/problems/${p}/hidden`, { cases: [] })).status).toBe(403);
    // 권한 없는 사용자의 자동 저장은 내 코드만 반영하고 문제 내용은 그대로 둔다
    await U('PUT', `/api/problems/${p}`, { ...problem, folderId: folder, title: '바꿔 보기', code: { java: 'mine', python: 'mine' } });
    expect((await E('GET', `/api/problems/${p}`)).body.data.title).toBe('두 수의 합');
    expect((await U('GET', `/api/problems/${p}`)).body.data.code.java).toBe('mine');
    // 편집 권한자가 바꾼 채점 케이스·제목은 모두에게 적용된다
    await E('PUT', `/api/problems/${p}`, { ...problem, folderId: folder, title: '새 제목', cases: [{ id: 'b', args: ['[5, 5]'], stdin: '', expected: '10', hidden: false }] });
    const seen = (await U('GET', `/api/problems/${p}`)).body.data;
    expect(seen.title).toBe('새 제목');
    expect(seen.cases.map((x: { id: string }) => x.id)).toEqual(['b']);
  });

  it('작성 코드·내 테스트 케이스·메모·풀이 시간·채점 결과는 사용자마다 따로다', async () => {
    const s = setup();
    const E = as(s, await login(s));
    const U = as(s, await login(s, 'user@example.com'));
    const p = (await E('POST', '/api/problems', problem)).body.data.id;
    const mine = { id: 'm1', args: ['[9, 9]'], stdin: '', expected: '18', hidden: false };
    await U('PUT', `/api/problems/${p}`, { ...problem, code: { java: 'u', python: 'u' }, myCases: [mine], memo: '투 포인터' });
    await U('PUT', `/api/problems/${p}/timer`, { elapsedMs: 5000, solvedMs: null, paused: false });
    const u = (await U('GET', `/api/problems/${p}`)).body.data;
    expect(u.myCases).toEqual([mine]);
    expect(u.memo).toBe('투 포인터');
    expect(u.timer.elapsedMs).toBe(5000);
    const e = (await E('GET', `/api/problems/${p}`)).body.data;
    expect(e.code.python).toBe(problem.code.python);
    expect(e.myCases).toEqual([]);
    expect(e.memo).toBe('');
    expect(e.timer.elapsedMs).toBe(0);

    const sub = (await U('POST', '/api/submissions', { problemId: p, kind: 'submit', language: 'python', mode: 'function', code: 'x', cases: problem.cases })).body.data.id;
    await s.dispatcher.wait(sub);
    expect((await U('GET', '/api/problems')).body.data[0].lastSubmission.score).toBe(100);
    expect((await E('GET', '/api/problems')).body.data[0].lastSubmission).toBeNull();
    expect((await E('GET', `/api/submissions/${sub}`)).status).toBe(404);
    expect((await E('GET', '/api/submissions')).body.data.items).toEqual([]);
    expect((await E('GET', `/api/submissions/${sub}/detail`)).status).toBe(404);
    expect((await U('GET', '/api/submissions')).body.data.items).toMatchObject([{ id: sub, problemTitle: '두 수의 합', score: 100 }]);
    expect((await U('GET', `/api/submissions/${sub}/detail`)).body.data).toMatchObject({ id: sub, code: 'x', score: 100 });
    expect((await U('GET', '/api/submissions?offset=-1')).status).toBe(400);
    expect((await E('POST', `/api/submissions/${sub}/cancel`)).status).toBe(404);
  });

  it('컬렉션은 사용자마다 따로 만든다', async () => {
    const s = setup();
    const E = as(s, await login(s));
    const U = as(s, await login(s, 'user@example.com'));
    const p = (await E('POST', '/api/problems', problem)).body.data.id;
    const col = (await U('POST', '/api/collections', { name: '세트', description: '' })).body.data.id;
    expect((await E('POST', '/api/collections', { name: '세트', description: '' })).status).toBe(200);
    expect((await U('PUT', `/api/collections/${col}/items`, { problemIds: [p] })).body.data.problemIds).toEqual([p]);
    expect((await E('GET', '/api/collections')).body.data[0].problemIds).toEqual([]);
    expect((await E('PUT', `/api/collections/${col}/items`, { problemIds: [p] })).status).toBe(404);
  });

  it('운영자가 가입하면 예전 작성 코드·채점 결과·컬렉션을 넘겨받고 편집 권한을 갖는다', async () => {
    const s = setup();
    const legacyBody = JSON.stringify({ description: '', params: ['a'], timeLimitMs: 1000, cases: [], code: { java: '내 풀이', python: '' }, hiddenTestset: null });
    s.db.prepare("INSERT INTO problems (id, title, mode, language, body, created_at, updated_at) VALUES ('old', '예전 문제', 'function', 'java', ?, '2026-01-01', '2026-01-01')").run(legacyBody);
    s.db.prepare("INSERT INTO legacy_state (problem_id, language, code, last_submission) VALUES ('old', 'java', ?, ?)").run(
      JSON.stringify({ java: '내 풀이', python: '' }),
      JSON.stringify({ score: 100, passed: 1, total: 1, language: 'java', at: '2026-01-01' }),
    );
    s.db.prepare("INSERT INTO collections (id, user_id, name, description, created_at, updated_at) VALUES ('c', NULL, '모의고사', '', '2026-01-01', '2026-01-01')").run();
    const U = as(s, await login(s, 'other@example.com'));
    const O = as(s, await login(s));
    expect((await U('GET', '/api/problems/old')).body.data.lastSubmission).toBeNull();
    expect((await U('GET', '/api/collections')).body.data).toEqual([]);
    expect((await O('GET', '/api/problems/old')).body.data.code.java).toBe('내 풀이');
    expect((await O('GET', '/api/problems/old')).body.data.lastSubmission.score).toBe(100);
    expect((await O('GET', '/api/collections')).body.data.map((c: { name: string }) => c.name)).toEqual(['모의고사']);
    expect((await O('GET', '/api/auth/session')).body.data.user).toMatchObject({ editor: true, owner: true });
    expect((await U('GET', '/api/auth/session')).body.data.user).toMatchObject({ editor: false, owner: false });
  });

});

describe('관리자 모드(마스터 비밀번호)', () => {
  it('비밀번호가 맞아야 열리고, IP별로 시도를 제한한다', async () => {
    const s = setup({ ACCESS_PASSWORD: MASTER });
    expect((await s.app.request('/api/admin/users')).status).toBe(401);
    const bad = await masterRequest(s, 'wrong');
    expect(bad.status).toBe(401);
    expect(cookieOf(bad, 'solveline_admin')).toBeUndefined();
    for (let i = 0; i < 4; i++) await masterRequest(s, 'wrong');
    expect((await masterRequest(s, MASTER)).status).toBe(429);
  });

  it('Google 로그인 세션으로는 관리자 API를 쓸 수 없다', async () => {
    const s = setup({ ACCESS_PASSWORD: MASTER });
    const cookie = await login(s);
    expect((await s.app.request('/api/admin/users', { headers: { cookie } })).status).toBe(401);
  });

  it('사용자 목록·상세를 보고 편집 권한을 주고 회수한다', async () => {
    const s = setup({ ACCESS_PASSWORD: MASTER });
    const U = as(s, await login(s, 'user@example.com'));
    const A = as(s, await masterLogin(s));
    const list = (await A('GET', '/api/admin/users')).body.data as { id: string; email: string; editor: boolean }[];
    const u = list.find((x) => x.email === 'user@example.com')!;
    expect(u.editor).toBe(false);
    expect((await U('POST', '/api/folders', { name: '새 폴더' })).status).toBe(403);
    expect((await A('PUT', `/api/admin/users/${u.id}/role`, { editor: true })).body.data.editor).toBe(true);
    expect((await U('POST', '/api/folders', { name: '새 폴더' })).status).toBe(200);
    await A('PUT', `/api/admin/users/${u.id}/role`, { editor: false });
    expect((await U('POST', '/api/folders', { name: '또 폴더' })).status).toBe(403);
    const detail = (await A('GET', `/api/admin/users/${u.id}`)).body.data;
    expect(detail.termsVersion).toBeTruthy();
    expect(detail.recentSubmissions).toEqual([]);
  });

  it('사용자를 삭제하면 계정·풀이 기록·세션이 지워진다', async () => {
    const s = setup({ ACCESS_PASSWORD: MASTER });
    const cookie = await login(s, 'user@example.com');
    const A = as(s, await masterLogin(s));
    const id = ((await A('GET', '/api/admin/users')).body.data as { id: string }[])[0]!.id;
    expect((await A('DELETE', `/api/admin/users/${id}`)).status).toBe(200);
    expect((await A('GET', '/api/admin/users')).body.data).toEqual([]);
    expect((await s.app.request('/api/collections', { method: 'POST', headers: { cookie } })).status).toBe(401);
    expect((await A('DELETE', `/api/admin/users/${id}`)).status).toBe(404);
    expect((await googleRoundTrip(s, 'user@example.com')).location).toBe('/signup');
  });

  it('신규 가입 설정은 마스터만 변경할 수 있고 boolean만 받는다', async () => {
    const s = setup({ ACCESS_PASSWORD: MASTER });
    const cookie = await login(s);
    for (const auth of [undefined, cookie]) {
      const headers = { ...(auth ? { cookie: auth } : {}), 'content-type': 'application/json' };
      expect((await s.app.request('/api/admin/signup-settings', { headers })).status).toBe(401);
      expect((await s.app.request('/api/admin/signup-settings', { method: 'PUT', headers, body: JSON.stringify({ signupEnabled: false }) })).status).toBe(401);
    }
    const A = as(s, await masterLogin(s));
    expect((await A('PUT', '/api/admin/signup-settings', { signupEnabled: 'false' })).status).toBe(400);
    expect((await A('PUT', '/api/admin/signup-settings', {})).status).toBe(400);
    expect((await A('GET', '/api/admin/signup-settings')).body.data.signupEnabled).toBe(true);
    expect((await A('GET', '/api/admin/blocklist')).status).toBe(404);
    expect((await A('POST', '/api/admin/blocklist', { email: 'user@example.com' })).status).toBe(404);
    const id = new UserStore(s.db).byGoogleSub(`sub-${OWNER}`)!.id;
    expect((await A('PUT', `/api/admin/users/${id}/block`, { blocked: true })).status).toBe(404);
    expect((await A('GET', `/api/admin/users/${id}`)).body.data).not.toHaveProperty('blocked');
  });
});

describe('설정', () => {
  it('가입 정책은 DB 재시작 후에도 유지되고 기존 블랙리스트 DB를 이전한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solveline-signup-'));
    let db = openDb(dir);
    try {
      const user = new UserStore(db).create({ sub: 'old-sub', email: 'old@example.com', name: 'old', picture: '' }, { terms: 'old', privacy: 'old' });
      // 마지막 마이그레이션 적용 전의 DB 구조를 재현한다.
      db.exec(`DROP TABLE signup_settings;
        CREATE TABLE blocked_emails (email TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO blocked_emails VALUES ('old@example.com', 'old', '2026-01-01');
        DELETE FROM _migrations WHERE id = (SELECT MAX(id) FROM _migrations);`);
      db.close();
      db = openDb(dir);
      expect(new UserStore(db).byId(user.id)?.email).toBe('old@example.com');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'blocked_emails'").get()).toBeUndefined();
      expect(new SignupSettingsStore(db).enabled()).toBe(true);
      new SignupSettingsStore(db).setEnabled(false);
      db.close();
      db = openDb(dir);
      expect(new SignupSettingsStore(db).enabled()).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('운영 환경은 SESSION_SECRET이 없으면 시작하지 않고, 짧은 마스터 비밀번호는 거부한다', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short' })).toThrow(/32자/);
    expect(() => loadConfig({ ACCESS_PASSWORD: 'short' })).toThrow(/24자/);
  });

  it('Google 설정이 없으면 로그인을 시작하지 않는다', async () => {
    const config = loadConfig({ SESSION_SECRET: 'x'.repeat(40) });
    const { app } = createApp({ config, db: openDb(':memory:'), runners: [] });
    expect((await app.request('/api/auth/google/start')).status).toBe(503);
    expect(((await (await app.request('/api/public/config')).json()) as { data: { googleEnabled: boolean } }).data.googleEnabled).toBe(false);
  });
});

describe('문제·실행', () => {
  it('로그인 후 문제를 만들고 고치고 지운다', async () => {
    const s = setup();
    const cookie = await login(s);
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
    const cookie = await login(s);
    const body = { language: 'python', mode: 'function', code: 'x', cases: [{ id: 'a', args: ['[1, 2'], stdin: '', expected: '3', hidden: false }] };
    const res = await s.app.request('/api/run', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(400);
  });
});

async function authed() {
  const s = setup();
  const cookie = await login(s);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await s.app.request(path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { data: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any -- 테스트 응답 파싱
  };
  return Object.assign(call, { s });
}

describe('히든 테스트셋', () => {
  it('히든 케이스는 문제 본문이 아니라 테스트셋으로 저장되고, 자동 저장(PUT)이 지우지 않는다', async () => {
    const call = await authed();
    const hidden = [
      { id: 'h1', args: ['[5]'], stdin: '', expected: '5', hidden: true },
      { id: 'h2', args: ['[6]'], stdin: '', expected: '6', hidden: true },
    ];
    const p = (await call('POST', '/api/problems', { ...problem, cases: [...problem.cases, ...hidden] })).body.data;
    expect(p.cases).toHaveLength(1);
    expect(p.hiddenTestset.count).toBe(2);
    await call('PUT', '/api/problems/' + p.id, { ...problem, title: '수정' });
    expect((await call('GET', '/api/problems/' + p.id)).body.data.hiddenTestset).toEqual(p.hiddenTestset);
    expect((await call('GET', `/api/problems/${p.id}/hidden`)).body.data.cases.map((c: TestCase) => c.id)).toEqual(['h1', 'h2']);
    const cleared = await call('PUT', `/api/problems/${p.id}/hidden`, { cases: [] });
    expect(cleared.body.data.cases).toEqual([]);
    expect((await call('GET', '/api/problems/' + p.id)).body.data.hiddenTestset).toBeNull();
  });
});

describe('풀이 시간', () => {
  it('타이머를 저장하고 목록에 보여 주며, 목록 순서(updated_at)는 바꾸지 않는다', async () => {
    const call = await authed();
    const p = (await call('POST', '/api/problems', problem)).body.data;
    expect(p.timer).toEqual({ elapsedMs: 0, solvedMs: null, paused: false });
    const t = { elapsedMs: 754_000, solvedMs: 754_000, paused: false };
    expect((await call('PUT', `/api/problems/${p.id}/timer`, t)).body.data).toEqual(t);
    const got = (await call('GET', '/api/problems/' + p.id)).body.data;
    expect(got.timer).toEqual(t);
    expect(got.updatedAt).toBe(p.updatedAt);
    expect((await call('GET', '/api/problems')).body.data[0].timer).toEqual(t);
    // 문제 저장(자동 저장)이 타이머를 지우지 않는다
    await call('PUT', '/api/problems/' + p.id, { ...problem, title: '수정' });
    expect((await call('GET', '/api/problems/' + p.id)).body.data.timer).toEqual(t);
    expect((await call('PUT', `/api/problems/${p.id}/timer`, { elapsedMs: -1, solvedMs: null })).status).toBe(400);
    expect((await call('PUT', '/api/problems/nope/timer', t)).status).toBe(404);
  });

  it('일시정지 상태를 저장하고, 예전 형식(paused 없음)은 일시정지 아님으로 읽는다', async () => {
    const call = await authed();
    const p = (await call('POST', '/api/problems', problem)).body.data;
    const paused = { elapsedMs: 61_000, solvedMs: null, paused: true };
    expect((await call('PUT', `/api/problems/${p.id}/timer`, paused)).body.data).toEqual(paused);
    expect((await call('GET', '/api/problems/' + p.id)).body.data.timer.paused).toBe(true);
    await call('PUT', `/api/problems/${p.id}/timer`, { elapsedMs: 61_000, solvedMs: null });
    expect((await call('GET', '/api/problems/' + p.id)).body.data.timer).toEqual({ elapsedMs: 61_000, solvedMs: null, paused: false });
  });
});

describe('제출 큐', () => {
  it('채점 제출만 최신순으로 20개씩 조회한다', () => {
    const db = openDb(':memory:');
    const store = new SubmissionStore(db);
    const user = new UserStore(db).create({ sub: 'history', email: 'history@example.com', name: '', picture: '' }, { terms: 'v', privacy: 'v' });
    const base = { userId: user.id, problemId: null, language: 'python' as const, mode: 'function' as const, code: 'submitted code', cases: [], testsetHash: null, caseIds: [], timeLimitMs: 10_000 };
    const ids = Array.from({ length: 21 }, (_, i) => store.insert({ ...base, kind: 'submit' }, new Date(2026, 0, 1, 0, 0, i)));
    store.insert({ ...base, kind: 'run' }, new Date(2026, 0, 1, 0, 1));
    const first = store.history(user.id, 0);
    expect(first.items).toHaveLength(20);
    expect(first.items[0]?.id).toBe(ids[20]);
    expect(first.nextOffset).toBe(20);
    expect(store.history(user.id, 20).items.map((item) => item.id)).toEqual([ids[0]]);
    expect(store.history(user.id, 20).nextOffset).toBeNull();
  });

  it('코드 실행은 보이는 케이스만, 결과는 제출 id로 조회한다', async () => {
    const call = await authed();
    const p = (await call('POST', '/api/problems', problem)).body.data;
    const res = await call('POST', '/api/submissions', { problemId: p.id, kind: 'run', language: 'python', mode: 'function', code: 'x', cases: problem.cases });
    expect(res.status).toBe(202);
    const done = await call.s.dispatcher.wait(res.body.data.id);
    expect(done.status).toBe('done');
    expect(done.caseIds).toEqual(['a']);
    expect((await call('GET', '/api/submissions/' + done.id)).body.data.result.results[0].status).toBe('pass');
  });

  it('제출은 히든 테스트셋(해시)으로 채점하고 점수를 서버가 기록한다', async () => {
    const call = await authed();
    const hidden = [
      { id: 'h1', args: ['1'], stdin: '', expected: '1', hidden: true },
      { id: 'h2', args: ['2'], stdin: '', expected: '"fail"', hidden: true },
    ];
    const p = (await call('POST', '/api/problems', { ...problem, cases: [...problem.cases, ...hidden] })).body.data;
    const res = await call('POST', '/api/submissions', { problemId: p.id, kind: 'submit', language: 'java', mode: 'function', code: 'x', cases: problem.cases });
    const done = await call.s.dispatcher.wait(res.body.data.id);
    expect(done.score).toBe(50);
    expect(call.s.calls.at(-1)?.testset?.hash).toBe(p.hiddenTestset.hash);
    expect(call.s.calls.at(-1)?.cases).toBeUndefined();
    const sub = (await call('GET', '/api/problems')).body.data[0].lastSubmission;
    expect(sub).toMatchObject({ score: 50, passed: 1, total: 2, language: 'java' });
    // 클라이언트가 보낸 lastSubmission은 무시한다
    await call('PUT', '/api/problems/' + p.id, { ...problem, lastSubmission: { score: 100, passed: 2, total: 2, language: 'java', at: 'x' } });
    expect((await call('GET', '/api/problems/' + p.id)).body.data.lastSubmission.score).toBe(50);
  });

  it('큰 히든 테스트셋(수 MB)을 저장하고, 채점 결과에는 반환값·출력을 남기지 않는다', async () => {
    const call = await authed();
    const p = (await call('POST', '/api/problems', problem)).body.data;
    const big = JSON.stringify(Array.from({ length: 300_000 }, (_, i) => i * 7));
    const saved = await call('PUT', `/api/problems/${p.id}/hidden`, { cases: [{ id: 'h1', args: [big], stdin: '', expected: '1', hidden: true }] });
    expect(saved.status).toBe(200);
    expect(saved.body.data.cases[0].args[0].length).toBe(big.length);
    const res = await call('POST', '/api/submissions', { problemId: p.id, kind: 'submit', language: 'java', mode: 'function', code: 'x', cases: problem.cases });
    const done = await call.s.dispatcher.wait(res.body.data.id);
    expect(done.score).toBe(100);
    expect(done.result!.results[0]!.actual).toBeNull();
  });

  it('문제의 시간 제한을 runner에 넘긴다', async () => {
    const call = await authed();
    const p = (await call('POST', '/api/problems', { ...problem, timeLimitMs: 700 })).body.data;
    expect(p.timeLimitMs).toBe(700);
    const res = await call('POST', '/api/submissions', { problemId: p.id, kind: 'run', language: 'java', mode: 'function', code: 'x', cases: problem.cases });
    await call.s.dispatcher.wait(res.body.data.id);
    expect(call.s.calls.at(-1)?.timeLimitMs).toBe(700);
    expect((await call('POST', '/api/problems', { ...problem, timeLimitMs: 50 })).status).toBe(400);
  });

  it('잘못된 리터럴은 대기열에 넣기 전에 400', async () => {
    const call = await authed();
    const res = await call('POST', '/api/submissions', {
      problemId: null,
      kind: 'run',
      language: 'python',
      mode: 'function',
      code: 'x',
      cases: [{ id: 'a', args: ['[1, 2'], stdin: '', expected: '3', hidden: false }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('invalid_case');
  });

  it('코드 실행이 제출 채점보다 먼저 꺼내진다', () => {
    const db = openDb(':memory:');
    const store = new SubmissionStore(db);
    const user = new UserStore(db).create({ sub: 's', email: 'u@example.com', name: 'u', picture: '' }, { terms: 'v', privacy: 'v' });
    const base = { userId: user.id, problemId: null, language: 'java' as const, mode: 'function' as const, code: 'x', cases: [], testsetHash: null, caseIds: [], timeLimitMs: 10_000 };
    const sub = store.insert({ ...base, kind: 'submit' }, new Date('2026-01-01T00:00:00Z'));
    const run = store.insert({ ...base, kind: 'run' }, new Date('2026-01-01T00:00:01Z'));
    expect(store.get(sub)!.ahead).toBe(1);
    expect(store.claim()?.id).toBe(run);
    expect(store.claim()?.id).toBe(sub);
    expect(store.claim()).toBeNull();
    expect(store.requeueStale()).toBe(2);
  });

  it('실행 중인 제출을 중지하면 cancelled로 끝나고 점수를 기록하지 않는다', async () => {
    const call = await authed();
    const p = (await call('POST', '/api/problems', problem)).body.data;
    const res = await call('POST', '/api/submissions', { problemId: p.id, kind: 'submit', language: 'python', mode: 'function', code: 'hold', cases: problem.cases });
    const id = res.body.data.id;
    await vi.waitFor(() => expect(call.s.held.has(id)).toBe(true));
    expect((await call('GET', '/api/submissions/' + id)).body.data.status).toBe('running');
    await call('POST', `/api/submissions/${id}/cancel`);
    const done = await call.s.dispatcher.wait(id);
    expect(done.status).toBe('cancelled');
    expect(done.score).toBeNull();
    expect((await call('GET', '/api/problems/' + p.id)).body.data.lastSubmission).toBeNull();
    // 슬롯이 비어 다음 제출이 처리된다
    const next = await call('POST', '/api/submissions', { problemId: p.id, kind: 'run', language: 'python', mode: 'function', code: 'x', cases: problem.cases });
    expect((await call.s.dispatcher.wait(next.body.data.id)).status).toBe('done');
  });

  it('대기 중인 제출은 runner에 보내지 않고 바로 중지한다', async () => {
    const call = await authed();
    const body = { problemId: null, kind: 'run', language: 'python', mode: 'function', code: 'hold', cases: problem.cases };
    // 슬롯(기본 2개)을 모두 채운 뒤의 제출은 대기열에 남는다
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await call('POST', '/api/submissions', body)).body.data.id);
    const queued = ids[2]!;
    expect((await call('GET', '/api/submissions/' + queued)).body.data.status).toBe('queued');
    const res = await call('POST', `/api/submissions/${queued}/cancel`);
    expect(res.body.data.status).toBe('cancelled');
    for (const id of ids.slice(0, 2)) await call('POST', `/api/submissions/${id}/cancel`);
    await Promise.all(ids.map((id) => call.s.dispatcher.wait(id)));
    expect(call.s.calls.filter((c) => c.jobId === queued)).toHaveLength(0);
    expect((await call('POST', '/api/submissions/nope/cancel')).status).toBe(404);
  });

  it('동기 /api/run도 큐를 거쳐 결과를 돌려준다', async () => {
    const call = await authed();
    const res = await call('POST', '/api/run', { language: 'python', mode: 'function', code: 'x', cases: problem.cases });
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].id).toBe('a');
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

describe('이름 변경(codetest → solveline)', () => {
  it('예전 DB 파일(codetest.db)을 solveline.db로 옮겨 연다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'solveline-'));
    const old = openDb(dir);
    old.prepare("INSERT INTO folders (id, name, position, created_at) VALUES ('f', '구현', 0, 'x')").run();
    old.close();
    renameSync(join(dir, 'solveline.db'), join(dir, 'codetest.db'));
    const db = openDb(dir);
    expect(existsSync(join(dir, 'codetest.db'))).toBe(false);
    expect((db.prepare('SELECT name FROM folders').get() as { name: string }).name).toBe('구현');
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('예전 이름의 세션 쿠키로도 로그인 상태가 유지된다', async () => {
    const s = setup();
    const cookie = (await login(s)).replace(/^solveline_session=/, 'codetest_session=');
    expect((await s.app.request('/api/collections', { headers: { cookie } })).status).toBe(200);
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

  it('빈 기댓값은 검사하지 않는다', () => {
    expect(() => validateCases('function', [{ id: 'a', args: ['1'], stdin: '', expected: ' ', hidden: false }])).not.toThrow();
    expect(() => validateCases('function', [{ id: 'a', args: ['x'], stdin: '', expected: '', hidden: false }])).toThrow(CaseInputError);
  });
});
