import { z } from 'zod';
import { HiddenCases, JudgeStatus, judgeHeaders, judgeStreamHeaders, Runtime, TestsetRef, type JudgeJob, type TestCase } from '@solveline/shared';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** judge가 거절한 요청(400 잘못된 케이스, 409 테스트셋 없음 등). 메시지는 사용자에게 그대로 보여 줄 수 있다. */
export class JudgeError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** API가 쓰는 judge 기능. 운영은 HttpJudge(Tunnel 너머 pahidc), 테스트는 같은 HttpJudge에 judge 앱을 바로 붙인다. */
export interface Judge {
  submit(job: JudgeJob, waitMs: number): Promise<JudgeStatus>;
  status(id: string, waitMs: number): Promise<JudgeStatus | null>;
  cancel(id: string): Promise<JudgeStatus | null>;
  putTestset(cases: TestCase[]): Promise<TestsetRef | null>;
  testset(hash: string): Promise<TestCase[] | null>;
  /** 큰 히든 테스트셋을 해석하지 않고 흘려보낸다. 응답 본문은 저장한 케이스({data:{cases}}) 그대로다. */
  putTestsetStream(body: ReadableStream<Uint8Array>): Promise<{ ref: TestsetRef | null; response: Response }>;
  /** 저장한 테스트셋 응답({data:{cases}})을 해석하지 않고 그대로. 없으면 null */
  testsetStream(hash: string): Promise<Response | null>;
  runtime(): Promise<Runtime>;
}

const Envelope = z.object({ data: z.unknown() });
const ErrorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const DOWN: Runtime = { runner: 'down', versions: { java: null, python: null } };

/** 서명한 HTTP 요청으로 judge를 부른다. 긴 조회는 judge가 기다렸다 답한다. */
export class HttpJudge implements Judge {
  constructor(
    private baseUrl: string,
    private secret: string,
    private fetchImpl: Fetch = (url, init) => fetch(url, init),
  ) {}

  private async call<S extends z.ZodType>(schema: S, method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<z.infer<S> | null> {
    const text = body === undefined ? '' : JSON.stringify(body);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { ...(text ? { 'content-type': 'application/json' } : {}), ...(await judgeHeaders(this.secret, method, path, text)) },
        body: text || undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new JudgeError(502, 'judge_unreachable', `채점 서버에 연결할 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 404) return null;
    if (!res.ok) {
      const err = ErrorEnvelope.safeParse(json);
      throw err.success ? new JudgeError(res.status, err.data.error.code, err.data.error.message) : new JudgeError(502, 'judge_error', `채점 서버 오류 (${res.status})`);
    }
    return schema.parse(Envelope.parse(json).data);
  }

  async submit(job: JudgeJob, waitMs: number) {
    return (await this.call(JudgeStatus, 'POST', `/jobs?wait=${waitMs / 1000}`, job, waitMs + 30_000))!;
  }

  status(id: string, waitMs: number) {
    return this.call(JudgeStatus, 'GET', `/jobs/${encodeURIComponent(id)}?wait=${waitMs / 1000}`, undefined, waitMs + 30_000);
  }

  cancel(id: string) {
    return this.call(JudgeStatus, 'POST', `/jobs/${encodeURIComponent(id)}/cancel`, {});
  }

  putTestset(cases: TestCase[]) {
    return this.call(TestsetRef.nullable(), 'PUT', '/testsets', { cases }, 120_000);
  }

  async testset(hash: string) {
    return (await this.call(HiddenCases, 'GET', `/testsets/${encodeURIComponent(hash)}`))?.cases ?? null;
  }

  async putTestsetStream(body: ReadableStream<Uint8Array>) {
    const path = '/testsets?echo=1';
    const res = await this.raw(path, {
      method: 'PUT',
      // Node의 fetch는 스트림 본문에 duplex를 요구한다(Worker는 무시한다)
      ...({ duplex: 'half' } as object),
      body,
      headers: { 'content-type': 'application/json', ...(await judgeStreamHeaders(this.secret, 'PUT', path)) },
    }, 120_000);
    if (!res.ok) throw await this.error(res);
    const hash = res.headers.get('x-testset-hash');
    const count = Number(res.headers.get('x-testset-count'));
    return { ref: hash && hash !== 'none' ? { hash, count } : null, response: res };
  }

  async testsetStream(hash: string) {
    const path = `/testsets/${encodeURIComponent(hash)}`;
    const res = await this.raw(path, { headers: await judgeHeaders(this.secret, 'GET', path, '') }, 60_000);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.error(res);
    return res;
  }

  private async raw(path: string, init: RequestInit, timeoutMs: number) {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new JudgeError(502, 'judge_unreachable', `채점 서버에 연결할 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async error(res: Response) {
    const err = ErrorEnvelope.safeParse(await res.json().catch(() => null));
    return err.success ? new JudgeError(res.status, err.data.error.code, err.data.error.message) : new JudgeError(502, 'judge_error', `채점 서버 오류 (${res.status})`);
  }

  async runtime() {
    try {
      return (await this.call(Runtime, 'GET', '/runtime', undefined, 10_000)) ?? DOWN;
    } catch {
      return DOWN;
    }
  }
}
