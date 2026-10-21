import { z } from 'zod';
import {
  Collection,
  Folder,
  Problem,
  ProblemSummary,
  RunResult,
  Runtime,
  Session,
  type CollectionInput,
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
  login: (password: string) => request(Session, '/api/auth/login', json('POST', { password })),
  logout: () => request(Session, '/api/auth/logout', json('POST')),
  runtime: () => request(Runtime, '/api/runtime'),
  problems: () => request(z.array(ProblemSummary), '/api/problems'),
  problem: (id: string) => request(Problem, `/api/problems/${encodeURIComponent(id)}`),
  createProblem: (p: ProblemInput) => request(Problem, '/api/problems', json('POST', p)),
  /** keepalive: 페이지를 떠나는 중에도 요청을 끝까지 보낸다(본문 64KB 이하일 때만 브라우저가 허용). */
  saveProblem: (id: string, p: ProblemInput, opts: { keepalive?: boolean } = {}) =>
    request(Problem, `/api/problems/${encodeURIComponent(id)}`, { ...json('PUT', p), keepalive: opts.keepalive }),
  deleteProblem: (id: string) => request(z.object({ deleted: z.boolean() }), `/api/problems/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  run: (r: RunRequest) => request(RunResult, '/api/run', json('POST', r)),
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

export const qk = {
  session: ['session'] as const,
  runtime: ['runtime'] as const,
  problems: ['problems'] as const,
  problem: (id: string) => ['problem', id] as const,
  folders: ['folders'] as const,
  collections: ['collections'] as const,
};
