import { z } from 'zod';
import { Challenge, Problem, ProblemSummary, RunResult, Runtime, Session, type ProblemInput, type RunRequest } from '@codetest/shared';

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
  challenge: () => request(Challenge, '/api/auth/challenge', json('POST')),
  verify: (nonce: string, signature: string) => request(Session, '/api/auth/verify', json('POST', { nonce, signature })),
  logout: () => request(Session, '/api/auth/logout', json('POST')),
  runtime: () => request(Runtime, '/api/runtime'),
  problems: () => request(z.array(ProblemSummary), '/api/problems'),
  problem: (id: string) => request(Problem, `/api/problems/${encodeURIComponent(id)}`),
  createProblem: (p: ProblemInput) => request(Problem, '/api/problems', json('POST', p)),
  saveProblem: (id: string, p: ProblemInput) => request(Problem, `/api/problems/${encodeURIComponent(id)}`, json('PUT', p)),
  deleteProblem: (id: string) => request(z.object({ deleted: z.boolean() }), `/api/problems/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  run: (r: RunRequest) => request(RunResult, '/api/run', json('POST', r)),
};

export const qk = {
  session: ['session'] as const,
  runtime: ['runtime'] as const,
  problems: ['problems'] as const,
  problem: (id: string) => ['problem', id] as const,
};
