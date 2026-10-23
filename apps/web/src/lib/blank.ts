import { templateFor, type Language, type ProblemInput, type ProblemMode, type TestCase } from '@codetest/shared';

/** 빈 테스트 케이스 (첫 화면 번들에 에디터를 끌어오지 않도록 lib에 둔다) */
export const newCase = (params: number, hidden = false): TestCase => ({
  id: crypto.randomUUID().slice(0, 8),
  args: Array.from({ length: params }, () => ''),
  stdin: '',
  expected: '',
  hidden,
});

export function blankProblem(title: string, mode: ProblemMode, language: Language, folderId: string | null = null): ProblemInput {
  const params = mode === 'function' ? ['numbers'] : [];
  return {
    title,
    folderId,
    description: '',
    mode,
    params,
    timeLimitMs: 10_000,
    cases: [newCase(params.length)],
    language,
    code: { java: templateFor('java', mode, params), python: templateFor('python', mode, params) },
    lastSubmission: null,
  };
}
