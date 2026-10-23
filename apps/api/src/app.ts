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
  Problem,
  ProblemInput,
  ProblemSummary,
  HiddenCases,
  ProblemTimer,
  RunRequest,
  RunResult,
  Submission,
  SubmissionRequest,
  Runtime,
  Session,
  SESSION_COOKIE,
  PublicConfig,
  AdminLogin,
  AdminSession,
  AdminUser,
  AdminUserDetail,
  BlockedEmail,
  BlockedEmailInput,
  BlockInput,
  CodeSet,
  RoleInput,
  SignupPending,
  SignupRequest,
  TERMS_VERSION,
  PRIVACY_VERSION,
} from '@codetest/shared';
import type { Config } from './config.ts';
import { BlocklistStore, CollectionStore, FolderStore, ProblemStore, StoreError, UserStore, type Db, type GoogleProfile } from './db.ts';
import { passwordMatches } from './auth/password.ts';
import { challengeOf, GoogleAuthError, googleClient, newVerifier, type GoogleClient } from './auth/google.ts';
import { RateLimiter } from './auth/rate-limit.ts';
import { SessionStore } from './auth/sessions.ts';
import { CaseInputError, validateCases, type RunnerClient } from './runner.ts';
import { Dispatcher, SubmissionStore } from './dispatcher.ts';
import { TestsetStore } from './testsets.ts';
import { log } from './redact.ts';

type Status = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503;

type Runner = Pick<RunnerClient, 'run' | 'runtime' | 'cancel'>;

export type AppDeps = {
  config: Config;
  db: Db;
  /** runner 여러 대. 디스패처가 빈 슬롯에 나눠 보낸다. */
  runners: Runner[];
  testsets?: TestsetStore;
  /** 테스트에서 Google 대신 끼워 넣는다. 없으면 config.google로 만든다. */
  google?: GoogleClient | null;
  now?: () => number;
};

/** userId가 null이면 비회원(공개 조회 경로에서만) */
type Env = { Variables: { userId: string; editor: boolean } };
type GuestEnv = { Variables: { userId: string | null; editor: boolean } };

const OAUTH_COOKIE = 'solveline_oauth';
const SIGNUP_COOKIE = 'solveline_signup';
const ADMIN_COOKIE = 'solveline_admin';
/** 관리자 모드(마스터) 세션 길이 */
const ADMIN_TTL_MS = 12 * 3600_000;
/** Google 로그인 왕복·약관 동의에 주는 시간 */
const FLOW_TTL_S = 600;

/** 로그인 뒤 돌아갈 경로. 같은 사이트 안의 경로만 허용한다(열린 리디렉션 방지). */
const safeNext = (v: string | undefined) => (v && /^\/(?![\/\\])/.test(v) && v.length < 300 ? v : '/');

const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const decode = <T>(v: string | false | undefined): T | null => {
  if (!v) return null;
  try {
    return JSON.parse(Buffer.from(v, 'base64url').toString()) as T;
  } catch {
    return null;
  }
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
  const users = new UserStore(db);
  const blocklist = new BlocklistStore(db);
  const google = deps.google !== undefined ? deps.google : config.google ? googleClient(config.google.clientId, config.google.clientSecret) : null;
  const redirectUri = `${config.webOrigin}/api/auth/google/callback`;
  // 로그인 왕복 남용 방지: IP별 분당 20회
  const authLimit = new RateLimiter(20, 60_000);
  // 마스터 비밀번호 대입 방지: IP별 분당 5회, 전체 시간당 60회
  const adminLimit = new RateLimiter(5, 60_000);
  const adminGlobalLimit = new RateLimiter(60, 3600_000);
  // 실행·채점: 사용자별 분당 30회
  const runLimit = new RateLimiter(30, 60_000);

  const app = new Hono<Env>();

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
    const s = sessions.validate(id, now());
    return s ? { id, ...s } : null;
  };

  const flowCookie = { path: '/api/auth', httpOnly: true, secure: config.secureCookie, sameSite: 'Lax' as const, maxAge: FLOW_TTL_S };
  const sessionCookie = { path: '/', httpOnly: true, secure: config.secureCookie, sameSite: 'Lax' as const };

  const startSession = async (c: Context, userId: string) => {
    const s = sessions.create(userId, now());
    // Google에서 돌아오는 첫 이동에도 실리도록 Lax (변경 요청은 CORS·JSON 본문으로 막는다)
    await setSignedCookie(c, SESSION_COOKIE, s.id, config.sessionSecret, {
      ...sessionCookie,
      expires: new Date(s.expiresAt),
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });
    return s;
  };

  const isOwner = (email: string) => !!config.ownerEmail && email === config.ownerEmail;

  /** 운영자 계정이면 비밀번호 로그인 시절의 작성 코드·풀이 기록을 넘겨받는다 */
  const claimIfOwner = (userId: string, email: string) => {
    if (!isOwner(email)) return;
    const n = users.claimLegacy(userId);
    if (n) log.info(`[auth] 예전 데이터 ${n}건을 운영자 계정으로 옮겼습니다.`);
  };

  const sessionBody = (s: { expiresAt: number; userId: string } | null) => {
    const u = s ? users.byId(s.userId) : null;
    return u && s
      ? { authenticated: true, expiresAt: new Date(s.expiresAt).toISOString(), user: { email: u.email, name: u.name, picture: u.picture, editor: u.editor } }
      : { authenticated: false, expiresAt: null, user: null };
  };

  app.get('/api/public/config', (c) =>
    ok(c, PublicConfig, {
      googleEnabled: !!google,
      contactEmail: config.contactEmail,
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION,
    }),
  );

  const authLimited = (c: Context) => {
    const retry = authLimit.hit(clientIp(c), now());
    if (!retry) return null;
    c.header('Retry-After', String(retry));
    return fail(c, 429, 'rate_limited', '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
  };

  /** 로그인·회원가입 모두 여기서 시작한다. 가입 여부는 Google에서 돌아온 뒤 판단한다. */
  app.get('/api/auth/google/start', async (c) => {
    const blocked = authLimited(c);
    if (blocked) return blocked;
    if (!google) return fail(c, 503, 'auth_not_configured', 'Google 로그인이 설정되지 않았습니다.');
    const state = newVerifier();
    const verifier = newVerifier();
    await setSignedCookie(c, OAUTH_COOKIE, encode({ state, verifier, next: safeNext(c.req.query('next')) }), config.sessionSecret, flowCookie);
    return c.redirect(google.authUrl({ state, challenge: challengeOf(verifier), redirectUri }), 302);
  });

  app.get('/api/auth/google/callback', async (c) => {
    const back = (code: string) => c.redirect(`/?auth_error=${code}`, 302);
    const limited = authLimited(c);
    if (limited) return back('rate_limited');
    if (!google) return back('auth_not_configured');
    const flow = decode<{ state: string; verifier: string; next: string }>(await getSignedCookie(c, config.sessionSecret, OAUTH_COOKIE));
    deleteCookie(c, OAUTH_COOKIE, flowCookie);
    const { code, state, error } = c.req.query();
    if (error) return back(error === 'access_denied' ? 'cancelled' : 'google_error');
    if (!flow || !code || !state || state !== flow.state) return back('invalid_state');

    let profile: GoogleProfile;
    try {
      profile = await google.exchange({ code, verifier: flow.verifier, redirectUri });
    } catch (e) {
      log.warn(`[auth] Google 인증 실패: ${e instanceof GoogleAuthError ? e.message : String(e)}`);
      return back('google_error');
    }
    if (blocklist.has(profile.email)) {
      log.warn('[auth] 블랙리스트 계정의 로그인 시도');
      return back('blocked');
    }

    const user = users.byGoogleSub(profile.sub);
    if (user) {
      users.touch(user.id, profile);
      claimIfOwner(user.id, profile.email);
      await startSession(c, user.id);
      log.info(`[auth] 로그인 user=${user.id}`);
      return c.redirect(flow.next, 302);
    }
    // 새 사용자: 약관 동의 화면으로. Google 프로필은 서명한 쿠키에 잠시 둔다.
    await setSignedCookie(c, SIGNUP_COOKIE, encode({ profile, next: flow.next, exp: now() + FLOW_TTL_S * 1000 }), config.sessionSecret, flowCookie);
    return c.redirect('/signup', 302);
  });

  const readPending = async (c: Context) => {
    const p = decode<{ profile: GoogleProfile; next: string; exp: number }>(await getSignedCookie(c, config.sessionSecret, SIGNUP_COOKIE));
    return p && p.exp > now() && p.profile?.sub ? p : null;
  };

  app.get('/api/auth/signup', async (c) => {
    const p = await readPending(c);
    if (!p) return fail(c, 404, 'no_pending_signup', '가입 대기 중인 Google 계정이 없습니다. 다시 시도하세요.');
    return ok(c, SignupPending, { email: p.profile.email, name: p.profile.name, picture: p.profile.picture });
  });

  app.post('/api/auth/signup', async (c) => {
    const p = await readPending(c);
    if (!p) return fail(c, 404, 'no_pending_signup', '가입 대기 중인 Google 계정이 없습니다. 다시 시도하세요.');
    const body = await readJson(c, SignupRequest);
    if (!body) return fail(c, 400, 'consent_required', '필수 항목에 모두 동의해야 가입할 수 있습니다.');
    if (blocklist.has(p.profile.email)) return fail(c, 403, 'blocked', '이용이 제한된 계정입니다.');
    // 운영자는 처음부터 편집 권한을 갖는다(공용 문제를 만들어 온 계정)
    const user = users.create(p.profile, { terms: TERMS_VERSION, privacy: PRIVACY_VERSION }, { editor: isOwner(p.profile.email) });
    claimIfOwner(user.id, p.profile.email);
    deleteCookie(c, SIGNUP_COOKIE, flowCookie);
    const s = await startSession(c, user.id);
    log.info(`[auth] 가입 user=${user.id}`);
    return ok(c, Session, sessionBody({ expiresAt: s.expiresAt, userId: user.id }));
  });

  app.post('/api/auth/signup/cancel', (c) => {
    deleteCookie(c, SIGNUP_COOKIE, flowCookie);
    return c.json({ data: { cancelled: true } });
  });

  app.get('/api/auth/session', async (c) => ok(c, Session, sessionBody(await readSession(c))));

  app.post('/api/auth/logout', async (c) => {
    const s = await readSession(c);
    if (s) sessions.revoke(s.id);
    deleteCookie(c, SESSION_COOKIE, sessionCookie);
    return ok(c, Session, sessionBody(null));
  });

  // ─── 관리자 모드(마스터 비밀번호) ───
  const adminCookie = { path: '/api/admin', httpOnly: true, secure: config.secureCookie, sameSite: 'Strict' as const };

  /** 서명한 쿠키에 만료 시각만 담는다. 만료되면 다시 비밀번호를 넣는다. */
  const readAdmin = async (c: Context) => {
    const v = await getSignedCookie(c, config.sessionSecret, ADMIN_COOKIE);
    const exp = v ? Number(v) : 0;
    return exp > now() ? exp : null;
  };

  app.post('/api/admin/login', async (c) => {
    const retry = adminLimit.hit(clientIp(c), now()) || adminGlobalLimit.hit('all', now());
    if (retry) {
      c.header('Retry-After', String(retry));
      return fail(c, 429, 'rate_limited', '시도가 너무 많습니다. 잠시 후 다시 시도하세요.');
    }
    if (!config.adminPassword) return fail(c, 503, 'admin_not_configured', '관리자 비밀번호(ACCESS_PASSWORD)가 설정되지 않았습니다.');
    const body = await readJson(c, AdminLogin);
    if (!body) return fail(c, 400, 'invalid_request', '비밀번호가 필요합니다.');
    if (!passwordMatches(config.adminPassword, body.password)) {
      log.warn(`[admin] 비밀번호 불일치 ip=${clientIp(c)}`);
      return fail(c, 401, 'invalid_password', '비밀번호가 올바르지 않습니다.');
    }
    const exp = now() + ADMIN_TTL_MS;
    await setSignedCookie(c, ADMIN_COOKIE, String(exp), config.sessionSecret, { ...adminCookie, expires: new Date(exp), maxAge: ADMIN_TTL_MS / 1000 });
    log.info(`[admin] 관리자 모드 진입 ip=${clientIp(c)}`);
    return ok(c, AdminSession, { authenticated: true, expiresAt: new Date(exp).toISOString() });
  });

  app.get('/api/admin/session', async (c) => {
    const exp = await readAdmin(c);
    return ok(c, AdminSession, { authenticated: !!exp, expiresAt: exp ? new Date(exp).toISOString() : null });
  });

  app.post('/api/admin/logout', (c) => {
    deleteCookie(c, ADMIN_COOKIE, adminCookie);
    return ok(c, AdminSession, { authenticated: false, expiresAt: null });
  });

  app.use('/api/admin/*', async (c, next) => {
    const p = c.req.path;
    if (p === '/api/admin/login' || p === '/api/admin/session' || p === '/api/admin/logout') return next();
    if (!(await readAdmin(c))) return fail(c, 401, 'admin_required', '관리자 모드 비밀번호가 필요합니다.');
    return next();
  });

  app.get('/api/admin/users', (c) => ok(c, z.array(AdminUser), users.list()));

  app.get('/api/admin/users/:id', (c) => {
    const d = users.detail(c.req.param('id'));
    return d ? ok(c, AdminUserDetail, d) : fail(c, 404, 'not_found', '없는 사용자입니다.');
  });

  /** 편집 권한 주기·회수 */
  app.put('/api/admin/users/:id/role', async (c) => {
    const body = await readJson(c, RoleInput);
    if (!body) return fail(c, 400, 'invalid_request', 'editor 값이 필요합니다.');
    if (!users.setEditor(c.req.param('id'), body.editor)) return fail(c, 404, 'not_found', '없는 사용자입니다.');
    log.info(`[admin] 편집 권한 ${body.editor ? '부여' : '회수'} user=${c.req.param('id')}`);
    return ok(c, AdminUserDetail, users.detail(c.req.param('id'))!);
  });

  /** 이용 정지·해제: 그 사용자의 이메일을 블랙리스트에 넣거나 뺀다 */
  app.put('/api/admin/users/:id/block', async (c) => {
    const body = await readJson(c, BlockInput);
    if (!body) return fail(c, 400, 'invalid_request', 'blocked 값이 필요합니다.');
    const u = users.byId(c.req.param('id'));
    if (!u) return fail(c, 404, 'not_found', '없는 사용자입니다.');
    if (body.blocked) blocklist.add(u.email, body.reason);
    else blocklist.remove(u.email);
    log.info(`[admin] 이용 ${body.blocked ? '정지' : '정지 해제'} user=${u.id}`);
    return ok(c, AdminUserDetail, users.detail(u.id)!);
  });

  app.get('/api/admin/blocklist', (c) => ok(c, z.array(BlockedEmail), blocklist.list()));

  app.post('/api/admin/blocklist', async (c) => {
    const body = await readJson(c, BlockedEmailInput);
    if (!body) return fail(c, 400, 'invalid_request', '올바른 이메일이 필요합니다.');
    blocklist.add(body.email, body.reason);
    log.info('[admin] 블랙리스트 추가');
    return ok(c, z.array(BlockedEmail), blocklist.list());
  });

  app.delete('/api/admin/blocklist/:email', (c) => {
    if (!blocklist.remove(decodeURIComponent(c.req.param('email')))) return fail(c, 404, 'not_found', '블랙리스트에 없는 이메일입니다.');
    log.info('[admin] 블랙리스트 해제');
    return ok(c, z.array(BlockedEmail), blocklist.list());
  });

  /** 문제의 시작 코드 교체(스크립트용) */
  app.put('/api/admin/problems/:id/starter', async (c) => {
    const body = await readJson(c, CodeSet);
    if (!body) return fail(c, 400, 'invalid_request', 'java·python 시작 코드가 필요합니다.');
    return problems.setStarter(c.req.param('id'), body) ? c.json({ data: { updated: true } }) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  // ─── 이하 Google 로그인 필요. 단 문제·폴더·실행 환경 조회(GET)는 비회원도 된다(작성 코드 등은 비어 있다). ───
  const guestReadable = (method: string, p: string) =>
    method === 'GET' && (p === '/api/runtime' || p === '/api/problems' || p === '/api/folders' || p === '/api/collections' || /^\/api\/problems\/[^/]+$/.test(p));

  app.use('/api/*', async (c, next) => {
    const p = c.req.path;
    if (p === '/api/health' || p.startsWith('/api/auth/') || p.startsWith('/api/public/') || p.startsWith('/api/admin/')) return next();
    const s = await readSession(c);
    const u = s ? users.byId(s.userId) : null;
    if (s && u && blocklist.has(u.email)) {
      sessions.revoke(s.id);
      return fail(c, 403, 'blocked', '이용이 제한된 계정입니다.');
    }
    if (!s || !u) {
      if (!guestReadable(c.req.method, p)) return fail(c, 401, 'unauthorized', '로그인이 필요합니다.');
      (c as unknown as Context<GuestEnv>).set('userId', null);
      c.set('editor', false);
      return next();
    }
    c.set('userId', u.id);
    c.set('editor', u.editor);
    return next();
  });

  /** 비회원도 열 수 있는 조회 경로에서 쓰는 사용자 id(비회원이면 null) */
  const viewer = (c: Context<Env>) => (c as unknown as Context<GuestEnv>).get('userId');

  /** 편집 권한이 없으면 403 */
  const editorOnly = async (c: Context<Env>, next: () => Promise<void>) => {
    if (!c.get('editor')) return fail(c, 403, 'editor_required', '편집 권한이 필요합니다.');
    return next();
  };

  /** 회원 탈퇴: 계정과 작성 코드·컬렉션·제출 기록을 모두 지운다 */
  app.delete('/api/account', async (c) => {
    users.delete(c.get('userId'));
    deleteCookie(c, SESSION_COOKIE, sessionCookie);
    log.info(`[auth] 탈퇴 user=${c.get('userId')}`);
    return c.json({ data: { deleted: true } });
  });

  // 실행 환경: runner 중 하나라도 살아 있으면 up
  app.get('/api/runtime', async (c) => {
    const all = await Promise.all(runners.map((r) => r.runtime()));
    return ok(c, Runtime, all.find((r) => r.runner === 'up') ?? all[0] ?? { runner: 'down', versions: { java: null, python: null } });
  });

  // ─── 문제(공용) + 내 풀이 상태 ───
  app.get('/api/problems', (c) => ok(c, z.array(ProblemSummary), problems.list(viewer(c))));

  app.post('/api/problems', editorOnly, async (c) => {
    const body = await readJson(c, ProblemInput);
    if (!body) return fail(c, 400, 'invalid_request', '문제 형식이 올바르지 않습니다.');
    return ok(c, Problem, problems.create(body, c.get('userId')));
  });

  app.get('/api/problems/:id', (c) => {
    const p = problems.get(c.req.param('id'), viewer(c));
    return p ? ok(c, Problem, p) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  /** 자동 저장: 내 코드·케이스·메모는 누구나, 문제 내용은 편집 권한이 있을 때만 반영된다 */
  app.put('/api/problems/:id', async (c) => {
    const body = await readJson(c, ProblemInput);
    if (!body) return fail(c, 400, 'invalid_request', '문제 형식이 올바르지 않습니다.');
    const p = problems.update(c.req.param('id'), body, c.get('userId'), c.get('editor'));
    return p ? ok(c, Problem, p) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  app.delete('/api/problems/:id', editorOnly, (c) =>
    problems.delete(c.req.param('id')!) ? c.json({ data: { deleted: true } }) : fail(c, 404, 'not_found', '없는 문제입니다.'),
  );

  // ─── 폴더(공용) ───
  app.get('/api/folders', (c) => ok(c, z.array(Folder), folders.list()));

  app.post('/api/folders', editorOnly, async (c) => {
    const body = await readJson(c, FolderInput);
    if (!body) return fail(c, 400, 'invalid_request', '폴더 이름이 필요합니다.');
    return ok(c, Folder, folders.create(body.name));
  });

  app.put('/api/folders/:id', editorOnly, async (c) => {
    const body = await readJson(c, FolderInput);
    if (!body) return fail(c, 400, 'invalid_request', '폴더 이름이 필요합니다.');
    const f = folders.rename(c.req.param('id')!, body.name);
    return f ? ok(c, Folder, f) : fail(c, 404, 'not_found', '없는 폴더입니다.');
  });

  app.delete('/api/folders/:id', editorOnly, (c) =>
    folders.delete(c.req.param('id')!) ? c.json({ data: { deleted: true } }) : fail(c, 404, 'not_found', '없는 폴더입니다.'),
  );

  // ─── 컬렉션(사용자별) ───
  app.get('/api/collections', (c) => {
    const uid = viewer(c);
    return ok(c, z.array(Collection), uid ? collections.list(uid) : []);
  });

  app.post('/api/collections', async (c) => {
    const body = await readJson(c, CollectionInput);
    if (!body) return fail(c, 400, 'invalid_request', '컬렉션 이름이 필요합니다.');
    return ok(c, Collection, collections.create(body, c.get('userId')));
  });

  app.put('/api/collections/:id', async (c) => {
    const body = await readJson(c, CollectionInput);
    if (!body) return fail(c, 400, 'invalid_request', '컬렉션 이름이 필요합니다.');
    const col = collections.update(c.req.param('id'), body, c.get('userId'));
    return col ? ok(c, Collection, col) : fail(c, 404, 'not_found', '없는 컬렉션입니다.');
  });

  app.put('/api/collections/:id/items', async (c) => {
    const body = await readJson(c, CollectionItemsInput);
    if (!body) return fail(c, 400, 'invalid_request', 'problemIds 배열이 필요합니다.');
    const col = collections.setItems(c.req.param('id'), body.problemIds, c.get('userId'));
    return col ? ok(c, Collection, col) : fail(c, 404, 'not_found', '없는 컬렉션입니다.');
  });

  app.delete('/api/collections/:id', (c) =>
    collections.delete(c.req.param('id'), c.get('userId')) ? c.json({ data: { deleted: true } }) : fail(c, 404, 'not_found', '없는 컬렉션입니다.'),
  );

  // ─── 풀이 시간(사용자별) ───
  app.put('/api/problems/:id/timer', async (c) => {
    const body = await readJson(c, ProblemTimer);
    if (!body) return fail(c, 400, 'invalid_request', '풀이 시간 형식이 올바르지 않습니다.');
    const t = problems.setTimer(c.req.param('id'), body, c.get('userId'));
    return t ? ok(c, ProblemTimer, t) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  // ─── 히든 테스트셋(공용 채점 케이스): 편집 권한자만 보고 고친다 ───
  app.get('/api/problems/:id/hidden', editorOnly, (c) => {
    const cases = problems.hidden(c.req.param('id')!);
    return cases ? ok(c, HiddenCases, { cases }) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  app.put('/api/problems/:id/hidden', editorOnly, async (c) => {
    const body = await readJson(c, HiddenCases);
    if (!body) return fail(c, 400, 'invalid_request', '히든 케이스 형식이 올바르지 않습니다.');
    const ref = problems.setHidden(c.req.param('id')!, body.cases.map((x) => ({ ...x, hidden: true })));
    if (ref === false) return fail(c, 404, 'not_found', '없는 문제입니다.');
    return ok(c, HiddenCases, { cases: problems.hidden(c.req.param('id')!) ?? [] });
  });

  // ─── 제출 큐 ───
  /** 요청을 검사해 대기열에 넣는다. 오류면 [status, code, message]를 돌려준다. */
  const enqueue = (userId: string, req: SubmissionRequest, timeLimitOverride?: number): string | [Status, string, string] => {
    const problem = req.problemId ? problems.get(req.problemId, userId) : null;
    if (req.problemId && !problem) return [404, 'not_found', '없는 문제입니다.'];
    const timeLimitMs = problem?.timeLimitMs ?? timeLimitOverride ?? 10_000;
    try {
      if (req.kind === 'run') {
        const cases = req.cases.filter((x) => !x.hidden);
        if (!cases.length) return [400, 'no_cases', '실행할 테스트 케이스가 없습니다.'];
        validateCases(req.mode, cases);
        return submissions.insert({ userId, ...req, cases, testsetHash: null, caseIds: cases.map((x) => x.id), timeLimitMs });
      }
      const ref = problem?.hiddenTestset;
      if (ref) {
        const cases = testsets.get(ref.hash);
        if (!cases) return [500, 'testset_missing', '테스트셋 파일이 없습니다.'];
        if (cases.some((x) => !x.expected.trim())) return [400, 'no_expected', '기댓값이 없는 히든 케이스가 있습니다.'];
        validateCases(req.mode, cases);
        return submissions.insert({ userId, ...req, cases: null, testsetHash: ref.hash, caseIds: cases.map((x) => x.id), timeLimitMs });
      }
      if (!req.cases.length || req.cases.some((x) => !x.expected.trim())) return [400, 'no_expected', '채점하려면 기댓값이 있는 테스트 케이스가 필요합니다.'];
      validateCases(req.mode, req.cases);
      return submissions.insert({ userId, ...req, testsetHash: null, caseIds: req.cases.map((x) => x.id), timeLimitMs });
    } catch (e) {
      if (e instanceof CaseInputError) return [400, 'invalid_case', e.message];
      throw e;
    }
  };

  const limited = (c: Context<Env>) => {
    const retry = runLimit.hit(c.get('userId'), now());
    if (!retry) return null;
    c.header('Retry-After', String(retry));
    return fail(c, 429, 'rate_limited', '실행 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
  };

  app.post('/api/submissions', async (c) => {
    const blocked = limited(c);
    if (blocked) return blocked;
    const body = await readJson(c, SubmissionRequest);
    if (!body) return fail(c, 400, 'invalid_request', '제출 형식이 올바르지 않습니다.');
    const id = enqueue(c.get('userId'), body);
    if (typeof id !== 'string') return fail(c, id[0], id[1], id[2]);
    dispatcher.kick();
    c.status(202);
    return ok(c, Submission, submissions.get(id)!);
  });

  app.get('/api/submissions/:id', (c) => {
    const id = c.req.param('id');
    const s = submissions.ownedBy(id, c.get('userId')) ? submissions.get(id) : null;
    return s ? ok(c, Submission, s) : fail(c, 404, 'not_found', '없는 제출입니다.');
  });

  /** 실행·채점 중지. 이미 끝난 제출이면 그대로 돌려준다. */
  app.post('/api/submissions/:id/cancel', async (c) => {
    const id = c.req.param('id');
    const s = submissions.ownedBy(id, c.get('userId')) ? await dispatcher.cancel(id) : null;
    return s ? ok(c, Submission, s) : fail(c, 404, 'not_found', '없는 제출입니다.');
  });

  /** 동기 실행(스크립트용): 대기열에 넣고 끝날 때까지 기다린다 */
  app.post('/api/run', async (c) => {
    const blocked = limited(c);
    if (blocked) return blocked;
    const body = await readJson(c, RunRequest);
    if (!body) return fail(c, 400, 'invalid_request', '실행 요청 형식이 올바르지 않습니다.');
    const { timeLimitMs, ...rest } = body;
    const id = enqueue(c.get('userId'), { problemId: null, kind: 'run', ...rest, cases: body.cases.map((x) => ({ ...x, hidden: false })) }, timeLimitMs);
    if (typeof id !== 'string') return fail(c, id[0], id[1], id[2]);
    dispatcher.kick();
    const done = await dispatcher.wait(id);
    if (done.status === 'cancelled') return fail(c, 409, 'cancelled', '실행이 중지되었습니다.');
    if (done.status === 'error' || !done.result) return fail(c, 502, 'runner_error', done.error ?? '실행하지 못했습니다.');
    return ok(c, RunResult, done.result);
  });

  return { app, dispatcher, problems, submissions, testsets };
}
