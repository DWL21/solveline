import { describe, expect, it, vi } from 'vitest';
import { judgeHeaders, type JudgeJob, type JudgeStatus, type TestCase } from '@solveline/shared';
import { createJudge } from '../src/app.ts';
import { JobStore, openJobsDb } from '../src/jobs.ts';
import { TestsetMirror, testsetKey } from '../src/mirror.ts';
import { MemoryObjectStore, R2ObjectStore } from '../src/r2.ts';
import { mask, redact, registerSecret } from '../src/redact.ts';
import { RunnerClient, type RunJob } from '../src/runner.ts';
import { TestsetStore } from '../src/testsets.ts';

const SECRET = 'j'.repeat(40);
const cases: TestCase[] = [{ id: 'a', args: ['1'], stdin: '', expected: '1', hidden: false }];
const job = (id: string, over: Partial<JudgeJob> = {}): JudgeJob => ({ id, kind: 'run', language: 'python', mode: 'function', code: 'x', cases, testsetHash: null, timeLimitMs: 1000, ...over });

/** 가짜 runner(모두 통과)와 결과를 받는 가짜 API */
function setup(opts: { results?: (s: JudgeStatus) => number; mirror?: boolean } = {}) {
  const runs: RunJob[] = [];
  const received: JudgeStatus[] = [];
  const runner = {
    run: async (j: RunJob) => {
      runs.push(j);
      const list = j.testset ? (JSON.parse(j.testset.raw() ?? '[]') as TestCase[]) : (j.cases ?? []);
      return { compile: { ok: true, output: '' }, results: list.map(() => ({ status: 'pass' as const, actual: '1', stdout: 'o'.repeat(30_000), stderr: '', timeMs: 1, memoryMb: 1 })) };
    },
    runtime: async () => ({ runner: 'up' as const, versions: { java: '21', python: '3.13' } }),
    cancel: async () => true,
  };
  const testsets = new TestsetStore(':memory:');
  const store = new MemoryObjectStore();
  const judge = createJudge({
    db: openJobsDb(':memory:'),
    runners: [runner],
    slotsPerRunner: 2,
    testsets,
    secret: SECRET,
    resultsUrl: 'http://api',
    mirror: opts.mirror ? new TestsetMirror(store, testsets) : null,
    fetch: async (_url, init) => {
      const s = JSON.parse(String(init.body)) as JudgeStatus;
      const status = opts.results?.(s) ?? 200;
      if (status === 200) received.push(s);
      return new Response('{}', { status });
    },
  });
  /** 서명한 요청 */
  const call = async (method: string, path: string, body?: unknown) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const res = await judge.app.request(path, { method, body: text || undefined, headers: { 'content-type': 'application/json', ...(await judgeHeaders(SECRET, method, path, text)) } });
    return { status: res.status, body: (await res.json()) as { data: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any -- 테스트 응답 파싱
  };
  return { judge, call, runs, received, testsets, store };
}

describe('judge', () => {
  it('서명이 없거나 틀리거나 오래되면 거절하고, 상태 확인만 연다', async () => {
    const { judge, call } = setup();
    expect((await judge.app.request('/health')).status).toBe(200);
    expect((await judge.app.request('/runtime')).status).toBe(401);
    const old = await judgeHeaders(SECRET, 'GET', '/runtime', '', Date.now() - 10 * 60_000);
    expect((await judge.app.request('/runtime', { headers: old })).status).toBe(401);
    const wrong = await judgeHeaders('x'.repeat(SECRET.length), 'GET', '/runtime', '');
    expect((await judge.app.request('/runtime', { headers: wrong })).status).toBe(401);
    // 서명은 본문까지 덮는다
    const signed = await judgeHeaders(SECRET, 'POST', '/jobs', JSON.stringify(job('a')));
    expect((await judge.app.request('/jobs', { method: 'POST', body: JSON.stringify(job('b')), headers: { 'content-type': 'application/json', ...signed } })).status).toBe(401);
    expect((await call('GET', '/runtime')).body.data.runner).toBe('up');
  });

  it('작업을 실행하고 결과를 API에 보낸다. 실패하면 남겨 두었다가 다시 보낸다', async () => {
    let down = true;
    const s = setup({ results: () => (down ? 503 : 200) });
    const first = await s.call('POST', '/jobs?wait=25', job('a'));
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe('done');
    // 실행 결과의 출력은 잘라 둔다
    expect(first.body.data.result.results[0].stdout.length).toBeLessThan(21_000);
    await s.judge.deliver();
    expect(s.received).toHaveLength(0);
    expect(s.judge.jobs.undelivered().map((x) => x.id)).toEqual(['a']);
    down = false;
    expect(await s.judge.deliver()).toBe(1);
    expect(s.received.map((x) => x.id)).toEqual(['a']);
    expect(s.judge.jobs.undelivered()).toEqual([]);
    // 같은 id를 다시 보내도 한 번만 실행한다
    await s.call('POST', '/jobs', job('a'));
    expect(s.runs).toHaveLength(1);
    // 전달을 마친 오래된 작업은 지운다
    expect(s.judge.jobs.prune(new Date(Date.now() + 1000))).toBe(1);
    expect((await s.call('GET', '/jobs/a')).status).toBe(404);
  });

  it('API가 모르는 제출(404)이면 더 보내지 않는다', async () => {
    const s = setup({ results: () => 404 });
    await s.call('POST', '/jobs?wait=25', job('gone'));
    await s.judge.deliver();
    expect(s.judge.jobs.undelivered()).toEqual([]);
  });

  it('잘못된 케이스·기댓값 없는 채점·없는 테스트셋은 받지 않는다', async () => {
    const s = setup();
    expect((await s.call('POST', '/jobs', job('x', { cases: [] }))).body.error?.code).toBe('no_cases');
    expect((await s.call('POST', '/jobs', job('y', { kind: 'submit', cases: [{ ...cases[0]!, expected: ' ' }] }))).body.error?.code).toBe('no_expected');
    expect((await s.call('POST', '/jobs', job('z', { cases: [{ ...cases[0]!, args: ['[1,'] }] }))).body.error?.code).toBe('invalid_case');
    const missing = await s.call('POST', '/jobs', job('t', { kind: 'submit', cases: null, testsetHash: 'f'.repeat(64) }));
    expect([missing.status, missing.body.error?.code]).toEqual([409, 'testset_missing']);
    expect((await s.call('POST', '/jobs', { id: '' })).status).toBe(400);
    expect(s.runs).toHaveLength(0);
  });

  it('히든 테스트셋을 R2에 올리고, 로컬에 없으면 R2에서 받아 채점한다', async () => {
    const s = setup({ mirror: true });
    const hidden = [{ id: 'h1', args: ['1'], stdin: '', expected: '1', hidden: true }];
    const ref = (await s.call('PUT', '/testsets', { cases: hidden })).body.data;
    expect(ref.count).toBe(1);
    expect(s.store.objects.has(testsetKey(ref.hash))).toBe(true);
    expect((await s.call('PUT', '/testsets', { cases: [] })).body.data).toBeNull();
    expect((await s.call('GET', `/testsets/${ref.hash}`)).body.data.cases[0].id).toBe('h1');

    // 같은 R2를 쓰는 새 judge(로컬 디스크 없음)
    const other = setup({ mirror: true });
    other.store.objects = s.store.objects;
    const done = await other.call('POST', '/jobs?wait=25', job('sub', { kind: 'submit', cases: null, testsetHash: ref.hash }));
    expect(done.body.data.score).toBe(100);
    expect(done.body.data.caseIds).toEqual(['h1']);
    expect(other.runs[0]!.testset?.hash).toBe(ref.hash);
    // 로컬에만 있는 것을 모두 올린다
    other.testsets.put([{ id: 'n', args: ['2'], stdin: '', expected: '2', hidden: true }]);
    expect(await new TestsetMirror(other.store, other.testsets).syncUp()).toBe(1);
  });

  it('코드 실행이 채점보다 먼저 꺼내지고, 죽은 실행은 다시 대기열로 돌아간다', () => {
    const store = new JobStore(openJobsDb(':memory:'));
    store.insert(job('sub', { kind: 'submit' }), ['a'], new Date('2026-01-01T00:00:00Z'));
    store.insert(job('run'), ['a'], new Date('2026-01-01T00:00:01Z'));
    expect(store.status('sub')!.ahead).toBe(1);
    expect(store.claim()?.id).toBe('run');
    expect(store.claim()?.id).toBe('sub');
    expect(store.claim()).toBeNull();
    expect(store.requeueStale()).toBe(2);
  });
});

describe('runner 클라이언트', () => {
  type Call = { url: string; method: string; body?: string };
  const fake = (handler: (c: Call) => Response) => {
    const calls: Call[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const c = { url: String(url), method: init?.method ?? 'GET', body: init?.body as string | undefined };
      calls.push(c);
      return handler(c);
    };
    return { calls, fetchImpl: fetchImpl as typeof fetch };
  };
  const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

  it('runner에 테스트셋이 없으면(409) 한 번 올리고 다시 실행한다', async () => {
    let uploaded = false;
    const { calls, fetchImpl } = fake((c) => {
      if (c.url.endsWith('/testsets/h')) return (uploaded = true), ok({});
      return uploaded ? ok({ compile: { ok: true, output: '' }, results: [] }) : ok({ error: 'missing' }, 409);
    });
    const client = new RunnerClient('http://runner', fetchImpl);
    const r = await client.run({ language: 'python', mode: 'function', code: 'x', timeLimitMs: 100, testset: { hash: 'h', raw: () => '[]' } });
    expect(r.compile.ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST http://runner/run', 'PUT http://runner/testsets/h', 'POST http://runner/run']);
  });

  it('runner 오류·연결 실패를 알리고, 상태 확인·중지는 실패해도 던지지 않는다', async () => {
    const failing = new RunnerClient('http://runner', fake(() => ok({ error: '컴파일러 없음' }, 500)).fetchImpl);
    await expect(failing.run({ language: 'java', mode: 'function', code: 'x', timeLimitMs: 100, cases })).rejects.toThrow('컴파일러 없음');
    expect(await failing.runtime()).toEqual({ runner: 'down', versions: { java: null, python: null } });
    const offline = new RunnerClient('http://runner', (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    await expect(offline.run({ language: 'java', mode: 'function', code: 'x', timeLimitMs: 100, cases })).rejects.toThrow(/연결할 수 없습니다/);
    expect(await offline.cancel('a')).toBe(false);
    expect((await offline.runtime()).runner).toBe('down');
    const up = new RunnerClient('http://runner', fake(() => ok({ versions: { java: '21', python: '3.13' } })).fetchImpl);
    expect(await up.runtime()).toEqual({ runner: 'up', versions: { java: '21', python: '3.13' } });
    expect(await up.cancel('a')).toBe(true);
  });

  it('테스트셋 파일이 없으면 올리지 못했다고 알린다', async () => {
    const client = new RunnerClient('http://runner', fake(() => ok({ error: 'missing' }, 409)).fetchImpl);
    await expect(client.run({ language: 'python', mode: 'function', code: 'x', timeLimitMs: 100, testset: { hash: 'h', raw: () => null } })).rejects.toThrow('테스트셋 파일이 없습니다');
  });
});

describe('메모리 저장소', () => {
  it('넣고 읽고 접두사로 나열한다', async () => {
    const m = new MemoryObjectStore();
    await m.put('a/1', 'x', { contentType: 't' });
    expect(await m.list('a/')).toEqual(['a/1']);
    expect(await m.get('b')).toBeNull();
  });
});

describe('중지·시작', () => {
  it('대기 중인 작업은 바로, 실행 중인 작업은 runner에 알려 중지한다', async () => {
    const held = new Map<string, () => void>();
    const runner = {
      run: async (j: RunJob) => {
        await new Promise<void>((r) => held.set(j.jobId!, r));
        return { compile: { ok: true, output: '' }, results: [], cancelled: true };
      },
      runtime: async () => ({ runner: 'up' as const, versions: { java: null, python: null } }),
      cancel: async (id: string) => (held.get(id)?.(), true),
    };
    const judge = createJudge({ db: openJobsDb(':memory:'), runners: [runner], slotsPerRunner: 1, testsets: new TestsetStore(':memory:'), secret: SECRET, resultsUrl: null });
    judge.start();
    const send = async (method: string, path: string, body?: unknown) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      return (await (await judge.app.request(path, { method, body: text || undefined, headers: { 'content-type': 'application/json', ...(await judgeHeaders(SECRET, method, path, text)) } })).json()).data as JudgeStatus;
    };
    await send('POST', '/jobs', job('first'));
    expect((await send('POST', '/jobs', job('second'))).status).toBe('queued');
    expect((await send('POST', '/jobs/second/cancel', {})).status).toBe('cancelled');
    await expect.poll(() => held.has('first')).toBe(true);
    await send('POST', '/jobs/first/cancel', {});
    expect((await judge.dispatcher.wait('first')).status).toBe('cancelled');
    expect(await judge.deliver()).toBe(0);
    judge.stop();
  });
});

describe('저장소', () => {
  it('테스트셋 파일은 해시로 한 번만 저장하고, 해시가 맞는 원문만 받는다', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const store = new TestsetStore(join(mkdtempSync(join(tmpdir(), 'judge-')), 'testsets'));
    const ref = store.put([{ id: 'a', args: ['1'], stdin: '', expected: '1', hidden: true }]);
    expect(store.put([{ id: 'a', args: ['1'], stdin: '', expected: '1', hidden: true }])).toEqual(ref);
    expect(store.hashes()).toEqual([ref.hash]);
    expect(store.get(ref.hash)![0]!.id).toBe('a');
    expect(store.raw('../etc/passwd')).toBeNull();
    expect(store.raw('a'.repeat(64))).toBeNull();
    expect(store.putRaw(ref.hash, store.raw(ref.hash)!)).toBe(true);
  });

  it('R2(S3 API)에 넣고 읽고, 여러 쪽에 걸친 목록을 모두 읽는다', async () => {
    const seen: string[] = [];
    const pages = ['<IsTruncated>true</IsTruncated><Key>testsets/a&amp;b</Key><NextContinuationToken>t2</NextContinuationToken>', '<IsTruncated>false</IsTruncated><Key>testsets/c</Key>'];
    vi.stubGlobal('fetch', async (input: Request | string) => {
      const req = input instanceof Request ? input : new Request(input);
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      if (req.method === 'PUT') return new Response('', { status: 200 });
      if (new URL(req.url).searchParams.has('list-type')) return new Response(pages.shift()!);
      return new URL(req.url).pathname.endsWith('/none') ? new Response('', { status: 404 }) : new Response(new Uint8Array([7]));
    });
    try {
      const r2 = new R2ObjectStore({ accountId: 'acc', accessKeyId: 'id', secretAccessKey: 'key', bucket: 'b' });
      await r2.put('testsets/x', new Uint8Array([1]), { contentType: 'application/gzip' });
      expect([...(await r2.get('testsets/x'))!]).toEqual([7]);
      expect(await r2.get('none')).toBeNull();
      expect(await r2.list('testsets/')).toEqual(['testsets/a&b', 'testsets/c']);
      expect(seen[0]).toBe('PUT /b/testsets/x');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('로그에서 등록한 비밀과 토큰을 가린다', () => {
    registerSecret('super-secret-value');
    expect(redact('key=super-secret-value Bearer abc.def')).not.toMatch(/super-secret-value|abc\.def/);
    expect(mask('short')).toBe('***');
  });
});
