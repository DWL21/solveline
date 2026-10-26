import { z } from 'zod';

/** API 계약. api·web이 함께 쓴다. 성공 `{ data }`, 실패 `{ error: { code, message } }`. */

export const SESSION_COOKIE = 'solveline_session';
/** 예전 이름(codetest) 시절의 세션 쿠키. 읽기만 하고, 다음 로그인·로그아웃 때 지운다. */
export const LEGACY_SESSION_COOKIE = 'codetest_session';

/** 약관·개인정보처리방침 버전(시행일). 내용을 바꾸면 올리고, 가입 때 동의한 버전을 저장한다. */
export const TERMS_VERSION = '2026-10-23';
export const PRIVACY_VERSION = '2026-10-23';

/** editor: 편집 권한(문제 추가·수정, 채점 케이스, 폴더). 관리자 모드(마스터 비밀번호)에서 준다. */
/** owner: 운영자(OWNER_EMAIL). 화면 하단에 관리자 모드 링크를 보여 준다(관리자 모드 자체는 마스터 비밀번호로만 열린다). */
export const SessionUser = z.object({ email: z.string(), name: z.string(), picture: z.string(), editor: z.boolean(), owner: z.boolean() });
export type SessionUser = z.infer<typeof SessionUser>;

export const Session = z.object({ authenticated: z.boolean(), expiresAt: z.string().nullable(), user: SessionUser.nullable() });
export type Session = z.infer<typeof Session>;

/** 로그인 없이 읽는 공개 설정 */
export const PublicConfig = z.object({
  googleEnabled: z.boolean(),
  // 프론트가 먼저 배포되는 동안 이전 API의 응답도 읽는다. 실제 가입 허용은 서버가 결정한다.
  signupEnabled: z.boolean().default(true),
  contactEmail: z.string().nullable(),
  termsVersion: z.string(),
  privacyVersion: z.string(),
});
export type PublicConfig = z.infer<typeof PublicConfig>;

/** 회원가입 대기: Google 인증은 끝났고 약관 동의만 남은 상태 */
export const SignupPending = z.object({ email: z.string(), name: z.string(), picture: z.string() });
export type SignupPending = z.infer<typeof SignupPending>;

/** 회원가입 동의: 모두 필수 */
export const SignupRequest = z.object({ agreeAge: z.literal(true), agreeTerms: z.literal(true), agreePrivacy: z.literal(true) });
export type SignupRequest = z.infer<typeof SignupRequest>;

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

/** 컬렉션 이름의 '/'는 계층이다(예: "모의고사/1회") */
export const CollectionInput = z.object({
  name: z.string().trim().min(1).max(200),
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

/** 풀이 시간: 문제 화면이 보이는 동안 누적. solvedMs는 처음 100점을 받은 순간의 누적 시간(초기화하면 null). */
export const ProblemTimer = z.object({
  elapsedMs: z.number().int().min(0).max(1_000 * 3600 * 24 * 365),
  solvedMs: z.number().int().min(0).nullable(),
  /** 사용자가 일시정지했는지(새로고침해도 유지) */
  paused: z.boolean().default(false),
});
export type ProblemTimer = z.infer<typeof ProblemTimer>;
export const EMPTY_TIMER: ProblemTimer = { elapsedMs: 0, solvedMs: null, paused: false };

/** 마지막 제출(채점) 결과 */
export const LastSubmission = z.object({
  score: z.number().int().min(0).max(100),
  passed: z.number().int().min(0),
  total: z.number().int().min(0),
  language: z.enum(['java', 'python']),
  at: z.string(),
});
export type LastSubmission = z.infer<typeof LastSubmission>;

export const CodeSet = z.object({ java: z.string().max(MAX_TEXT), python: z.string().max(MAX_TEXT) });
export type CodeSet = z.infer<typeof CodeSet>;

/**
 * 문제 내용(제목·설명·채점 케이스·시간 제한·폴더·시작 코드)은 공용이고 편집 권한이 있는 사용자만 바꾼다.
 * 작성 코드·언어·내 테스트 케이스·메모·풀이 시간·마지막 제출은 사용자별.
 */
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
  /** 내가 작성 중인 코드(사용자별로 저장) */
  code: CodeSet,
  /** 시작 코드(공용). 편집 권한이 있어야 바꿀 수 있고, 없으면 그대로 둔다. */
  starterCode: CodeSet.optional(),
  /** 내가 추가한 테스트 케이스(사용자별, 코드 실행에만 쓴다) */
  myCases: z.array(TestCase).max(60).default([]),
  /** 내 메모(사용자별) */
  memo: z.string().max(MAX_TEXT).default(''),
  lastSubmission: LastSubmission.nullable().default(null),
});
export type ProblemInput = z.infer<typeof ProblemInput>;

/** 로컬 임시 저장의 변경분. 보내지 않은 필드는 최신 서버 값을 유지한다. */
export const ProblemPatch = ProblemInput.omit({ lastSubmission: true }).partial().extend({
  // 부분 업데이트에서는 기존 생성용 기본값을 채우면 안 된다.
  folderId: ProblemInput.shape.folderId.removeDefault().optional(),
  timeLimitMs: ProblemInput.shape.timeLimitMs.removeDefault().optional(),
  myCases: ProblemInput.shape.myCases.removeDefault().optional(),
  memo: ProblemInput.shape.memo.removeDefault().optional(),
  code: CodeSet.partial().optional(),
  starterCode: CodeSet.partial().optional(),
  timer: ProblemTimer.optional(),
});
export type ProblemPatch = z.infer<typeof ProblemPatch>;


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
  starterCode: CodeSet,
  hiddenTestset: TestsetRef.nullable(),
  timer: ProblemTimer,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Problem = z.infer<typeof Problem>;

export const ProblemSummary = Problem.pick({ id: true, title: true, folderId: true, mode: true, language: true, lastSubmission: true, timer: true, updatedAt: true });
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

/** cancelled: 사용자가 중지함(result에 중지 전까지의 결과가 남을 수 있다) */
export const SubmissionStatus = z.enum(['queued', 'running', 'done', 'error', 'cancelled']);
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

/** 목록에는 코드·히든 케이스 정보를 담지 않는다. */
export const SubmissionHistoryItem = Submission.pick({ id: true, problemId: true, language: true, status: true, score: true, createdAt: true, finishedAt: true }).extend({
  problemTitle: z.string().nullable(),
});
export type SubmissionHistoryItem = z.infer<typeof SubmissionHistoryItem>;
export const SubmissionHistory = z.object({ items: z.array(SubmissionHistoryItem), nextOffset: z.number().int().min(0).nullable() });
export type SubmissionHistory = z.infer<typeof SubmissionHistory>;
export const SubmissionDetail = Submission.extend({ code: z.string(), problemTitle: z.string().nullable() });
export type SubmissionDetail = z.infer<typeof SubmissionDetail>;

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

// ─── 관리자 ───

/** 관리자 모드는 Google 로그인과 별개로 마스터 비밀번호(ACCESS_PASSWORD)로만 연다. 사용자 편집 권한과 신규 가입 허용 여부를 관리한다. */
export const AdminLogin = z.object({ password: z.string().min(1).max(256) });
export const AdminSession = z.object({ authenticated: z.boolean(), expiresAt: z.string().nullable() });
export type AdminSession = z.infer<typeof AdminSession>;

export const AdminUser = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  picture: z.string(),
  editor: z.boolean(),
  createdAt: z.string(),
  lastLoginAt: z.string(),
  /** 100점 받은 문제 수 */
  solved: z.number().int(),
  submissions: z.number().int(),
});
export type AdminUser = z.infer<typeof AdminUser>;

export const AdminUserProblem = z.object({
  problemId: z.string(),
  title: z.string(),
  score: z.number().int().nullable(),
  elapsedMs: z.number(),
  solvedMs: z.number().nullable(),
  updatedAt: z.string(),
});
export const AdminSubmission = z.object({
  id: z.string(),
  problemTitle: z.string().nullable(),
  kind: z.enum(['run', 'submit']),
  language: Language,
  status: z.string(),
  score: z.number().int().nullable(),
  createdAt: z.string(),
});
export const AdminUserDetail = AdminUser.extend({
  termsVersion: z.string(),
  privacyVersion: z.string(),
  agreedAt: z.string(),
  problems: z.array(AdminUserProblem),
  recentSubmissions: z.array(AdminSubmission),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetail>;

export const RoleInput = z.object({ editor: z.boolean() });
/** 신규 가입만 제어한다. 기존 회원의 로그인·세션에는 영향을 주지 않는다. */
export const SignupSettings = z.object({ signupEnabled: z.boolean() });
export type SignupSettings = z.infer<typeof SignupSettings>;
