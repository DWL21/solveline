import { Hono, type Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import {
  LoginRequest,
  Problem,
  ProblemInput,
  ProblemSummary,
  RunRequest,
  RunResult,
  Runtime,
  Session,
  SESSION_COOKIE,
} from '@codetest/shared';
import type { Config } from './config.ts';
import { ProblemStore, type Db } from './db.ts';
import { passwordMatches } from './auth/password.ts';
import { RateLimiter } from './auth/rate-limit.ts';
import { SessionStore } from './auth/sessions.ts';
import { CaseInputError, RunnerError, type RunnerClient } from './runner.ts';
import { log, redact } from './redact.ts';

type Status = 400 | 401 | 404 | 429 | 500 | 502 | 503;

export type AppDeps = {
  config: Config;
  db: Db;
  runner: Pick<RunnerClient, 'run' | 'runtime'>;
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
  const { config, db, runner } = deps;
  const now = deps.now ?? Date.now;
  const sessions = new SessionStore(db, config.sessionTtlMs);
  const problems = new ProblemStore(db);
  // 비밀번호 대입 방지: IP별 분당 5회, 전체 시간당 60회
  const loginLimit = new RateLimiter(5, 60_000);
  const loginGlobalLimit = new RateLimiter(60, 3600_000);
  const runLimit = new RateLimiter(30, 60_000);

  const app = new Hono();

  app.use('*', secureHeaders());
  app.use('/api/*', cors({ origin: config.webOrigin, credentials: true, allowMethods: ['GET', 'POST', 'PUT', 'DELETE'], allowHeaders: ['content-type'] }));
  app.onError((err, c) => {
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

  app.get('/api/runtime', async (c) => ok(c, Runtime, await runner.runtime()));

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

  app.post('/api/run', async (c) => {
    const retry = runLimit.hit('run', now());
    if (retry) {
      c.header('Retry-After', String(retry));
      return fail(c, 429, 'rate_limited', '실행 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    const body = await readJson(c, RunRequest);
    if (!body) return fail(c, 400, 'invalid_request', '실행 요청 형식이 올바르지 않습니다.');
    try {
      return ok(c, RunResult, await runner.run(body));
    } catch (e) {
      if (e instanceof CaseInputError) return fail(c, 400, 'invalid_case', e.message);
      if (e instanceof RunnerError) {
        log.error('[runner]', e);
        return fail(c, 502, 'runner_error', redact(e.message));
      }
      throw e;
    }
  });

  return app;
}
