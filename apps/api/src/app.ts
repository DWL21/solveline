import { Hono, type Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import {
  AUTH_MESSAGE_PREFIX,
  Challenge,
  Problem,
  ProblemInput,
  ProblemSummary,
  RunRequest,
  RunResult,
  Runtime,
  Session,
  SESSION_COOKIE,
  VerifyRequest,
} from '@codetest/shared';
import type { Config } from './config.ts';
import { ProblemStore, type Db } from './db.ts';
import { NonceStore } from './auth/nonces.ts';
import { RateLimiter } from './auth/rate-limit.ts';
import { SessionStore } from './auth/sessions.ts';
import { parsePublicKey, verifySignature } from './auth/signature.ts';
import { CaseInputError, RunnerError, type RunnerClient } from './runner.ts';
import { log, redact } from './redact.ts';

type Status = 400 | 401 | 404 | 429 | 500 | 502 | 503;

export type AppDeps = {
  config: Config;
  db: Db;
  runner: Pick<RunnerClient, 'run' | 'runtime'>;
  nonces?: NonceStore;
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
  const nonces = deps.nonces ?? new NonceStore(db);
  const sessions = new SessionStore(db, config.sessionTtlMs);
  const problems = new ProblemStore(db);
  const challengeLimit = new RateLimiter(20, 60_000);
  const verifyLimit = new RateLimiter(10, 60_000);
  const runLimit = new RateLimiter(30, 60_000);
  let publicKey: KeyObject | null = null;
  if (config.accessPublicKey) publicKey = parsePublicKey(config.accessPublicKey);

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

  app.post('/api/auth/challenge', (c) => {
    const retry = challengeLimit.hit(clientIp(c), now());
    if (retry) {
      c.header('Retry-After', String(retry));
      return fail(c, 429, 'rate_limited', '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    const { nonce, expiresAt } = nonces.issue(now());
    return ok(c, Challenge, { nonce, expiresAt: new Date(expiresAt).toISOString() });
  });

  app.post('/api/auth/verify', async (c) => {
    const retry = verifyLimit.hit(clientIp(c), now());
    if (retry) {
      c.header('Retry-After', String(retry));
      return fail(c, 429, 'rate_limited', '요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    if (!publicKey) return fail(c, 503, 'auth_not_configured', '서버에 공개키(ACCESS_PUBLIC_KEY)가 설정되지 않았습니다.');
    const body = await readJson(c, VerifyRequest);
    if (!body) return fail(c, 400, 'invalid_request', 'nonce와 signature가 필요합니다.');
    // nonce는 서명 검증 전에 소비한다 → 실패해도 같은 nonce로 다시 시도할 수 없다.
    const consumed = nonces.consume(body.nonce, now());
    if (consumed === 'expired') return fail(c, 401, 'nonce_expired', '로그인 요청이 만료되었습니다. 다시 시도하세요.');
    if (consumed === 'unknown') return fail(c, 401, 'nonce_invalid', '유효하지 않거나 이미 사용된 로그인 요청입니다.');
    if (!verifySignature(publicKey, AUTH_MESSAGE_PREFIX + body.nonce, body.signature)) {
      log.warn(`[auth] 서명 검증 실패 ip=${clientIp(c)}`);
      return fail(c, 401, 'invalid_signature', '서명이 올바르지 않습니다. 등록된 개인키인지 확인하세요.');
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
