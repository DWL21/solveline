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
export const LastSubmission = z.object({
  score: z.number().int().min(0).max(100),
  passed: z.number().int().min(0),
  total: z.number().int().min(0),
  language: z.enum(['java', 'python']),
  at: z.string(),
});
export type LastSubmission = z.infer<typeof LastSubmission>;

export const ProblemInput = z.object({
  title: z.string().trim().min(1).max(200),
  /** 폴더 id. null이면 폴더 없음 */
  folderId: z.string().max(64).nullable().default(null),
  description: z.string().max(MAX_TEXT),
  mode: ProblemMode,
  params: z.array(z.string().trim().min(1).max(64)).max(20),
  /** 케이스당 시간 제한(ms). 함수형은 solution 호출 시간, 입출력형은 실행 시간 기준. */
  timeLimitMs: z.number().int().min(100).max(10_000).default(10_000),
  cases: z.array(TestCase).max(60),
  language: Language,
  code: z.object({ java: z.string().max(MAX_TEXT), python: z.string().max(MAX_TEXT) }),
  lastSubmission: LastSubmission.nullable().default(null),
});
export type ProblemInput = z.infer<typeof ProblemInput>;

/** 히든 테스트셋: 내용은 서버의 해시 파일에 있고 문제에는 해시와 개수만 둔다. */
export const TestsetRef = z.object({ hash: z.string(), count: z.number().int().min(0) });
export type TestsetRef = z.infer<typeof TestsetRef>;

/**
 * cases에는 보이는 케이스만 온다. 히든 케이스는 /api/problems/:id/hidden 으로 따로 읽고 쓴다.
 * (호환: ProblemInput.cases에 hidden 케이스를 넣어 보내면 히든 테스트셋을 그것으로 바꾼다.)
 * lastSubmission은 서버가 채점 결과로 갱신한다(입력값은 무시).
 */
export const Problem = ProblemInput.extend({
  id: z.string(),
  hiddenTestset: TestsetRef.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Problem = z.infer<typeof Problem>;

export const ProblemSummary = Problem.pick({ id: true, title: true, folderId: true, mode: true, language: true, lastSubmission: true, updatedAt: true });
export type ProblemSummary = z.infer<typeof ProblemSummary>;

// ─── 실행 ───

/** 히든 케이스는 효율성 테스트용 큰 데이터를 담으므로 필드 한도가 크다(문제 본문에는 들어가지 않는다). */
const MAX_HIDDEN_TEXT = 8_000_000;
export const HiddenTestCase = TestCase.extend({
  args: z.array(z.string().max(MAX_HIDDEN_TEXT)).max(20),
  stdin: z.string().max(MAX_HIDDEN_TEXT),
  expected: z.string().max(MAX_HIDDEN_TEXT),
});
export const HiddenCases = z.object({ cases: z.array(HiddenTestCase).max(200) });
export type HiddenCases = z.infer<typeof HiddenCases>;

// ─── 제출 큐 ───

/** run: 보이는 케이스(요청에 담음) / submit: 히든 테스트셋(없으면 요청의 케이스)으로 채점 */
export const SubmissionKind = z.enum(['run', 'submit']);
export type SubmissionKind = z.infer<typeof SubmissionKind>;

export const SubmissionRequest = z.object({
  problemId: z.string().max(64).nullable(),
  kind: SubmissionKind,
  language: Language,
  mode: ProblemMode,
  code: z.string().max(MAX_TEXT),
  cases: z.array(TestCase).max(40),
});
export type SubmissionRequest = z.infer<typeof SubmissionRequest>;

export const SubmissionStatus = z.enum(['queued', 'running', 'done', 'error']);
export type SubmissionStatus = z.infer<typeof SubmissionStatus>;

export const Submission = z.object({
  id: z.string(),
  problemId: z.string().nullable(),
  kind: SubmissionKind,
  language: Language,
  status: SubmissionStatus,
  /** queued일 때 앞에 기다리는 제출 수 */
  ahead: z.number().int().min(0).nullable(),
  /** 채점한 케이스의 id (run: 요청 순서, submit: 테스트셋 순서) */
  caseIds: z.array(z.string()),
  result: z.lazy(() => RunResult).nullable(),
  score: z.number().int().min(0).max(100).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type Submission = z.infer<typeof Submission>;

export const RunRequest = z.object({
  language: Language,
  mode: ProblemMode,
  timeLimitMs: z.number().int().min(100).max(10_000).default(10_000),
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
