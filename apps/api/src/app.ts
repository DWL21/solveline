import { Hono, type Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import {
  Collection,
  CollectionInput,
  CollectionItemsInput,
  Folder,
  FolderInput,
  LoginRequest,
  Problem,
  ProblemInput,
  ProblemSummary,
  HiddenCases,
  RunRequest,
  RunResult,
  Submission,
  SubmissionRequest,
  Runtime,
  Session,
  SESSION_COOKIE,
} from '@codetest/shared';
import type { Config } from './config.ts';
import { CollectionStore, FolderStore, ProblemStore, StoreError, type Db } from './db.ts';
import { passwordMatches } from './auth/password.ts';
import { RateLimiter } from './auth/rate-limit.ts';
import { SessionStore } from './auth/sessions.ts';
import { CaseInputError, validateCases, type RunnerClient } from './runner.ts';
import { Dispatcher, SubmissionStore } from './dispatcher.ts';
import { TestsetStore } from './testsets.ts';
import { log } from './redact.ts';

type Status = 400 | 401 | 404 | 409 | 429 | 500 | 502 | 503;

type Runner = Pick<RunnerClient, 'run' | 'runtime'>;

export type AppDeps = {
  config: Config;
  db: Db;
  /** runner 여러 대. 디스패처가 빈 슬롯에 나눠 보낸다. */
  runners: Runner[];
  testsets?: TestsetStore;
  now?: () => number;
};

const fail = (c: Context, status: Status, code: string, message: string) => c.json({ error: { code, message } }, status);

/** 응답을 공유 계약 스키마로 검증한 뒤 { data } 봉투로 보낸다. */
function ok<T extends z.ZodType>(c: Context, schema: T, data: z.input<T>) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    log.error(`[contract] ${c.req.path} 응답이 계약과 다릅니다: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    return fail(c, 500, 'contract_violation', '응답 형식 오류가 발생했습니다.');
  }
  return c.json({ data: parsed.data });
}

async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T> | null> {
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const clientIp = (c: Context) =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';

export function createApp(deps: AppDeps) {
  const { config, db, runners } = deps;
  const testsets = deps.testsets ?? new TestsetStore(':memory:');
  const now = deps.now ?? Date.now;
  const sessions = new SessionStore(db, config.sessionTtlMs);
  const problems = new ProblemStore(db, testsets);
  const submissions = new SubmissionStore(db);
  const dispatcher = new Dispatcher(submissions, problems, testsets, runners as RunnerClient[], config.runnerSlots);
  const folders = new FolderStore(db);
  const collections = new CollectionStore(db);
  // 비밀번호 대입 방지: IP별 분당 5회, 전체 시간당 60회
  const loginLimit = new RateLimiter(5, 60_000);
  const loginGlobalLimit = new RateLimiter(60, 3600_000);
  const runLimit = new RateLimiter(30, 60_000);

  const app = new Hono();

  app.use('*', secureHeaders());
  app.use('/api/*', cors({ origin: config.webOrigin, credentials: true, allowMethods: ['GET', 'POST', 'PUT', 'DELETE'], allowHeaders: ['content-type'] }));
  app.onError((err, c) => {
    if (err instanceof StoreError) return fail(c, err.code === 'duplicate_name' ? 409 : 400, err.code, err.message);
    log.error(`[api] ${c.req.path}`, err);
    return fail(c, 500, 'internal', '요청을 처리하지 못했습니다.');
  });
  app.notFound((c) => fail(c, 404, 'not_found', '없는 경로입니다.'));

  // ─── 공개 ───
  app.get('/api/health', (c) => c.json({ data: { status: 'up' } }));

  const readSession = async (c: Context) => {
    const id = await getSignedCookie(c, config.sessionSecret, SESSION_COOKIE);
    if (!id) return null;
    const expiresAt = sessions.validate(id, now());
    return expiresAt === null ? null : { id, expiresAt };
  };

  app.post('/api/auth/login', async (c) => {
    const retry = loginLimit.hit(clientIp(c), now()) || loginGlobalLimit.hit('all', now());
    if (retry) {
      c.header('Retry-After', String(retry));
      return fail(c, 429, 'rate_limited', '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    if (!config.accessPassword) return fail(c, 503, 'auth_not_configured', '서버에 비밀번호(ACCESS_PASSWORD)가 설정되지 않았습니다.');
    const body = await readJson(c, LoginRequest);
    if (!body) return fail(c, 400, 'invalid_request', '비밀번호가 필요합니다.');
    if (!passwordMatches(config.accessPassword, body.password)) {
      log.warn(`[auth] 비밀번호 불일치 ip=${clientIp(c)}`);
      return fail(c, 401, 'invalid_password', '비밀번호가 올바르지 않습니다.');
    }
    const s = sessions.create(now());
    await setSignedCookie(c, SESSION_COOKIE, s.id, config.sessionSecret, {
      path: '/',
      httpOnly: true,
      secure: config.secureCookie,
      sameSite: 'Strict',
      expires: new Date(s.expiresAt),
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });
    log.info(`[auth] 로그인 성공 ip=${clientIp(c)}`);
    return ok(c, Session, { authenticated: true, expiresAt: new Date(s.expiresAt).toISOString() });
  });

  app.get('/api/auth/session', async (c) => {
    const s = await readSession(c);
    return ok(c, Session, { authenticated: !!s, expiresAt: s ? new Date(s.expiresAt).toISOString() : null });
  });

  app.post('/api/auth/logout', async (c) => {
    const s = await readSession(c);
    if (s) sessions.revoke(s.id);
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: config.secureCookie, httpOnly: true, sameSite: 'Strict' });
    return ok(c, Session, { authenticated: false, expiresAt: null });
  });

  // ─── 이하 세션 필요 ───
  app.use('/api/*', async (c, next) => {
    const p = c.req.path;
    if (p === '/api/health' || p.startsWith('/api/auth/')) return next();
    const s = await readSession(c);
    if (!s) return fail(c, 401, 'unauthorized', '로그인이 필요합니다.');
    return next();
  });

  // 실행 환경: runner 중 하나라도 살아 있으면 up
  app.get('/api/runtime', async (c) => {
    const all = await Promise.all(runners.map((r) => r.runtime()));
    return ok(c, Runtime, all.find((r) => r.runner === 'up') ?? all[0] ?? { runner: 'down', versions: { java: null, python: null } });
  });

  app.get('/api/problems', (c) => ok(c, z.array(ProblemSummary), problems.list()));

  app.post('/api/problems', async (c) => {
    const body = await readJson(c, ProblemInput);
    if (!body) return fail(c, 400, 'invalid_request', '문제 형식이 올바르지 않습니다.');
    return ok(c, Problem, problems.create(body));
  });

  app.get('/api/problems/:id', (c) => {
    const p = problems.get(c.req.param('id'));
    return p ? ok(c, Problem, p) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  app.put('/api/problems/:id', async (c) => {
    const body = await readJson(c, ProblemInput);
    if (!body) return fail(c, 400, 'invalid_request', '문제 형식이 올바르지 않습니다.');
    const p = problems.update(c.req.param('id'), body);
    return p ? ok(c, Problem, p) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  app.delete('/api/problems/:id', (c) =>
    problems.delete(c.req.param('id')) ? c.json({ data: { deleted: true } }) : fail(c, 404, 'not_found', '없는 문제입니다.'),
  );

  // ─── 폴더 ───
  app.get('/api/folders', (c) => ok(c, z.array(Folder), folders.list()));

  app.post('/api/folders', async (c) => {
    const body = await readJson(c, FolderInput);
    if (!body) return fail(c, 400, 'invalid_request', '폴더 이름이 필요합니다.');
    return ok(c, Folder, folders.create(body.name));
  });

  app.put('/api/folders/:id', async (c) => {
    const body = await readJson(c, FolderInput);
    if (!body) return fail(c, 400, 'invalid_request', '폴더 이름이 필요합니다.');
    const f = folders.rename(c.req.param('id'), body.name);
    return f ? ok(c, Folder, f) : fail(c, 404, 'not_found', '없는 폴더입니다.');
  });

  app.delete('/api/folders/:id', (c) =>
    folders.delete(c.req.param('id')) ? c.json({ data: { deleted: true } }) : fail(c, 404, 'not_found', '없는 폴더입니다.'),
  );

  // ─── 컬렉션 ───
  app.get('/api/collections', (c) => ok(c, z.array(Collection), collections.list()));

  app.post('/api/collections', async (c) => {
    const body = await readJson(c, CollectionInput);
    if (!body) return fail(c, 400, 'invalid_request', '컬렉션 이름이 필요합니다.');
    return ok(c, Collection, collections.create(body));
  });

  app.put('/api/collections/:id', async (c) => {
    const body = await readJson(c, CollectionInput);
    if (!body) return fail(c, 400, 'invalid_request', '컬렉션 이름이 필요합니다.');
    const col = collections.update(c.req.param('id'), body);
    return col ? ok(c, Collection, col) : fail(c, 404, 'not_found', '없는 컬렉션입니다.');
  });

  app.put('/api/collections/:id/items', async (c) => {
    const body = await readJson(c, CollectionItemsInput);
    if (!body) return fail(c, 400, 'invalid_request', 'problemIds 배열이 필요합니다.');
    const col = collections.setItems(c.req.param('id'), body.problemIds);
    return col ? ok(c, Collection, col) : fail(c, 404, 'not_found', '없는 컬렉션입니다.');
  });

  app.delete('/api/collections/:id', (c) =>
    collections.delete(c.req.param('id')) ? c.json({ data: { deleted: true } }) : fail(c, 404, 'not_found', '없는 컬렉션입니다.'),
  );

  // ─── 히든 테스트셋 ───
  app.get('/api/problems/:id/hidden', (c) => {
    const cases = problems.hidden(c.req.param('id'));
    return cases ? ok(c, HiddenCases, { cases }) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  app.put('/api/problems/:id/hidden', async (c) => {
    const body = await readJson(c, HiddenCases);
    if (!body) return fail(c, 400, 'invalid_request', '히든 케이스 형식이 올바르지 않습니다.');
    const ref = problems.setHidden(c.req.param('id'), body.cases.map((x) => ({ ...x, hidden: true })));
    if (ref === false) return fail(c, 404, 'not_found', '없는 문제입니다.');
    return ok(c, HiddenCases, { cases: problems.hidden(c.req.param('id')) ?? [] });
  });

  // ─── 제출 큐 ───
  /** 요청을 검사해 대기열에 넣는다. 오류면 [status, code, message]를 돌려준다. */
  const enqueue = (req: SubmissionRequest): string | [Status, string, string] => {
    const problem = req.problemId ? problems.get(req.problemId) : null;
    if (req.problemId && !problem) return [404, 'not_found', '없는 문제입니다.'];
    try {
      if (req.kind === 'run') {
        const cases = req.cases.filter((x) => !x.hidden);
        if (!cases.length) return [400, 'no_cases', '실행할 테스트 케이스가 없습니다.'];
        validateCases(req.mode, cases);
        return submissions.insert({ ...req, cases, testsetHash: null, caseIds: cases.map((x) => x.id) });
      }
      const ref = problem?.hiddenTestset;
      if (ref) {
        const cases = testsets.get(ref.hash);
        if (!cases) return [500, 'testset_missing', '테스트셋 파일이 없습니다.'];
        if (cases.some((x) => !x.expected.trim())) return [400, 'no_expected', '기댓값이 없는 히든 케이스가 있습니다.'];
        validateCases(req.mode, cases);
        return submissions.insert({ ...req, cases: null, testsetHash: ref.hash, caseIds: cases.map((x) => x.id) });
      }
      if (!req.cases.length || req.cases.some((x) => !x.expected.trim())) return [400, 'no_expected', '채점하려면 기댓값이 있는 테스트 케이스가 필요합니다.'];
      validateCases(req.mode, req.cases);
      return submissions.insert({ ...req, testsetHash: null, caseIds: req.cases.map((x) => x.id) });
    } catch (e) {
      if (e instanceof CaseInputError) return [400, 'invalid_case', e.message];
      throw e;
    }
  };

  const limited = (c: Context) => {
    const retry = runLimit.hit('run', now());
    if (!retry) return null;
    c.header('Retry-After', String(retry));
    return fail(c, 429, 'rate_limited', '실행 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
  };

  app.post('/api/submissions', async (c) => {
    const blocked = limited(c);
    if (blocked) return blocked;
    const body = await readJson(c, SubmissionRequest);
    if (!body) return fail(c, 400, 'invalid_request', '제출 형식이 올바르지 않습니다.');
    const id = enqueue(body);
    if (typeof id !== 'string') return fail(c, id[0], id[1], id[2]);
    dispatcher.kick();
    c.status(202);
    return ok(c, Submission, submissions.get(id)!);
  });

  app.get('/api/submissions/:id', (c) => {
    const s = submissions.get(c.req.param('id'));
    return s ? ok(c, Submission, s) : fail(c, 404, 'not_found', '없는 제출입니다.');
  });

  /** 동기 실행(스크립트용): 대기열에 넣고 끝날 때까지 기다린다 */
  app.post('/api/run', async (c) => {
    const blocked = limited(c);
    if (blocked) return blocked;
    const body = await readJson(c, RunRequest);
    if (!body) return fail(c, 400, 'invalid_request', '실행 요청 형식이 올바르지 않습니다.');
    const id = enqueue({ problemId: null, kind: 'run', ...body, cases: body.cases.map((x) => ({ ...x, hidden: false })) });
    if (typeof id !== 'string') return fail(c, id[0], id[1], id[2]);
    dispatcher.kick();
    const done = await dispatcher.wait(id);
    if (done.status === 'error' || !done.result) return fail(c, 502, 'runner_error', done.error ?? '실행하지 못했습니다.');
    return ok(c, RunResult, done.result);
  });

  return { app, dispatcher, problems, submissions, testsets };
}
