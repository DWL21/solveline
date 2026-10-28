import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJudge } from '@solveline/judge/app';
import { openJobsDb } from '@solveline/judge/jobs';
import { TestsetStore } from '@solveline/judge/testsets';
import type { RunJob } from '@solveline/judge/runner';
import { templateFor, type ProblemInput } from '@solveline/shared';
import { SqlRateLimiter } from '../src/auth/rate-limit.ts';
import { D1_SCHEMA_FILE, schemaSql } from '../src/d1-schema.ts';
import { openDb } from '../src/db-node.ts';
import { d1Sql } from '../src/sql.ts';
import { createWorkerApi, R2BindingStore, type R2BucketLike, type WorkerEnv } from '../src/worker.ts';
import worker from '../src/worker-entry.ts';
import { fakeD1 } from './fake-d1.ts';

const JUDGE_SECRET = 'j'.repeat(40);
const TEST_TOKEN = 't'.repeat(32);
const HOST = 'https://solveline.simplyimg.com';
const schemaFile = new URL(`../${D1_SCHEMA_FILE}`, import.meta.url);

/** D1 마이그레이션 파일만으로 만든 DB(운영 D1을 처음 만들 때와 같다) */
function d1FromSchemaFile() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(schemaFile, 'utf8'));
  return db;
}

/** R2 바인딩 흉내(여러 쪽 목록 포함) */
function fakeBucket(pageSize = 2) {
  const objects = new Map<string, Uint8Array>();
  const bucket: R2BucketLike = {
    put: async (key, body) => void objects.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : body),
    get: async (key) => {
      const o = objects.get(key);
      return o ? { arrayBuffer: async () => o.slice().buffer } : null;
    },
    list: async ({ prefix, cursor }) => {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + pageSize);
      const next = start + pageSize;
      return { objects: page.map((key) => ({ key })), truncated: next < keys.length, cursor: String(next) };
    },
  };
  return { bucket, objects };
}

/** D1(스키마 파일)·R2 바인딩·프로세스 안 judge로 Worker API를 만든다 */
function setup(extra: Record<string, string> = {}) {
  const db = d1FromSchemaFile();
  const { bucket, objects } = fakeBucket();
  const env: WorkerEnv = {
    DB: fakeD1(db),
    CATALOG: bucket,
    NODE_ENV: 'test',
    SESSION_SECRET: 's'.repeat(40),
    JUDGE_SECRET,
    JUDGE_URL: 'http://judge',
    TEST_AUTH_TOKEN: TEST_TOKEN,
    OWNER_EMAIL: 'owner@example.com',
    WEB_ORIGIN: HOST,
    ...extra,
  };
  const runner = {
    run: async (job: RunJob) => ({ compile: { ok: true, output: '' }, results: (job.cases ?? []).map(() => ({ status: 'pass' as const, actual: '3', stdout: '', stderr: '', timeMs: 1, memoryMb: 1 })) }),
    runtime: async () => ({ runner: 'up' as const, versions: { java: '21.0.2', python: '3.13.13' } }),
    cancel: async () => true,
  };
  let api: ReturnType<typeof createWorkerApi> | null = null;
  const judge = createJudge({
    db: openJobsDb(':memory:'), runners: [runner], slotsPerRunner: 1, testsets: new TestsetStore(':memory:'), secret: JUDGE_SECRET, resultsUrl: 'http://api',
    fetch: async (url, init) => api!.app.request(url.replace('http://api', ''), init),
  });
  api = createWorkerApi(env, { judgeFetch: async (url, init) => judge.app.request(url.replace('http://judge', ''), init) });
  return { api, db, objects, judge, env };
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

async function session(s: ReturnType<typeof setup>, email: string, editor = false) {
  const res = await s.api.app.request('/api/test/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-auth': TEST_TOKEN }, body: JSON.stringify({ email, editor }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('solveline_session='))!;
  return async (method: string, path: string, body?: unknown) => {
    const r = await s.api.app.request(path, { method, headers: { cookie, 'content-type': 'application/json', 'x-draft-owner': email }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { data: any; error?: { code: string } } }; // eslint-disable-line @typescript-eslint/no-explicit-any -- 테스트 응답 파싱
  };
}

describe('D1 스키마 파일', () => {
  it('마이그레이션 결과와 같다(마이그레이션을 더하면 pnpm --filter @solveline/api d1:schema)', () => {
    expect(readFileSync(schemaFile, 'utf8')).toBe(schemaSql(openDb(':memory:')));
  });

  it('스키마 파일로 만든 DB와 마이그레이션한 DB의 테이블·색인이 같고, 기본 설정 행이 있다', () => {
    const shape = (db: Database.Database) => db.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name").all();
    const fresh = d1FromSchemaFile();
    expect(shape(fresh)).toEqual(shape(openDb(':memory:')));
    expect(fresh.prepare('SELECT enabled FROM signup_settings WHERE id = 1').pluck().get()).toBe(1);
  });
});

describe('Worker API(D1·R2 바인딩·judge)', () => {
  it('로그인·문제 쓰기·내 상태·실행이 D1에서 동작하고, 공용 데이터는 R2 바인딩으로 게시한다', async () => {
    const s = setup();
    s.judge.start();
    try {
      const editor = await session(s, 'owner@example.com', true);
      const user = await session(s, 'user@example.com');
      const created = await editor('POST', '/api/problems', problem);
      expect(created.status).toBe(200);
      const id = created.body.data.id as string;
      expect([...s.objects.keys()].some((k) => k.startsWith(`catalog/v1/problems/${id}/`))).toBe(true);
      expect(s.objects.has('catalog/v1/index.json')).toBe(true);

      expect((await user('PATCH', `/api/problems/${id}`, { memo: '메모', code: { python: 'mine' } })).status).toBe(200);
      const state = (await user('GET', `/api/me/problems/${id}`)).body.data;
      expect([state.memo, state.code.python]).toEqual(['메모', 'mine']);

      const run = await user('POST', '/api/run', { language: 'python', mode: 'function', code: 'def solution(n): return 3', cases: [{ id: 'x', args: ['1'], stdin: '', expected: '3' }] });
      expect(run.status).toBe(200);
      expect(run.body.data.results[0].status).toBe('pass');
    } finally {
      s.judge.stop();
    }
  });

  it('요청 제한을 D1 테이블에 센다(관리자 로그인 분당 5회)', async () => {
    const s = setup({ ACCESS_PASSWORD: 'm'.repeat(32) });
    const attempt = () => s.api.app.request('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' }, body: JSON.stringify({ password: 'x'.repeat(32) }) });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(s.db.prepare("SELECT count FROM rate_limits WHERE key = 'admin:203.0.113.7'").pluck().get()).toBe(6);
  });
});

describe('D1 매일 정리 SQL(백업 워크플로가 실행)', () => {
  it('지난 세션·요청 제한과 30일 지난 끝난 제출만 지운다', () => {
    const db = d1FromSchemaFile();
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    db.prepare("INSERT INTO users (id, google_sub, email, terms_version, privacy_version, agreed_at, created_at, last_login_at) VALUES ('u', 's', 'e', 't', 'p', ?, ?, ?)").run(iso(0), iso(0), iso(0));
    const session = db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)');
    session.run('expired', 'u', now - 60_000, iso(0));
    session.run('valid', 'u', now + 3_600_000, iso(0));
    const limit = db.prepare('INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)');
    limit.run('run:old', now - 1000);
    limit.run('run:now', now + 60_000);
    const sub = db.prepare("INSERT INTO submissions (id, user_id, kind, language, mode, code, case_ids, priority, status, created_at, finished_at) VALUES (?, 'u', 'run', 'python', 'function', '', '[]', 0, ?, ?, ?)");
    const day = 86_400_000;
    sub.run('old-done', 'done', iso(31 * day), iso(31 * day));
    sub.run('old-queued', 'queued', iso(31 * day), null);
    sub.run('recent-done', 'done', iso(day), iso(day));
    db.exec(readFileSync(new URL('../d1/cleanup.sql', import.meta.url), 'utf8'));
    expect(db.prepare('SELECT id FROM sessions ORDER BY id').pluck().all()).toEqual(['valid']);
    expect(db.prepare('SELECT key FROM rate_limits').pluck().all()).toEqual(['run:now']);
    expect(db.prepare('SELECT id FROM submissions ORDER BY id').pluck().all()).toEqual(['old-queued', 'recent-done']);
  });
});

describe('SQL 요청 제한', () => {
  it('창이 지나면 다시 세고, 지난 행을 정리한다', async () => {
    const sql = d1Sql(fakeD1(d1FromSchemaFile()));
    const limit = new SqlRateLimiter(sql, 'run', 2, 60_000);
    expect([await limit.hit('u', 0), await limit.hit('u', 1), await limit.hit('u', 2)]).toEqual([0, 0, 60]);
    expect(await limit.hit('other', 2)).toBe(0);
    expect(await limit.hit('u', 60_000)).toBe(0);
    // other는 60_002에 창이 끝나고, u는 새 창(120_000까지)이라 남는다
    expect((await SqlRateLimiter.prune(sql, 60_003)).changes).toBe(1);
  });
});

describe('R2 바인딩 저장소', () => {
  it('넣고 읽고 여러 쪽 목록을 모두 읽는다', async () => {
    const { bucket } = fakeBucket(1);
    const store = new R2BindingStore(bucket);
    await store.put('testsets/a', new Uint8Array([1]), { contentType: 'application/gzip' });
    await store.put('testsets/b', 'x', { contentType: 'text/plain' });
    expect([...(await store.get('testsets/a'))!]).toEqual([1]);
    expect(await store.get('none')).toBeNull();
    expect(await store.list('testsets/')).toEqual(['testsets/a', 'testsets/b']);
  });
});

describe('Pages Worker(묶은 진입점)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const call = (env: Record<string, unknown>, path: string) =>
    (worker as { fetch: (r: Request, env: unknown, ctx: unknown) => Promise<Response> }).fetch(new Request(`${HOST}${path}`), { ASSETS: { fetch: async () => new Response('asset') }, ...env }, { waitUntil() {} });

  it('API_MODE=worker이고 DB가 있으면 Tunnel로 가지 않고 Worker 안에서 답한다', async () => {
    const tunnel = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', tunnel);
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } });
    const s = setup();
    const res = await call({ ...s.env, API_MODE: 'worker' }, '/api/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(tunnel).not.toHaveBeenCalled();
  });

  it('API_MODE가 없으면 지금처럼 Tunnel(pahidc)로 넘긴다', async () => {
    const tunnel = vi.fn(async (input: Request | string) => new Response(JSON.stringify({ seen: input instanceof Request ? input.url : input }), { status: 200 }));
    vi.stubGlobal('fetch', tunnel);
    const s = setup();
    const res = await call({ DB: s.env.DB }, '/api/me/problems');
    expect(res.status).toBe(401); // 세션 쿠키가 없으면 Tunnel까지 가지 않고 엣지에서 답한다
    const proxied = await call({ DB: s.env.DB }, '/api/auth/logout');
    expect(((await proxied.json()) as { seen: string }).seen).toBe('https://solveline-api.simplyimg.com/api/auth/logout');
  });
});
