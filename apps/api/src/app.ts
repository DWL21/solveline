import { randomInt, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';

/** 테스트 전용 로그인 요청 */
const TestSessionRequest = z.object({ email: z.string().trim().toLowerCase().email().max(254), name: z.string().max(100).optional(), editor: z.boolean().optional() });
import {
  Bookmark,
  CatalogIndex,
  MyProblemState,
  MyProblemSummary,
  Collection,
  CollectionInput,
  CollectionItemsInput,
  Folder,
  FolderInput,
  Problem,
  ProblemInput,
  ProblemPatch,
  ProblemSummary,
  HiddenCases,
  ProblemTimer,
  RunRequest,
  RunResult,
  Submission,
  SubmissionDetail,
  SubmissionHistory,
  SubmissionRequest,
  Runtime,
  Session,
  SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
  PublicConfig,
  AdminLogin,
  AdminSession,
  AdminUser,
  AdminUserDetail,
  SignupSettings,
  CodeSet,
  RoleInput,
  SignupPending,
  SignupRequest,
  TERMS_VERSION,
  PRIVACY_VERSION,
} from '@solveline/shared';
import type { Config } from './config.ts';
import { SignupSettingsStore, CollectionStore, FolderStore, ProblemStore, StoreError, UserStore, type Db, type GoogleProfile } from './db.ts';
import { passwordMatches } from './auth/password.ts';
import { challengeOf, GoogleAuthError, googleClient, newVerifier, type GoogleClient } from './auth/google.ts';
import { RateLimiter } from './auth/rate-limit.ts';
import { SessionStore } from './auth/sessions.ts';
import { CaseInputError, validateCases, type RunnerClient } from './runner.ts';
import { Dispatcher, SubmissionStore } from './dispatcher.ts';
import { TestsetStore } from './testsets.ts';
import { buildCatalog, CatalogPublisher } from './catalog.ts';
import { sqliteSql, type Sql } from './sql.ts';
import type { ObjectStore } from './r2.ts';
import { log } from './redact.ts';

type Status = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503;

type Runner = Pick<RunnerClient, 'run' | 'runtime' | 'cancel'>;

export type AppDeps = {
  config: Config;
  db: Db;
  /** 저장소가 쓰는 SQL. 없으면 db(better-sqlite3)를 쓴다. Worker에서는 D1 */
  sql?: Sql;
  /** runner 여러 대. 디스패처가 빈 슬롯에 나눠 보낸다. */
  runners: Runner[];
  testsets?: TestsetStore;
  /** 공용 문제 데이터·테스트셋을 게시할 R2. 없으면 게시하지 않는다(데이터는 SQLite·로컬 파일에만) */
  objectStore?: ObjectStore | null;
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
  const sql = deps.sql ?? sqliteSql(db);
  const testsets = deps.testsets ?? new TestsetStore(':memory:');
  const now = deps.now ?? Date.now;
  const sessions = new SessionStore(sql, config.sessionTtlMs);
  const temporaryTtlMs = Math.min(config.sessionTtlMs, 24 * 3600_000);
  const temporarySessions = new SessionStore(sql, temporaryTtlMs);
  const problems = new ProblemStore(sql, testsets);
  const submissions = new SubmissionStore(db);
  const dispatcher = new Dispatcher(submissions, problems, testsets, runners as RunnerClient[], config.runnerSlots);
  const folders = new FolderStore(sql);
  const collections = new CollectionStore(sql);
  const users = new UserStore(sql);
  const signupSettings = new SignupSettingsStore(sql);
  const catalogSource = async () => ({ problems: await problems.catalogProblems(), folders: await folders.list(null), collections: await collections.list() });
  const catalog = deps.objectStore
    ? new CatalogPublisher(deps.objectStore, catalogSource, testsets, async () => new Set([...(await problems.testsetHashes()), ...submissions.activeTestsets()]))
    : null;
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
  app.use('/api/*', cors({ origin: config.webOrigin, credentials: true, allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allowHeaders: ['content-type', 'x-draft-owner'] }));
  app.onError((err, c) => {
    if (err instanceof StoreError) return fail(c, err.code === 'duplicate_name' ? 409 : 400, err.code, err.message);
    log.error(`[api] ${c.req.path}`, err);
    return fail(c, 500, 'internal', '요청을 처리하지 못했습니다.');
  });
  app.notFound((c) => fail(c, 404, 'not_found', '없는 경로입니다.'));

  // 공용 문제 데이터를 바꾸는 요청(편집 권한·관리자 모드)이 성공하면 메모리의 목록을 버리고, R2가 있으면 게시한 뒤 응답한다.
  // 그래야 편집한 사람이 바로 새로 읽을 때(?fresh=1) 새 내용을 받는다.
  const CATALOG_WRITE = /^\/api\/(problems|collections|admin\/collections|admin\/problems)(\/|$)/;
  let built: { at: number; cat: Promise<ReturnType<typeof buildCatalog>> } | null = null;
  app.use('/api/*', async (c, next) => {
    await next();
    if (c.req.method === 'GET' || c.res.status >= 400 || !CATALOG_WRITE.test(c.req.path)) return;
    if (!c.req.path.startsWith('/api/admin/') && !c.get('editor')) return;
    built = null;
    if (!catalog) return;
    try {
      await catalog.sync();
    } catch (e) {
      // 게시에 실패해도 SQLite에는 저장됐다. 다음 변경이나 재시작 때 다시 맞춘다.
      log.error('[catalog] R2 게시 실패', e);
    }
  });

  // ─── 공개 ───
  app.get('/api/health', async (c) => c.json({ data: { status: 'up' } }));

  const readSession = async (c: Context) => {
    const id = (await getSignedCookie(c, config.sessionSecret, SESSION_COOKIE)) || (await getSignedCookie(c, config.sessionSecret, LEGACY_SESSION_COOKIE));
    if (!id) return null;
    const s = await sessions.validate(id, now());
    return s ? { id, ...s } : null;
  };

  const flowCookie = { path: '/api/auth', httpOnly: true, secure: config.secureCookie, sameSite: 'Lax' as const, maxAge: FLOW_TTL_S };
  const sessionCookie = { path: '/', httpOnly: true, secure: config.secureCookie, sameSite: 'Lax' as const };

  const startSession = async (c: Context, userId: string, temporary = false) => {
    const s = await (temporary ? temporarySessions : sessions).create(userId, now());
    // Google에서 돌아오는 첫 이동에도 실리도록 Lax (변경 요청은 CORS·JSON 본문으로 막는다)
    await setSignedCookie(c, SESSION_COOKIE, s.id, config.sessionSecret, {
      ...sessionCookie,
      expires: new Date(s.expiresAt),
      maxAge: Math.floor((temporary ? temporaryTtlMs : config.sessionTtlMs) / 1000),
    });
    return s;
  };

  const isOwner = (email: string) => !!config.ownerEmail && email === config.ownerEmail;

  /** 운영자 계정이면 비밀번호 로그인 시절의 작성 코드·풀이 기록을 넘겨받는다 */
  const claimIfOwner = async (userId: string, email: string) => {
    if (!isOwner(email)) return;
    const n = await users.claimLegacy(userId);
    if (n) log.info(`[auth] 예전 데이터 ${n}건을 운영자 계정으로 옮겼습니다.`);
  };

  const sessionBody = async (s: { expiresAt: number; userId: string } | null) => {
    const u = s ? await users.byId(s.userId) : null;
    return u && s
      ? { authenticated: true, expiresAt: new Date(s.expiresAt).toISOString(), user: { email: u.email, name: u.name, picture: u.picture, editor: u.editor, owner: isOwner(u.email) } }
      : { authenticated: false, expiresAt: null, user: null };
  };

  app.get('/api/public/config', async (c) =>
    ok(c, PublicConfig, {
      googleEnabled: !!google,
      signupEnabled: await signupSettings.enabled(),
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
    const user = await users.byGoogleSub(profile.sub);
    if (user) {
      await users.touch(user.id, profile);
      await claimIfOwner(user.id, profile.email);
      await startSession(c, user.id);
      log.info(`[auth] 로그인 user=${user.id}`);
      return c.redirect(flow.next, 302);
    }
    if (!await signupSettings.enabled()) return back('signup_closed');
    // 새 사용자: 약관 동의 화면으로. Google 프로필은 서명한 쿠키에 잠시 둔다.
    await setSignedCookie(c, SIGNUP_COOKIE, encode({ profile, next: flow.next, exp: now() + FLOW_TTL_S * 1000 }), config.sessionSecret, flowCookie);
    return c.redirect('/signup', 302);
  });

  const readPending = async (c: Context) => {
    const p = decode<{ profile: GoogleProfile; next: string; exp: number }>(await getSignedCookie(c, config.sessionSecret, SIGNUP_COOKIE));
    return p && p.exp > now() && p.profile?.sub ? p : null;
  };

  app.get('/api/auth/signup', async (c) => {
    if (!await signupSettings.enabled()) return fail(c, 403, 'signup_closed', '신규 가입이 중지되어 있습니다. 기존 회원은 로그인할 수 있습니다.');
    const p = await readPending(c);
    if (!p) return fail(c, 404, 'no_pending_signup', '가입 대기 중인 Google 계정이 없습니다. 다시 시도하세요.');
    return ok(c, SignupPending, { email: p.profile.email, name: p.profile.name, picture: p.profile.picture });
  });

  app.post('/api/auth/signup', async (c) => {
    const p = await readPending(c);
    if (!p) return fail(c, 404, 'no_pending_signup', '가입 대기 중인 Google 계정이 없습니다. 다시 시도하세요.');
    const body = await readJson(c, SignupRequest);
    if (!body) return fail(c, 400, 'consent_required', '필수 항목에 모두 동의해야 가입할 수 있습니다.');
    // 본문을 읽는 동안 설정이 바뀔 수 있으므로 계정 생성 직전에 다시 검사한다.
    if (!await signupSettings.enabled()) return fail(c, 403, 'signup_closed', '신규 가입이 중지되어 있습니다. 기존 회원은 로그인할 수 있습니다.');
    // 운영자는 처음부터 편집 권한을 갖는다(공용 문제를 만들어 온 계정)
    const user = await users.create(p.profile, { terms: TERMS_VERSION, privacy: PRIVACY_VERSION }, { editor: isOwner(p.profile.email) });
    await claimIfOwner(user.id, p.profile.email);
    deleteCookie(c, SIGNUP_COOKIE, flowCookie);
    const s = await startSession(c, user.id);
    log.info(`[auth] 가입 user=${user.id}`);
    return ok(c, Session, await sessionBody({ expiresAt: s.expiresAt, userId: user.id }));
  });

  app.post('/api/auth/signup/cancel', async (c) => {
    deleteCookie(c, SIGNUP_COOKIE, flowCookie);
    return c.json({ data: { cancelled: true } });
  });

  // 임시 계정은 로그인마다 새로 만들고 개인 데이터는 보존한다.
  app.post('/api/auth/temporary', async (c) => {
    const blocked = authLimited(c);
    if (blocked) return blocked;
    if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json') || !(await readJson(c, z.object({}))))
      return fail(c, 400, 'invalid_request', '요청을 확인해 주세요.');
    if (!await signupSettings.enabled()) return fail(c, 403, 'signup_closed', '신규 가입이 중지되어 있습니다.');
    const id = randomUUID();
    const adjectives = ['말랑한', '포근한', '반짝이는', '따뜻한', '씩씩한', '수줍은', '발랄한', '졸린', '행복한', '상냥한'];
    const nouns = ['구름', '토끼', '다람쥐', '고양이', '햄스터', '펭귄', '오리', '곰', '별', '병아리'];
    const name = `${adjectives[randomInt(adjectives.length)]} ${nouns[randomInt(nouns.length)]}`;
    const user = await users.create({ sub: `temporary:${id}`, email: `${id}@temporary.invalid`, name, picture: '' },
      { terms: 'temporary', privacy: 'temporary' }, {}, new Date(now()));
    const s = await startSession(c, user.id, true);
    return ok(c, Session, await sessionBody({ expiresAt: s.expiresAt, userId: user.id }));
  });

  // ─── 자동화 테스트 전용 로그인(테스트 환경만, 운영에서는 경로가 없다) ───
  // Google 왕복 없이 원하는 계정(편집 권한 포함)으로 세션을 만든다. 약관 동의는 현재 버전으로 기록한다.
  if (config.testAuthToken) {
    const token = config.testAuthToken;
    log.warn('[test] 테스트 전용 로그인이 켜져 있습니다(테스트 환경 전용).');
    app.post('/api/test/session', async (c) => {
      if (!passwordMatches(token, c.req.header('x-test-auth') ?? '')) return fail(c, 401, 'unauthorized', '테스트 토큰이 올바르지 않습니다.');
      const body = await readJson(c, TestSessionRequest);
      if (!body) return fail(c, 400, 'invalid_request', 'email이 필요합니다.');
      const profile: GoogleProfile = { sub: `test:${body.email}`, email: body.email, name: body.name ?? body.email.split('@')[0]!, picture: '' };
      const user = await users.byGoogleSub(profile.sub) ?? await users.create(profile, { terms: TERMS_VERSION, privacy: PRIVACY_VERSION }, { editor: body.editor });
      if (body.editor !== undefined && user.editor !== body.editor) await users.setEditor(user.id, body.editor);
      const s = await startSession(c, user.id);
      return ok(c, Session, await sessionBody({ expiresAt: s.expiresAt, userId: user.id }));
    });
  }

  app.get('/api/auth/session', async (c) => ok(c, Session, await sessionBody(await readSession(c))));

  app.post('/api/auth/logout', async (c) => {
    const s = await readSession(c);
    if (s) await sessions.revoke(s.id);
    deleteCookie(c, SESSION_COOKIE, sessionCookie);
    deleteCookie(c, LEGACY_SESSION_COOKIE, sessionCookie);
    return ok(c, Session, await sessionBody(null));
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

  app.post('/api/admin/logout', async (c) => {
    deleteCookie(c, ADMIN_COOKIE, adminCookie);
    return ok(c, AdminSession, { authenticated: false, expiresAt: null });
  });

  app.use('/api/admin/*', async (c, next) => {
    const p = c.req.path;
    if (p === '/api/admin/login' || p === '/api/admin/session' || p === '/api/admin/logout') return next();
    if (!(await readAdmin(c))) return fail(c, 401, 'admin_required', '관리자 모드 비밀번호가 필요합니다.');
    return next();
  });

  app.get('/api/admin/users', async (c) => ok(c, z.array(AdminUser), await users.list()));

  app.get('/api/admin/users/:id', async (c) => {
    const d = await users.detail(c.req.param('id'));
    return d ? ok(c, AdminUserDetail, d) : fail(c, 404, 'not_found', '없는 사용자입니다.');
  });

  /** 편집 권한 주기·회수 */
  app.put('/api/admin/users/:id/role', async (c) => {
    const body = await readJson(c, RoleInput);
    if (!body) return fail(c, 400, 'invalid_request', 'editor 값이 필요합니다.');
    if (!await users.setEditor(c.req.param('id'), body.editor)) return fail(c, 404, 'not_found', '없는 사용자입니다.');
    log.info(`[admin] 편집 권한 ${body.editor ? '부여' : '회수'} user=${c.req.param('id')}`);
    return ok(c, AdminUserDetail, (await users.detail(c.req.param('id')))!);
  });

  /** 사용자 삭제: 계정과 작성 코드·컬렉션·제출 기록·세션을 모두 지운다(공용 문제는 남는다) */
  app.delete('/api/admin/users/:id', async (c) => {
    if (!await users.delete(c.req.param('id'))) return fail(c, 404, 'not_found', '없는 사용자입니다.');
    log.info(`[admin] 사용자 삭제 user=${c.req.param('id')}`);
    return c.json({ data: { deleted: true } });
  });

  app.get('/api/admin/signup-settings', async (c) => ok(c, SignupSettings, { signupEnabled: await signupSettings.enabled() }));

  app.put('/api/admin/signup-settings', async (c) => {
    const body = await readJson(c, SignupSettings);
    if (!body) return fail(c, 400, 'invalid_request', 'signupEnabled 값이 필요합니다.');
    await signupSettings.setEnabled(body.signupEnabled);
    log.info(`[admin] 신규 가입 ${body.signupEnabled ? '허용' : '중지'}`);
    return ok(c, SignupSettings, { signupEnabled: await signupSettings.enabled() });
  });

  /** 컬렉션 이름·설명 바꾸기(마스터, 스크립트용). 이름의 '/'는 계층 */
  app.put('/api/admin/collections/:id', async (c) => {
    const body = await readJson(c, CollectionInput);
    if (!body) return fail(c, 400, 'invalid_request', '컬렉션 이름이 필요합니다.');
    const col = await collections.update(c.req.param('id'), body);
    if (!col) return fail(c, 404, 'not_found', '없는 컬렉션입니다.');
    log.info(`[admin] 컬렉션 이름 변경 ${col.id}`);
    return ok(c, Collection, col);
  });

  /** 문제의 시작 코드 교체(스크립트용) */
  app.put('/api/admin/problems/:id/starter', async (c) => {
    const body = await readJson(c, CodeSet);
    if (!body) return fail(c, 400, 'invalid_request', 'java·python 시작 코드가 필요합니다.');
    return await problems.setStarter(c.req.param('id'), body) ? c.json({ data: { updated: true } }) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  // ─── 카탈로그(공용 문제 데이터, 로그인과 무관): Worker가 R2가 없을 때 여기서 읽어 엣지에 캐시한다 ───
  /** 같은 순간의 요청이 몰려도 한 번만 만든다(1초, 공용 데이터를 바꾸면 바로 버린다) */
  const currentCatalog = () => {
    if (!built || now() - built.at > 1000) built = { at: now(), cat: catalogSource().then(buildCatalog) };
    return built.cat;
  };
  app.get('/api/catalog/index', async (c) => {
    const cat = await currentCatalog();
    c.header('ETag', `"${cat.indexVersion}"`);
    return ok(c, CatalogIndex, cat.index);
  });
  /** 목록의 version을 만든 그 바이트를 그대로 준다(다시 직렬화하면 키 순서가 달라져 Worker의 해시 검사에 걸린다) */
  app.get('/api/catalog/problems/:id', async (c) => {
    const d = (await currentCatalog()).details.find((x) => x.id === c.req.param('id'));
    if (!d) return fail(c, 404, 'not_found', '없는 문제입니다.');
    c.header('ETag', `"${d.version}"`);
    c.header('Content-Type', 'application/json; charset=utf-8');
    return c.body(d.json);
  });

  // ─── 이하 Google 로그인 필요. 단 문제·폴더·실행 환경 조회(GET)는 비회원도 된다(작성 코드 등은 비어 있다). ───
  const guestReadable = (method: string, p: string) =>
    method === 'GET' && (p === '/api/runtime' || p === '/api/problems' || p === '/api/folders' || p === '/api/collections' || /^\/api\/problems\/[^/]+$/.test(p));

  app.use('/api/*', async (c, next) => {
    const p = c.req.path;
    if (p === '/api/health' || p.startsWith('/api/auth/') || p.startsWith('/api/public/') || p.startsWith('/api/catalog/') || p.startsWith('/api/admin/') || p.startsWith('/api/test/')) return next();
    const s = await readSession(c);
    const u = s ? await users.byId(s.userId) : null;
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

  // 실행 환경: runner 중 하나라도 살아 있으면 up
  app.get('/api/runtime', async (c) => {
    const all = await Promise.all(runners.map((r) => r.runtime()));
    return ok(c, Runtime, all.find((r) => r.runner === 'up') ?? all[0] ?? { runner: 'down', versions: { java: null, python: null } });
  });

  // ─── 내 풀이 상태(사용자 데이터, pahidc SQLite). 웹이 카탈로그와 합친다 ───
  app.get('/api/me/problems', async (c) => ok(c, z.array(MyProblemSummary), await problems.mySummaries(c.get('userId'))));
  app.get('/api/me/problems/:id', async (c) => {
    const st = await problems.myState(c.req.param('id'), c.get('userId'));
    return st ? ok(c, MyProblemState, st) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  // ─── 문제(공용) + 내 풀이 상태 (예전 웹 호환: 합친 결과를 한 번에) ───
  app.get('/api/problems', async (c) => ok(c, z.array(ProblemSummary), await problems.list(viewer(c))));

  app.put('/api/problems/:id/bookmark', async (c) => {
    const user = await users.byId(c.get('userId'));
    if (!user || c.req.header('x-draft-owner') !== user.email)
      return fail(c, 409, 'draft_owner_mismatch', '계정이 변경되어 저장하지 못했어요. 다시 로그인해 주세요.');
    const body = await readJson(c, Bookmark);
    if (!body) return fail(c, 400, 'invalid_request', '북마크 상태가 올바르지 않습니다.');
    if (!await problems.setBookmark(c.req.param('id'), c.get('userId'), body.bookmarked)) return fail(c, 404, 'not_found', '없는 문제입니다.');
    return ok(c, Bookmark, body);
  });

  app.post('/api/problems', editorOnly, async (c) => {
    const body = await readJson(c, ProblemInput);
    if (!body) return fail(c, 400, 'invalid_request', '문제 형식이 올바르지 않습니다.');
    return ok(c, Problem, await problems.create(body, c.get('userId')));
  });

  app.get('/api/problems/:id', async (c) => {
    const p = await problems.get(c.req.param('id'), viewer(c));
    return p ? ok(c, Problem, p) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  /** 자동 저장: 내 코드·케이스·메모는 누구나, 문제 내용은 편집 권한이 있을 때만 반영된다 */
  app.put('/api/problems/:id', async (c) => {
    const body = await readJson(c, ProblemInput);
    if (!body) return fail(c, 400, 'invalid_request', '문제 형식이 올바르지 않습니다.');
    const p = await problems.update(c.req.param('id'), body, c.get('userId'), c.get('editor'));
    return p ? ok(c, Problem, p) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  app.patch('/api/problems/:id', async (c) => {
    // 다른 탭에서 계정이 바뀌어도 이전 계정의 초안을 저장하지 않는다.
    const user = await users.byId(c.get('userId'));
    if (!user || c.req.header('x-draft-owner') !== user.email)
      return fail(c, 409, 'draft_owner_mismatch', '계정이 변경되어 동기화를 중지했어요. 다시 로그인해 주세요.');
    const body = await readJson(c, ProblemPatch);
    if (!body) return fail(c, 400, 'invalid_request', '변경 내용의 형식이 올바르지 않습니다.');
    const p = await problems.patch(c.req.param('id'), body, c.get('userId'), c.get('editor'));
    return p ? ok(c, Problem, p) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  app.delete('/api/problems/:id', editorOnly, async (c) =>
    await problems.delete(c.req.param('id')!) ? c.json({ data: { deleted: true } }) : fail(c, 404, 'not_found', '없는 문제입니다.'),
  );

  // ─── 폴더(사용자별 개인 정리, 비회원은 기본 폴더를 본다) ───
  app.get('/api/folders', async (c) => ok(c, z.array(Folder), await folders.list(viewer(c))));

  app.post('/api/folders', async (c) => {
    const body = await readJson(c, FolderInput);
    if (!body) return fail(c, 400, 'invalid_request', '폴더 이름이 필요합니다.');
    return ok(c, Folder, await folders.create(body.name, c.get('userId')));
  });

  app.put('/api/folders/:id', async (c) => {
    const body = await readJson(c, FolderInput);
    if (!body) return fail(c, 400, 'invalid_request', '폴더 이름이 필요합니다.');
    const f = await folders.rename(c.req.param('id'), body.name, c.get('userId'));
    return f ? ok(c, Folder, f) : fail(c, 404, 'not_found', '없는 폴더입니다.');
  });

  app.delete('/api/folders/:id', async (c) =>
    await folders.delete(c.req.param('id'), c.get('userId')) ? c.json({ data: { deleted: true } }) : fail(c, 404, 'not_found', '없는 폴더입니다.'),
  );

  // ─── 컬렉션(공용, 편집 권한자만 바꾼다. 이름의 '/'는 계층) ───
  app.get('/api/collections', async (c) => ok(c, z.array(Collection), await collections.list()));

  app.post('/api/collections', editorOnly, async (c) => {
    const body = await readJson(c, CollectionInput);
    if (!body) return fail(c, 400, 'invalid_request', '컬렉션 이름이 필요합니다.');
    return ok(c, Collection, await collections.create(body));
  });

  app.put('/api/collections/:id', editorOnly, async (c) => {
    const body = await readJson(c, CollectionInput);
    if (!body) return fail(c, 400, 'invalid_request', '컬렉션 이름이 필요합니다.');
    const col = await collections.update(c.req.param('id')!, body);
    return col ? ok(c, Collection, col) : fail(c, 404, 'not_found', '없는 컬렉션입니다.');
  });

  app.put('/api/collections/:id/items', editorOnly, async (c) => {
    const body = await readJson(c, CollectionItemsInput);
    if (!body) return fail(c, 400, 'invalid_request', 'problemIds 배열이 필요합니다.');
    const col = await collections.setItems(c.req.param('id')!, body.problemIds);
    return col ? ok(c, Collection, col) : fail(c, 404, 'not_found', '없는 컬렉션입니다.');
  });

  app.delete('/api/collections/:id', editorOnly, async (c) =>
    await collections.delete(c.req.param('id')!) ? c.json({ data: { deleted: true } }) : fail(c, 404, 'not_found', '없는 컬렉션입니다.'),
  );

  // ─── 풀이 시간(사용자별) ───
  app.put('/api/problems/:id/timer', async (c) => {
    const body = await readJson(c, ProblemTimer);
    if (!body) return fail(c, 400, 'invalid_request', '풀이 시간 형식이 올바르지 않습니다.');
    const t = await problems.setTimer(c.req.param('id'), body, c.get('userId'));
    return t ? ok(c, ProblemTimer, t) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  // ─── 히든 테스트셋(공용 채점 케이스): 편집 권한자만 보고 고친다 ───
  app.get('/api/problems/:id/hidden', editorOnly, async (c) => {
    const cases = await problems.hidden(c.req.param('id')!);
    return cases ? ok(c, HiddenCases, { cases }) : fail(c, 404, 'not_found', '없는 문제입니다.');
  });

  app.put('/api/problems/:id/hidden', editorOnly, async (c) => {
    const body = await readJson(c, HiddenCases);
    if (!body) return fail(c, 400, 'invalid_request', '히든 케이스 형식이 올바르지 않습니다.');
    const ref = await problems.setHidden(c.req.param('id')!, body.cases.map((x) => ({ ...x, hidden: true })));
    if (ref === false) return fail(c, 404, 'not_found', '없는 문제입니다.');
    return ok(c, HiddenCases, { cases: await problems.hidden(c.req.param('id')!) ?? [] });
  });

  // ─── 제출 큐 ───
  /** 요청을 검사해 대기열에 넣는다. 오류면 [status, code, message]를 돌려준다. */
  const enqueue = async (userId: string, req: SubmissionRequest, timeLimitOverride?: number): Promise<string | [Status, string, string]> => {
    const problem = req.problemId ? await problems.get(req.problemId, userId) : null;
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

  /** 긴 조회 대기 시간(?wait=초, 최대 25초: 프록시 응답 제한보다 충분히 짧게) */
  const waitMs = (c: Context) => Math.min(25, Math.max(0, Number(c.req.query('wait')) || 0)) * 1000;

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
    const id = await enqueue(c.get('userId'), body);
    if (typeof id !== 'string') return fail(c, id[0], id[1], id[2]);
    dispatcher.kick();
    // ?wait=초: 짧은 실행은 이 요청 하나로 결과까지 받는다
    const s = (await dispatcher.poll(id, waitMs(c))) ?? submissions.get(id)!;
    if (s.status === 'queued' || s.status === 'running') c.status(202);
    return ok(c, Submission, s);
  });

  app.get('/api/submissions', async (c) => {
    const raw = c.req.query('offset') ?? '0';
    if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > 100_000) return fail(c, 400, 'invalid_offset', '조회 위치가 올바르지 않습니다.');
    return ok(c, SubmissionHistory, submissions.history(c.get('userId'), Number(raw)));
  });

  app.get('/api/submissions/:id/detail', async (c) => {
    const detail = submissions.detail(c.req.param('id'), c.get('userId'));
    return detail ? ok(c, SubmissionDetail, detail) : fail(c, 404, 'not_found', '없는 제출입니다.');
  });

  app.get('/api/submissions/:id', async (c) => {
    const id = c.req.param('id');
    const s = submissions.ownedBy(id, c.get('userId')) ? await dispatcher.poll(id, waitMs(c)) : null;
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
    const id = await enqueue(c.get('userId'), { problemId: null, kind: 'run', ...rest, cases: body.cases.map((x) => ({ ...x, hidden: false })) }, timeLimitMs);
    if (typeof id !== 'string') return fail(c, id[0], id[1], id[2]);
    dispatcher.kick();
    const done = await dispatcher.wait(id);
    if (done.status === 'cancelled') return fail(c, 409, 'cancelled', '실행이 중지되었습니다.');
    if (done.status === 'error' || !done.result) return fail(c, 502, 'runner_error', done.error ?? '실행하지 못했습니다.');
    return ok(c, RunResult, done.result);
  });

  return { app, dispatcher, problems, submissions, testsets, catalog };
}
