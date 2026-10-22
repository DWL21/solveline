import type { RunRequest, RunResult, Runtime, TestCase } from '@codetest/shared';

export class RunnerError extends Error {}
export class CaseInputError extends Error {}

/**
 * 기존 입력값 텍스트(JSON 리터럴)의 문법만 확인하고, runner에 넘길 JSON 텍스트를 돌려준다.
 * 값으로 바꾸지 않는다: JavaScript 숫자는 2^53을 넘는 정수를 정확히 담지 못하므로 해석은 runner(Python)가 한다.
 * 작은따옴표 문자열(['a', 'b'])은 큰따옴표로 바꿔 준다.
 */
export function normalizeLiteral(text: string, where: string): string {
  const t = text.trim();
  if (!t) throw new CaseInputError(`${where}: 값이 비어 있습니다.`);
  try {
    JSON.parse(t);
    return t;
  } catch {
    if (t.includes("'") && !t.includes('"')) {
      const fixed = t.replace(/'/g, '"');
      try {
        JSON.parse(fixed);
        return fixed;
      } catch {
        /* 아래에서 오류 */
      }
    }
    throw new CaseInputError(`${where}: JSON 형식이 아닙니다 (예: [1, 2], "abc", 3).`);
  }
}

/** 즉시 실행용(보이는) 케이스의 리터럴을 미리 검사해 400으로 알린다. 해석은 runner가 한다. */
export function validateCases(mode: RunRequest['mode'], cases: TestCase[]) {
  if (mode !== 'function') return;
  cases.forEach((c, i) => {
    c.args.forEach((a, j) => normalizeLiteral(a, `테스트 ${i + 1} 매개변수 ${j + 1}`));
    if (c.expected.trim()) normalizeLiteral(c.expected, `테스트 ${i + 1} 기댓값`);
  });
}

type RawResult = { compile: RunResult['compile']; results: Omit<RunResult['results'][number], 'id'>[] };

export type RunJob = {
  language: RunRequest['language'];
  mode: RunRequest['mode'];
  code: string;
  timeLimitMs: number;
  /** 요청에 담아 보내는 케이스(코드 실행) */
  cases?: TestCase[];
  /** runner 캐시에서 꺼내 쓰는 테스트셋(제출). raw는 캐시에 없을 때 한 번 올린다. */
  testset?: { hash: string; raw: () => string | null };
};

/** runner 한 대. 결과의 순서는 케이스 순서와 같다(id는 호출한 쪽이 붙인다). */
export class RunnerClient {
  constructor(
    readonly baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(path: string, body: string, method = 'POST') {
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15 * 60_000),
      });
    } catch (e) {
      throw new RunnerError(`실행 서버에 연결할 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async run(job: RunJob): Promise<Omit<RunResult, 'results'> & { results: RawResult['results'] }> {
    const body = JSON.stringify({ language: job.language, mode: job.mode, code: job.code, timeLimitMs: job.timeLimitMs, cases: job.cases, testset: job.testset?.hash });
    let res = await this.post('/run', body);
    if (res.status === 409 && job.testset) {
      // runner 캐시에 테스트셋이 없다 → 한 번 올리고 다시 실행
      const raw = job.testset.raw();
      if (raw === null) throw new RunnerError('테스트셋 파일이 없습니다.');
      const up = await this.post(`/testsets/${job.testset.hash}`, raw, 'PUT');
      if (!up.ok) throw new RunnerError(`테스트셋을 올리지 못했습니다 (${up.status})`);
      res = await this.post('/run', body);
    }
    const parsed = (await res.json().catch(() => null)) as (RawResult & { error?: string }) | null;
    if (!res.ok || !parsed) throw new RunnerError(parsed?.error ?? `실행 서버 오류 (${res.status})`);
    return parsed;
  }

  async runtime(): Promise<Runtime> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.json()) as { versions?: { java?: string | null; python?: string | null } };
      return { runner: res.ok ? 'up' : 'down', versions: { java: body.versions?.java ?? null, python: body.versions?.python ?? null } };
    } catch {
      return { runner: 'down', versions: { java: null, python: null } };
    }
  }
}
