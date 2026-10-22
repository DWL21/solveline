import type { RunRequest, RunResult, Runtime } from '@codetest/shared';

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

type RunnerCase = { argsJson?: string[]; stdin?: string; expectedJson?: string | null; expected?: string | null };

export function toRunnerCases(req: RunRequest): RunnerCase[] {
  return req.cases.map((c, i) => {
    const n = i + 1;
    if (req.mode === 'stdin') return { stdin: c.stdin, expected: c.expected.trim() === '' ? null : c.expected };
    return {
      argsJson: c.args.map((a, j) => normalizeLiteral(a, `테스트 ${n} 매개변수 ${j + 1}`)),
      expectedJson: c.expected.trim() === '' ? null : normalizeLiteral(c.expected, `테스트 ${n} 기댓값`),
    };
  });
}

type RawResult = { compile: RunResult['compile']; results: Omit<RunResult['results'][number], 'id'>[] };

export class RunnerClient {
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async run(req: RunRequest): Promise<RunResult> {
    const cases = toRunnerCases(req);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language: req.language, mode: req.mode, code: req.code, cases }),
        signal: AbortSignal.timeout(110_000),
      });
    } catch (e) {
      throw new RunnerError(`실행 서버에 연결할 수 없습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    const body = (await res.json().catch(() => null)) as (RawResult & { error?: string }) | null;
    if (!res.ok || !body) throw new RunnerError(body?.error ?? `실행 서버 오류 (${res.status})`);
    return {
      compile: body.compile,
      results: body.results.map((r, i) => ({ ...r, id: req.cases[i]?.id ?? String(i) })),
    };
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
