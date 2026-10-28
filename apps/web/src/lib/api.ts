import { z } from 'zod';
import {
  Bookmark,
  CatalogIndex,
  CatalogProblem,
  MyProblemState,
  MyProblemSummary,
  mergeProblem,
  mergeSummaries,
  Collection,
  Folder,
  HiddenCases,
  Problem,
  ProblemSummary,
  ProblemTimer,
  RunResult,
  Runtime,
  Session,
  Submission,
  SubmissionDetail,
  SubmissionHistory,
  PublicConfig,
  SignupPending,
  AdminSession,
  AdminUser,
  AdminUserDetail,
  SignupSettings,
  type CollectionInput,
  type SubmissionRequest,
  type TestCase,
  type ProblemInput,
  type ProblemPatch,
  type RunRequest,
} from '@solveline/shared';

export class ApiError extends Error {
  constructor(
    /** HTTP 상태. 0이면 서버에 닿지 못함, -1이면 응답 형식이 계약과 다름 */
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
  get unreachable() {
    return this.status === 0;
  }
}

const Envelope = z.object({ data: z.unknown() });
const ErrorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

async function request<S extends z.ZodType>(schema: S, path: string, init: RequestInit = {}): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', '서버에 연결할 수 없어요');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ErrorEnvelope.safeParse(body);
    if (err.success) throw new ApiError(res.status, err.data.error.code, err.data.error.message);
    // 계약 봉투 없는 5xx는 앞단 프록시(vite·nginx·터널)가 답한 것
    if (res.status >= 500) throw new ApiError(0, 'NETWORK', `서버에 연결할 수 없어요 (${res.status})`);
    throw new ApiError(res.status, 'HTTP', `요청 실패 (${res.status})`);
  }
  const env = Envelope.safeParse(body);
  if (!env.success) throw new ApiError(-1, 'BAD_RESPONSE', '응답 형식이 올바르지 않아요');
  const parsed = schema.safeParse(env.data.data);
  if (!parsed.success) throw new ApiError(-1, 'BAD_RESPONSE', '응답 형식이 계약과 달라요');
  return parsed.data;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: JSON.stringify(body ?? {}) });
const enc = encodeURIComponent;

// ─── 카탈로그(공용 문제 데이터)는 Worker·엣지 캐시에서, 내 풀이 상태는 서버에서 받아 합친다 ───

/** 지금 로그인했는지. 세션을 받아 오는 함수들이 갱신한다. */
let signedIn: boolean | null = null;
let sessionRequest: Promise<Session> | null = null;
const trackSession = (p: Promise<Session>) => {
  void p.then((s) => (signedIn = s.authenticated), () => undefined);
  return p;
};
/** 세션이 끊겼을 때(401) */
export const markSignedOut = () => {
  signedIn = false;
};
async function isSignedIn() {
  if (signedIn !== null) return signedIn;
  return (await (sessionRequest ?? api.session())).authenticated;
}

/** 공용 문제 데이터를 바꾼 직후에는 엣지·브라우저 캐시(최대 1분)를 건너뛰고 새로 읽는다. */
const FRESH_MS = 2 * 60_000;
let freshUntil = 0;
let indexMemo: { at: number; promise: Promise<CatalogIndex> } | null = null;
const catalogChanged = () => {
  freshUntil = Date.now() + FRESH_MS;
  indexMemo = null;
};
const changesCatalog = <T>(p: Promise<T>) => p.then((v) => (catalogChanged(), v));

/** 목록·폴더·컬렉션 쿼리가 한꺼번에 불러도 한 번만 받는다 */
function catalogIndex(): Promise<CatalogIndex> {
  if (indexMemo && Date.now() - indexMemo.at < 30_000) return indexMemo.promise;
  const fresh = Date.now() < freshUntil;
  const promise = fresh ? request(CatalogIndex, `/api/catalog/index?fresh=${Date.now()}`, { cache: 'no-store' }) : request(CatalogIndex, '/api/catalog/index');
  indexMemo = { at: Date.now(), promise };
  promise.catch(() => (indexMemo = null));
  return promise;
}

/** 버전이 붙은 상세는 브라우저·엣지가 오래 캐시한다. 그 사이 목록이 바뀌었으면 목록을 새로 받아 다시 읽는다. */
async function catalogProblem(id: string): Promise<CatalogProblem> {
  const version = (await catalogIndex()).problems.find((p) => p.id === id)?.version;
  try {
    return await request(CatalogProblem, `/api/catalog/problems/${enc(id)}${version ? `?v=${version}` : ''}`);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'stale_version')) throw e;
    catalogChanged();
    return request(CatalogProblem, `/api/catalog/problems/${enc(id)}`, { cache: 'no-store' });
  }
}

/** 공용 문제 내용을 바꾸는 필드(편집 권한자만 반영된다) */
const SHARED_FIELDS = ['title', 'description', 'mode', 'params', 'timeLimitMs', 'cases', 'starterCode'] as const;

export const api = {
  session: () => (sessionRequest = trackSession(request(Session, '/api/auth/session'))),
  logout: () => trackSession(request(Session, '/api/auth/logout', json('POST'))),
  temporaryLogin: () => trackSession(request(Session, '/api/auth/temporary', json('POST'))),
  publicConfig: () => request(PublicConfig, '/api/public/config'),
  signupPending: () => request(SignupPending, '/api/auth/signup'),
  signup: () => trackSession(request(Session, '/api/auth/signup', json('POST', { agreeAge: true, agreeTerms: true, agreePrivacy: true }))),
  signupCancel: () => request(z.object({ cancelled: z.boolean() }), '/api/auth/signup/cancel', json('POST')),
  runtime: () => request(Runtime, '/api/runtime'),
  problems: async (): Promise<ProblemSummary[]> => {
    const [index, mine] = await Promise.all([catalogIndex(), isSignedIn().then((s) => (s ? request(z.array(MyProblemSummary), '/api/me/problems') : null))]);
    return mergeSummaries(index.problems, mine);
  },
  setBookmark: (id: string, bookmarked: boolean, owner: string) => request(Bookmark, `/api/problems/${encodeURIComponent(id)}/bookmark`, { ...json('PUT', { bookmarked }), headers: { 'X-Draft-Owner': owner }, keepalive: true }),
  problem: async (id: string): Promise<Problem> => {
    const [p, mine] = await Promise.all([catalogProblem(id), isSignedIn().then((s) => (s ? request(MyProblemState, `/api/me/problems/${enc(id)}`) : null))]);
    return Problem.parse(mergeProblem(p, mine));
  },
  createProblem: (p: ProblemInput) => changesCatalog(request(Problem, '/api/problems', json('POST', p))),
  /** keepalive: 페이지를 떠나는 중에도 요청을 끝까지 보낸다(본문 64KB 이하일 때만 브라우저가 허용). */
  saveProblem: (id: string, p: ProblemInput, opts: { keepalive?: boolean } = {}) =>
    changesCatalog(request(Problem, `/api/problems/${encodeURIComponent(id)}`, { ...json('PUT', p), keepalive: opts.keepalive })),
  patchProblem: (id: string, patch: ProblemPatch, owner: string, opts: { keepalive?: boolean; signal?: AbortSignal } = {}) => {
    const req = request(Problem, `/api/problems/${encodeURIComponent(id)}`, { ...json('PATCH', patch), ...opts, headers: { 'X-Draft-Owner': owner } });
    return SHARED_FIELDS.some((k) => k in patch) ? changesCatalog(req) : req;
  },
  deleteProblem: (id: string) => changesCatalog(request(z.object({ deleted: z.boolean() }), `/api/problems/${encodeURIComponent(id)}`, { method: 'DELETE' })),
  run: (r: RunRequest) => request(RunResult, '/api/run', json('POST', r)),
  /** 제출 큐: 바로 id를 받고, submission(id)로 결과를 조회한다 */
  submit: (r: SubmissionRequest) => request(Submission, '/api/submissions', json('POST', r)),
  submission: (id: string) => request(Submission, `/api/submissions/${encodeURIComponent(id)}`),
  submissionHistory: (offset = 0) => request(SubmissionHistory, `/api/submissions?offset=${offset}`),
  submissionDetail: (id: string) => request(SubmissionDetail, `/api/submissions/${encodeURIComponent(id)}/detail`),
  cancelSubmission: (id: string) => request(Submission, `/api/submissions/${encodeURIComponent(id)}/cancel`, json('POST')),
  saveTimer: (id: string, t: ProblemTimer, opts: { keepalive?: boolean } = {}) =>
    request(ProblemTimer, `/api/problems/${encodeURIComponent(id)}/timer`, { ...json('PUT', t), keepalive: opts.keepalive }),
  hidden: (id: string) => request(HiddenCases, `/api/problems/${encodeURIComponent(id)}/hidden`),
  saveHidden: (id: string, cases: TestCase[]) => changesCatalog(request(HiddenCases, `/api/problems/${encodeURIComponent(id)}/hidden`, json('PUT', { cases }))),
  /** 비회원은 기본 폴더(카탈로그), 회원은 개인 폴더(서버) */
  folders: async (): Promise<Folder[]> => ((await isSignedIn()) ? request(z.array(Folder), '/api/folders') : (await catalogIndex()).folders),
  createFolder: (name: string) => request(Folder, '/api/folders', json('POST', { name })),
  renameFolder: (id: string, name: string) => request(Folder, `/api/folders/${encodeURIComponent(id)}`, json('PUT', { name })),
  deleteFolder: (id: string) => request(z.object({ deleted: z.boolean() }), `/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  collections: async (): Promise<Collection[]> => (await catalogIndex()).collections,
  createCollection: (c: CollectionInput) => changesCatalog(request(Collection, '/api/collections', json('POST', c))),
  updateCollection: (id: string, c: CollectionInput) => changesCatalog(request(Collection, `/api/collections/${encodeURIComponent(id)}`, json('PUT', c))),
  setCollectionItems: (id: string, problemIds: string[]) =>
    changesCatalog(request(Collection, `/api/collections/${encodeURIComponent(id)}/items`, json('PUT', { problemIds }))),
  deleteCollection: (id: string) => changesCatalog(request(z.object({ deleted: z.boolean() }), `/api/collections/${encodeURIComponent(id)}`, { method: 'DELETE' })),
};

/** 관리자 모드(마스터 비밀번호) */
export const adminApi = {
  session: () => request(AdminSession, '/api/admin/session'),
  login: (password: string) => request(AdminSession, '/api/admin/login', json('POST', { password })),
  logout: () => request(AdminSession, '/api/admin/logout', json('POST')),
  users: () => request(z.array(AdminUser), '/api/admin/users'),
  user: (id: string) => request(AdminUserDetail, `/api/admin/users/${encodeURIComponent(id)}`),
  setEditor: (id: string, editor: boolean) => request(AdminUserDetail, `/api/admin/users/${encodeURIComponent(id)}/role`, json('PUT', { editor })),
  deleteUser: (id: string) => request(z.object({ deleted: z.boolean() }), `/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  signupSettings: () => request(SignupSettings, '/api/admin/signup-settings'),
  setSignupEnabled: (signupEnabled: boolean) => request(SignupSettings, '/api/admin/signup-settings', json('PUT', { signupEnabled })),
};

export const qk = {
  session: ['session'] as const,
  publicConfig: ['public-config'] as const,
  signup: ['signup'] as const,
  admin: ['admin'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminUser: (id: string) => ['admin', 'user', id] as const,
  signupSettings: ['admin', 'signup-settings'] as const,
  runtime: ['runtime'] as const,
  problems: ['problems'] as const,
  problem: (id: string) => ['problem', id] as const,
  folders: ['folders'] as const,
  collections: ['collections'] as const,
  hidden: (id: string) => ['hidden', id] as const,
  submissionHistory: (offset: number) => ['submission-history', offset] as const,
  submissionDetail: (id: string) => ['submission-detail', id] as const,
};
