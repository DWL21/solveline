import { describe, expect, it, vi } from 'vitest';
import { templateFor, type ProblemInput, type TestCase } from '@codetest/shared';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { CaseInputError, normalizeLiteral, validateCases, type RunJob } from '../src/runner.ts';
import { SubmissionStore } from '../src/dispatcher.ts';

const PASSWORD = 'test-password-0123456789abcdef';

/**
 * 가짜 runner: 기댓값이 '"fail"'인 케이스만 실패. 테스트셋은 첫 호출에 409를 흉내 내고 raw를 받아 캐시한다.
 * 코드가 'hold'면 cancel(jobId)이 올 때까지 끝나지 않는다(무한 루프 흉내).
 */
function setup() {
  const config = loadConfig({ ACCESS_PASSWORD: PASSWORD, SESSION_SECRET: 'x'.repeat(40), DATA_DIR: ':memory:' });
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
    runtime: async () => ({ runner: 'up' as const, versions: { java: '17', python: '3.8' } }),
    cancel: async (jobId: string) => {
      held.get(jobId)?.();
      return true;
    },
  };
  const { app, dispatcher } = createApp({ config, db: openDb(':memory:'), runners: [runner] });
  return { app, dispatcher, calls, uploads, held };
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
  timeLimitMs: 10_000,
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
    const body = { language: 'python', mode: 'function', code: 'x', cases: [{ id: 'a', args: ['[1, 2'], stdin: '', expected: '3', hidden: false }] };
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

describe('제출 큐', () => {
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
    const base = { problemId: null, language: 'java' as const, mode: 'function' as const, code: 'x', cases: [], testsetHash: null, caseIds: [], timeLimitMs: 10_000 };
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
