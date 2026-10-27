import type { Language, SubmissionStatus } from '@solveline/shared';
import { test, expect } from '../../src/fixtures.ts';
import { aCase, sumSolutions } from '../../src/builders.ts';

/**
 * 채점 파이프라인(실제 runner 컨테이너). 동등 분할: 판정 종류마다 대표 입력 하나.
 * 상태 전이: queued → running → done|error|cancelled 순서로만 진행하고 되돌아가지 않는다.
 */
const allowed: Record<SubmissionStatus, SubmissionStatus[]> = {
  queued: ['running', 'done', 'error', 'cancelled'],
  running: ['done', 'error', 'cancelled'],
  done: [],
  error: [],
  cancelled: [],
};
function expectValidTransitions(seen: SubmissionStatus[]) {
  for (let i = 1; i < seen.length; i++) expect(allowed[seen[i - 1]!], `${seen.join(' → ')}`).toContain(seen[i]);
  expect(['done', 'error', 'cancelled']).toContain(seen.at(-1));
}

for (const language of ['java', 'python'] as Language[]) {
  test.describe(`채점: ${language}`, () => {
    test.beforeEach(async ({ signIn }) => {
      await signIn();
    });
    const run = (api: import('../../src/api.ts').Api, code: string, timeLimit = false) =>
      api.judge({ problemId: null, kind: 'run', language, mode: 'function', code, cases: [aCase(['[1, 2]'], '3'), aCase(['[5, 5, 5]'], '15')] }, timeLimit ? 90_000 : 60_000);

    test('정답 → 모든 케이스 통과, 상태 전이가 올바르다', async ({ api }) => {
      const { submission, transitions } = await run(api, sumSolutions[language].correct);
      expectValidTransitions(transitions);
      expect(submission.status).toBe('done');
      expect(submission.result?.compile.ok).toBe(true);
      expect(submission.result?.results.map((r) => r.status)).toEqual(['pass', 'pass']);
    });

    test('오답 → 실패로 판정하고 실제 값을 돌려준다', async ({ api }) => {
      const { submission } = await run(api, sumSolutions[language].wrong);
      expect(submission.result?.results.map((r) => [r.status, r.actual])).toEqual([
        ['fail', '0'],
        ['fail', '0'],
      ]);
    });

    test('문법 오류 → 컴파일(구문) 에러', async ({ api }) => {
      const { submission } = await run(api, sumSolutions[language].compileError);
      expect(submission.result?.compile.ok).toBe(false);
      expect(submission.result?.compile.output).toMatch(language === 'java' ? /error/ : /SyntaxError/);
      expect(submission.result?.results).toEqual([]);
    });

    test('런타임 오류 → error와 에러 메시지', async ({ api }) => {
      const { submission } = await run(api, sumSolutions[language].runtimeError);
      expect(submission.result?.results[0]?.status).toBe('error');
      expect(submission.result?.results[0]?.stderr).toMatch(language === 'java' ? /ArrayIndexOutOfBounds/ : /IndexError/);
    });

    test('무한 루프 → 시간 초과로 끝난다', async ({ api }) => {
      test.slow();
      const { submission } = await run(api, sumSolutions[language].timeout, true);
      expect(submission.status).toBe('done');
      expect(submission.result?.results[0]?.status).toBe('timeout');
    });

    test('입출력형은 표준 입력을 읽고 출력의 줄 끝 공백을 무시해 채점한다', async ({ api }) => {
      const code = language === 'java'
        ? 'import java.util.Scanner; class Main { public static void main(String[] args) { Scanner s = new Scanner(System.in); System.out.println((s.nextInt() + s.nextInt()) + "  "); } }'
        : 'a, b = map(int, input().split())\nprint(str(a + b) + "  ")\n';
      const { submission, transitions } = await api.judge({
        problemId: null, kind: 'run', language, mode: 'stdin', code,
        cases: [aCase([], '3', { stdin: '1 2\n' }), aCase([], '-2', { stdin: '-5 3\n' })],
      });
      expectValidTransitions(transitions);
      expect(submission.status).toBe('done');
      expect(submission.result?.results.map((r) => r.status)).toEqual(['pass', 'pass']);
    });

    test('표준 출력을 반환값과 따로 보여 준다', async ({ api }) => {
      const { submission } = await run(api, sumSolutions[language].printsAndReturns);
      expect(submission.result?.results[0]).toMatchObject({ status: 'pass', stdout: expect.stringContaining('debug:2') });
    });
  });
}

test.describe('제출 채점(히든 테스트셋)', () => {
  test('히든 케이스로 점수를 매기고, 내 마지막 제출로 기록한다', async ({ api, signIn, seedProblem, editorApi }) => {
    const p = await seedProblem({ language: 'python' });
    await editorApi.setHidden(p.id, [aCase(['[100, 200]'], '300', { hidden: true }), aCase(['[7]'], '7', { hidden: true })]);
    await signIn();
    const submit = (code: string) => api.judge({ problemId: p.id, kind: 'submit', language: 'python', mode: 'function', code, cases: [] });

    const wrong = await submit(sumSolutions.python.wrong);
    expect(wrong.submission.score).toBe(0);
    const right = await submit(sumSolutions.python.correct);
    expect(right.submission.score).toBe(100);
    // 채점 결과에는 히든 케이스의 반환값을 남기지 않는다(문제 유출 방지)
    expect(right.submission.result?.results.map((r) => r.actual)).toEqual([null, null]);
    expect((await api.problem(p.id)).lastSubmission).toMatchObject({ score: 100, passed: 2, total: 2 });
  });

  test('2^53을 넘는 정수도 정확히 비교한다', async ({ api, signIn }) => {
    await signIn();
    const { submission } = await api.judge({
      problemId: null,
      kind: 'run',
      language: 'java',
      mode: 'function',
      code: 'class Solution {\n    public long solution(long x) {\n        return x + 1;\n    }\n}\n',
      cases: [aCase(['9007199254740993'], '9007199254740994')],
    });
    expect(submission.result?.results[0]).toMatchObject({ status: 'pass', actual: '9007199254740994' });
  });
});
