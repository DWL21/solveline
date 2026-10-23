import { z } from 'zod';
import {
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
  PublicConfig,
  SignupPending,
  AdminSession,
  AdminUser,
  AdminUserDetail,
  BlockedEmail,
  type CollectionInput,
  type SubmissionRequest,
  type TestCase,
  type ProblemInput,
  type RunRequest,
} from '@codetest/shared';

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

export const api = {
  session: () => request(Session, '/api/auth/session'),
  logout: () => request(Session, '/api/auth/logout', json('POST')),
  publicConfig: () => request(PublicConfig, '/api/public/config'),
  signupPending: () => request(SignupPending, '/api/auth/signup'),
  signup: () => request(Session, '/api/auth/signup', json('POST', { agreeAge: true, agreeTerms: true, agreePrivacy: true })),
  signupCancel: () => request(z.object({ cancelled: z.boolean() }), '/api/auth/signup/cancel', json('POST')),
  runtime: () => request(Runtime, '/api/runtime'),
  problems: () => request(z.array(ProblemSummary), '/api/problems'),
  problem: (id: string) => request(Problem, `/api/problems/${encodeURIComponent(id)}`),
  createProblem: (p: ProblemInput) => request(Problem, '/api/problems', json('POST', p)),
  /** keepalive: 페이지를 떠나는 중에도 요청을 끝까지 보낸다(본문 64KB 이하일 때만 브라우저가 허용). */
  saveProblem: (id: string, p: ProblemInput, opts: { keepalive?: boolean } = {}) =>
    request(Problem, `/api/problems/${encodeURIComponent(id)}`, { ...json('PUT', p), keepalive: opts.keepalive }),
  deleteProblem: (id: string) => request(z.object({ deleted: z.boolean() }), `/api/problems/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  run: (r: RunRequest) => request(RunResult, '/api/run', json('POST', r)),
  /** 제출 큐: 바로 id를 받고, submission(id)로 결과를 조회한다 */
  submit: (r: SubmissionRequest) => request(Submission, '/api/submissions', json('POST', r)),
  submission: (id: string) => request(Submission, `/api/submissions/${encodeURIComponent(id)}`),
  cancelSubmission: (id: string) => request(Submission, `/api/submissions/${encodeURIComponent(id)}/cancel`, json('POST')),
  saveTimer: (id: string, t: ProblemTimer, opts: { keepalive?: boolean } = {}) =>
    request(ProblemTimer, `/api/problems/${encodeURIComponent(id)}/timer`, { ...json('PUT', t), keepalive: opts.keepalive }),
  hidden: (id: string) => request(HiddenCases, `/api/problems/${encodeURIComponent(id)}/hidden`),
  saveHidden: (id: string, cases: TestCase[]) => request(HiddenCases, `/api/problems/${encodeURIComponent(id)}/hidden`, json('PUT', { cases })),
  folders: () => request(z.array(Folder), '/api/folders'),
  createFolder: (name: string) => request(Folder, '/api/folders', json('POST', { name })),
  renameFolder: (id: string, name: string) => request(Folder, `/api/folders/${encodeURIComponent(id)}`, json('PUT', { name })),
  deleteFolder: (id: string) => request(z.object({ deleted: z.boolean() }), `/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  collections: () => request(z.array(Collection), '/api/collections'),
  createCollection: (c: CollectionInput) => request(Collection, '/api/collections', json('POST', c)),
  updateCollection: (id: string, c: CollectionInput) => request(Collection, `/api/collections/${encodeURIComponent(id)}`, json('PUT', c)),
  setCollectionItems: (id: string, problemIds: string[]) =>
    request(Collection, `/api/collections/${encodeURIComponent(id)}/items`, json('PUT', { problemIds })),
  deleteCollection: (id: string) => request(z.object({ deleted: z.boolean() }), `/api/collections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

/** 관리자 모드(마스터 비밀번호) */
export const adminApi = {
  session: () => request(AdminSession, '/api/admin/session'),
  login: (password: string) => request(AdminSession, '/api/admin/login', json('POST', { password })),
  logout: () => request(AdminSession, '/api/admin/logout', json('POST')),
  users: () => request(z.array(AdminUser), '/api/admin/users'),
  user: (id: string) => request(AdminUserDetail, `/api/admin/users/${encodeURIComponent(id)}`),
  setEditor: (id: string, editor: boolean) => request(AdminUserDetail, `/api/admin/users/${encodeURIComponent(id)}/role`, json('PUT', { editor })),
  setBlocked: (id: string, blocked: boolean, reason = '') =>
    request(AdminUserDetail, `/api/admin/users/${encodeURIComponent(id)}/block`, json('PUT', { blocked, reason })),
  deleteUser: (id: string) => request(z.object({ deleted: z.boolean() }), `/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  blocklist: () => request(z.array(BlockedEmail), '/api/admin/blocklist'),
  block: (email: string, reason: string) => request(z.array(BlockedEmail), '/api/admin/blocklist', json('POST', { email, reason })),
  unblock: (email: string) => request(z.array(BlockedEmail), `/api/admin/blocklist/${encodeURIComponent(email)}`, { method: 'DELETE' }),
};

export const qk = {
  session: ['session'] as const,
  publicConfig: ['public-config'] as const,
  signup: ['signup'] as const,
  admin: ['admin'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminUser: (id: string) => ['admin', 'user', id] as const,
  blocklist: ['admin', 'blocklist'] as const,
  runtime: ['runtime'] as const,
  problems: ['problems'] as const,
  problem: (id: string) => ['problem', id] as const,
  folders: ['folders'] as const,
  collections: ['collections'] as const,
  hidden: (id: string) => ['hidden', id] as const,
};
