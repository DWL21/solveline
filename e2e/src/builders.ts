import { randomUUID } from 'node:crypto';
import { templateFor, type Language, type ProblemInput, type ProblemMode, type TestCase } from '@solveline/shared';

/**
 * 테스트 데이터 빌더(Test Data Builder). 테스트에 중요한 값만 드러내고 나머지는 의미 있는 기본값으로 채운다.
 * 고정 픽스처를 공유하지 않고 테스트마다 새로 만든다 → 테스트끼리 독립적이고 순서에 의존하지 않는다.
 */
export const uid = () => randomUUID().slice(0, 8);

export const aCase = (args: string[], expected: string, overrides: Partial<TestCase> = {}): TestCase => ({
  id: uid(),
  args,
  stdin: '',
  expected,
  hidden: false,
  ...overrides,
});

export function aProblem(overrides: Partial<ProblemInput> & { title?: string } = {}): ProblemInput {
  const mode: ProblemMode = overrides.mode ?? 'function';
  const params = overrides.params ?? (mode === 'function' ? ['numbers'] : []);
  return {
    title: `E2E 두 수의 합 ${uid()}`,
    folderId: null,
    description: '정수 배열 numbers의 합을 return 하세요.',
    mode,
    params,
    timeLimitMs: 2000,
    cases: [aCase(['[1, 2]'], '3'), aCase(['[10, 20, 30]'], '60')],
    language: 'java',
    code: { java: templateFor('java', mode, params), python: templateFor('python', mode, params) },
    myCases: [],
    memo: '',
    lastSubmission: null,
    ...overrides,
  };
}

/** "배열의 합" 문제의 언어별 풀이. 판정(정답·오답·컴파일 오류·런타임 오류·시간 초과)마다 하나씩. */
export const sumSolutions: Record<Language, Record<'correct' | 'wrong' | 'compileError' | 'runtimeError' | 'timeout' | 'printsAndReturns', string>> = {
  java: {
    correct: 'class Solution {\n    public int solution(int[] numbers) {\n        int s = 0;\n        for (int n : numbers) s += n;\n        return s;\n    }\n}\n',
    wrong: 'class Solution {\n    public int solution(int[] numbers) {\n        return 0;\n    }\n}\n',
    compileError: 'class Solution {\n    public int solution(int[] numbers) {\n        return\n    }\n}\n',
    runtimeError: 'class Solution {\n    public int solution(int[] numbers) {\n        return numbers[numbers.length];\n    }\n}\n',
    timeout: 'class Solution {\n    public int solution(int[] numbers) {\n        while (true) {}\n    }\n}\n',
    printsAndReturns:
      'class Solution {\n    public int solution(int[] numbers) {\n        System.out.println("debug:" + numbers.length);\n        int s = 0;\n        for (int n : numbers) s += n;\n        return s;\n    }\n}\n',
  },
  python: {
    correct: 'def solution(numbers):\n    return sum(numbers)\n',
    wrong: 'def solution(numbers):\n    return 0\n',
    compileError: 'def solution(numbers)\n    return sum(numbers)\n',
    runtimeError: 'def solution(numbers):\n    return numbers[len(numbers)]\n',
    timeout: 'def solution(numbers):\n    while True:\n        pass\n',
    printsAndReturns: 'def solution(numbers):\n    print("debug:" + str(len(numbers)))\n    return sum(numbers)\n',
  },
};
