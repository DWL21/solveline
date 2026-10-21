import { z } from 'zod';

/** API 계약. api·web이 함께 쓴다. 성공 `{ data }`, 실패 `{ error: { code, message } }`. */

export const SESSION_COOKIE = 'codetest_session';

/** 비밀번호 로그인. 값은 GitHub Environment secret(ACCESS_PASSWORD)에만 있다. */
export const LoginRequest = z.object({ password: z.string().min(1).max(256) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const Session = z.object({ authenticated: z.boolean(), expiresAt: z.string().nullable() });
export type Session = z.infer<typeof Session>;

// ─── 실행 환경 ───

export const Language = z.enum(['java', 'python']);
export type Language = z.infer<typeof Language>;

/** function: 기존 solution 함수형 / stdin: 표준 입출력형 */
export const ProblemMode = z.enum(['function', 'stdin']);
export type ProblemMode = z.infer<typeof ProblemMode>;

export const Runtime = z.object({
  runner: z.enum(['up', 'down']),
  versions: z.object({ java: z.string().nullable(), python: z.string().nullable() }),
});
export type Runtime = z.infer<typeof Runtime>;

// ─── 문제(작업 공간) ───

const MAX_TEXT = 200_000;

/**
 * 함수형: args는 매개변수별 값(JSON 리터럴 텍스트), expected는 기댓값(JSON). 입출력형: stdin과 기대 출력.
 * hidden: 코드 실행에는 쓰지 않고 제출(채점)에만 쓰는 케이스.
 */
export const TestCase = z.object({
  id: z.string().min(1).max(64),
  args: z.array(z.string().max(MAX_TEXT)).max(20),
  stdin: z.string().max(MAX_TEXT),
  expected: z.string().max(MAX_TEXT),
  hidden: z.boolean().default(false),
});
export type TestCase = z.infer<typeof TestCase>;

// ─── 폴더(문제마다 하나) · 컬렉션(가상 묶음, 여러 개) ───

export const FolderInput = z.object({ name: z.string().trim().min(1).max(60) });
export type FolderInput = z.infer<typeof FolderInput>;

export const Folder = FolderInput.extend({ id: z.string(), position: z.number().int(), createdAt: z.string() });
export type Folder = z.infer<typeof Folder>;

export const CollectionInput = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(2000).default(''),
});
export type CollectionInput = z.infer<typeof CollectionInput>;

/** problemIds는 컬렉션 안의 순서 그대로다. */
export const Collection = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  problemIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Collection = z.infer<typeof Collection>;

export const CollectionItemsInput = z.object({ problemIds: z.array(z.string().min(1).max(64)).max(1000) });
export type CollectionItemsInput = z.infer<typeof CollectionItemsInput>;

/** 마지막 제출(채점) 결과 */
export const Submission = z.object({
  score: z.number().int().min(0).max(100),
  passed: z.number().int().min(0),
  total: z.number().int().min(0),
  language: z.enum(['java', 'python']),
  at: z.string(),
});
export type Submission = z.infer<typeof Submission>;

export const ProblemInput = z.object({
  title: z.string().trim().min(1).max(200),
  /** 폴더 id. null이면 폴더 없음 */
  folderId: z.string().max(64).nullable().default(null),
  description: z.string().max(MAX_TEXT),
  mode: ProblemMode,
  params: z.array(z.string().trim().min(1).max(64)).max(20),
  cases: z.array(TestCase).max(60),
  language: Language,
  code: z.object({ java: z.string().max(MAX_TEXT), python: z.string().max(MAX_TEXT) }),
  lastSubmission: Submission.nullable().default(null),
});
export type ProblemInput = z.infer<typeof ProblemInput>;

export const Problem = ProblemInput.extend({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Problem = z.infer<typeof Problem>;

export const ProblemSummary = Problem.pick({ id: true, title: true, folderId: true, mode: true, language: true, lastSubmission: true, updatedAt: true });
export type ProblemSummary = z.infer<typeof ProblemSummary>;

// ─── 실행 ───

export const RunRequest = z.object({
  language: Language,
  mode: ProblemMode,
  code: z.string().max(MAX_TEXT),
  cases: z.array(TestCase).min(1).max(40),
});
export type RunRequest = z.infer<typeof RunRequest>;

export const CaseStatus = z.enum(['pass', 'fail', 'done', 'error', 'timeout', 'skipped']);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const CaseResult = z.object({
  id: z.string(),
  status: CaseStatus,
  /** 함수형: 반환값 JSON / 입출력형: 표준 출력 */
  actual: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  timeMs: z.number(),
  memoryMb: z.number(),
});
export type CaseResult = z.infer<typeof CaseResult>;

export const RunResult = z.object({
  compile: z.object({ ok: z.boolean(), output: z.string() }),
  results: z.array(CaseResult),
});
export type RunResult = z.infer<typeof RunResult>;

// ─── 기본 템플릿 (기존 형식) ───

export const DEFAULT_PARAMS = ['numbers'];

export function templateFor(language: Language, mode: ProblemMode, params: string[] = DEFAULT_PARAMS): string {
  if (mode === 'stdin') {
    return language === 'java'
      ? 'import java.util.Scanner;\n\npublic class Solution {\n    public static void main(String[] args) {\n        Scanner sc = new Scanner(System.in);\n        int a = sc.nextInt();\n        int b = sc.nextInt();\n\n        System.out.println(a + b);\n    }\n}\n'
      : 'a, b = map(int, input().strip().split(\' \'))\nprint(a + b)\n';
  }
  if (language === 'java') {
    const sig = params.map((p) => `int[] ${p}`).join(', ');
    return `class Solution {\n    public int solution(${sig}) {\n        int answer = 0;\n        return answer;\n    }\n}\n`;
  }
  return `def solution(${params.join(', ')}):\n    answer = 0\n    return answer\n`;
}
