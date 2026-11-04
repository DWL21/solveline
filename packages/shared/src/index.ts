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
export const SignupPending = z.object({
  email: z.string(),
  name: z.string(),
  picture: z.string(),
  /** 임시 계정으로 로그인한 채 가입한다: 임시 계정의 기록을 이 계정으로 이어 쓴다 */
  fromTemporary: z.boolean(),
});
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
  elapsedMs: z.number().int().min(0).max(1000 * 3600 * 24 * 365),
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
  folderId: z.string().max(128).nullable().default(null),
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
  folderId: ProblemInput.shape.folderId.unwrap().optional(),
  timeLimitMs: ProblemInput.shape.timeLimitMs.unwrap().optional(),
  myCases: ProblemInput.shape.myCases.unwrap().optional(),
  memo: ProblemInput.shape.memo.unwrap().optional(),
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

export const Bookmark = z.object({ bookmarked: z.boolean() });
export const ProblemSummary = Problem.pick({ id: true, title: true, folderId: true, mode: true, language: true, lastSubmission: true, timer: true, updatedAt: true }).extend({ bookmarked: z.boolean() });
export type ProblemSummary = z.infer<typeof ProblemSummary>;

// ─── 카탈로그(공용 문제 데이터): Worker가 R2·엣지 캐시에서 읽는다 ───

/** 문제의 공용 부분. folderId·language는 기본 폴더(틀)·기본 언어다. */
export const CatalogProblem = Problem.omit({ code: true, myCases: true, memo: true, timer: true, lastSubmission: true });
export type CatalogProblem = z.infer<typeof CatalogProblem>;

/** version은 CatalogProblem 내용의 해시다. 같은 version의 상세는 바뀌지 않으므로 오래 캐시한다. */
export const CatalogProblemSummary = CatalogProblem.pick({ id: true, title: true, folderId: true, mode: true, language: true, updatedAt: true }).extend({ version: z.string() });
export type CatalogProblemSummary = z.infer<typeof CatalogProblemSummary>;

/** 목록 한 장: 문제 요약·기본 폴더·컬렉션. 비회원 화면은 이것만으로 그린다. */
export const CatalogIndex = z.object({
  problems: z.array(CatalogProblemSummary),
  folders: z.array(Folder),
  collections: z.array(Collection),
});
export type CatalogIndex = z.infer<typeof CatalogIndex>;

/** 내 풀이 상태(목록용). 상태가 있는 문제만 온다. folderId는 개인 폴더, language는 내가 고른 언어. */
export const MyProblemSummary = z.object({
  id: z.string(),
  bookmarked: z.boolean(),
  folderId: z.string().nullable(),
  language: Language.nullable(),
  lastSubmission: LastSubmission.nullable(),
  timer: ProblemTimer,
});
export type MyProblemSummary = z.infer<typeof MyProblemSummary>;

/** 내 풀이 상태(문제 하나). code가 null이면 아직 작성하지 않아 시작 코드를 쓴다. */
export const MyProblemState = z.object({
  folderId: z.string().nullable(),
  language: Language.nullable(),
  code: CodeSet.nullable(),
  myCases: z.array(TestCase),
  memo: z.string(),
  timer: ProblemTimer,
  lastSubmission: LastSubmission.nullable(),
});
export type MyProblemState = z.infer<typeof MyProblemState>;

/** 공용 문제와 내 상태를 합친다. mine이 null이면 비회원(기본 폴더·시작 코드). */
export function mergeProblem(p: CatalogProblem, mine: MyProblemState | null): Problem {
  return {
    ...p,
    folderId: mine ? mine.folderId : p.folderId,
    language: mine?.language ?? p.language,
    code: mine?.code ?? p.starterCode,
    myCases: mine?.myCases ?? [],
    memo: mine?.memo ?? '',
    timer: mine?.timer ?? EMPTY_TIMER,
    lastSubmission: mine?.lastSubmission ?? null,
  };
}

/** 목록용 합치기. mine이 null이면 비회원, 회원이면 상태가 없는 문제도 개인 폴더 없음으로 둔다. */
export function mergeSummaries(index: CatalogProblemSummary[], mine: MyProblemSummary[] | null): ProblemSummary[] {
  const byId = new Map((mine ?? []).map((m) => [m.id, m]));
  return index.map(({ version: _version, ...p }) => {
    const m = byId.get(p.id);
    return {
      ...p,
      folderId: mine ? (m?.folderId ?? null) : p.folderId,
      language: m?.language ?? p.language,
      lastSubmission: m?.lastSubmission ?? null,
      timer: m?.timer ?? EMPTY_TIMER,
      bookmarked: m?.bookmarked ?? false,
    };
  });
}

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

/** runner가 직접 쓰는 안내 문구. 사용자 코드의 출력이 아니므로 제출 결과에 그대로 둔다. */
const RUNNER_NOTICES = [
  '프로세스가 강제 종료되었습니다 (메모리 초과 가능).',
  '전체 실행 시간 제한으로 건너뛰었습니다.',
  '중지되어 실행하지 않았습니다.',
  'Solution 클래스가 없습니다.',
  'solution 함수가 없습니다.',
  '실행 결과를 읽지 못했습니다.',
];
const PYTHON_ERRORS = new Set([
  'ArithmeticError', 'AssertionError', 'AttributeError', 'BaseException', 'EOFError', 'Exception', 'FileNotFoundError',
  'FloatingPointError', 'ImportError', 'IndentationError', 'IndexError', 'KeyError', 'KeyboardInterrupt', 'LookupError',
  'MemoryError', 'ModuleNotFoundError', 'NameError', 'NotImplementedError', 'OSError', 'OverflowError', 'PermissionError',
  'RecursionError', 'RuntimeError', 'StopIteration', 'SyntaxError', 'SystemError', 'SystemExit', 'TabError', 'TimeoutError',
  'TypeError', 'UnboundLocalError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeError', 'ValueError', 'ZeroDivisionError',
]);

/**
 * 제출(히든 케이스) 결과의 오류 출력을 오류 종류로만 줄인다. 사용자 코드의 오류 메시지·출력에는 히든 입력이 담길 수 있다.
 * 예외 이름은 표준 예외(Python 내장, java·javax·jdk 패키지)일 때만 남긴다(사용자가 만든 이름으로 값을 내보내지 못하게).
 */
export function submitErrorSummary(stderr: string, status: CaseStatus): string {
  const text = stderr.trim();
  if (!text) return '';
  const notice = RUNNER_NOTICES.find((n) => text.includes(n));
  if (notice) return notice;
  if (status !== 'error') return '';
  const java = /(?:^|[\s(])((?:java|javax|jdk)\.[A-Za-z0-9_.$]*?\.([A-Z][A-Za-z0-9_$]*(?:Exception|Error)))(?=$|[\s:])/m.exec(text);
  if (java) return `런타임 에러 (${java[2]})`;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const name = /^([A-Za-z_][A-Za-z0-9_]*)(?::|$)/.exec(lines.at(-1) ?? '')?.[1];
  if (name && PYTHON_ERRORS.has(name)) return `런타임 에러 (${name})`;
  return '런타임 에러';
}

/** 제출 결과에서 반환값·출력·오류 원문을 지운다(judge가 저장하기 전, API가 돌려주기 전 모두 적용). */
export function redactSubmitResult(result: RunResult): RunResult {
  return {
    compile: result.compile,
    results: result.results.map((r) => ({ ...r, actual: null, stdout: '', stderr: submitErrorSummary(r.stderr, r.status) })),
  };
}

/** 채점 결과로 마지막 제출 기록을 만든다. 서버가 저장하는 값과 화면에 바로 반영하는 값이 같다. total은 채점한 케이스 수. */
export function lastSubmissionOf(result: RunResult, total: number, language: Language, at: string): LastSubmission {
  const passed = result.compile.ok ? result.results.filter((r) => r.status === 'pass').length : 0;
  return { score: total ? Math.round((passed / total) * 100) : 0, passed, total, language, at };
}


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

// ─── 일일 메일 ───
/** 임시 계정의 이메일 도메인. 실제로 받을 수 없는 주소라 메일을 보내지 않는다 */
export const TEMPORARY_EMAIL_DOMAIN = 'temporary.invalid';
export const isTemporaryEmail = (email: string) => email.endsWith(`@${TEMPORARY_EMAIL_DOMAIN}`);
export const DailySubscribeInput = z.object({ email: z.email().max(254), consent: z.literal(true) });
export const DailySubscribeResult = z.object({ status: z.literal('pending') });
/** 미니 문제의 유형. 사람마다 정답률이 낮은 유형을 더 자주 고른다 */
export const DAILY_TOPICS = ['배열·문자열', '해시', '스택·큐', '정렬', '이분 탐색', '투 포인터', '그리디', '완전 탐색', 'DFS·BFS', '동적 계획법', '그래프', '트리', '수학', '구현'] as const;
export const DailyTopic = z.enum(DAILY_TOPICS);
export type DailyTopic = z.infer<typeof DailyTopic>;
export const DailyProblemStatus = z.enum(['draft', 'ready', 'retired']);
export type DailyProblemStatus = z.infer<typeof DailyProblemStatus>;

/**
 * 메일·인박스 전용 미니 문제. 풀이는 일반 문제와 같은 IDE·채점을 쓰고, 일반 문제 목록에는 나오지 않는다.
 * cases는 예제(hidden=false, 1~5개)와 채점 케이스(hidden=true)를 함께 넣는다. 저장 전에 referenceSolution으로 모든 케이스를 채점해
 * 100점일 때만 받는다(틀린 정답·케이스가 들어가지 않게).
 */
export const DailyProblemInput = z
  .object({
    topic: DailyTopic,
    level: z.number().int().min(1).max(5),
    title: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(4000),
    mode: ProblemMode,
    params: z.array(z.string().trim().min(1).max(64)).max(10),
    timeLimitMs: z.number().int().min(100).max(5000).default(2000),
    cases: z.array(TestCase).min(4).max(60),
    starterCode: CodeSet,
    referenceSolution: z.object({ language: Language, code: z.string().min(1).max(20_000) }),
    hint: z.string().trim().max(500).default(''),
    status: DailyProblemStatus.default('ready'),
  })
  .superRefine((p, ctx) => {
    const shown = p.cases.filter((c) => !c.hidden).length;
    if (shown < 1 || shown > 5) ctx.addIssue({ code: 'custom', path: ['cases'], message: '예제(hidden=false)는 1~5개예요' });
    if (p.cases.length - shown < 3) ctx.addIssue({ code: 'custom', path: ['cases'], message: '채점 케이스(hidden=true)는 3개 이상이에요' });
    if (new Set(p.cases.map((c) => c.id)).size !== p.cases.length) ctx.addIssue({ code: 'custom', path: ['cases'], message: '케이스 id가 겹쳐요' });
  });
export type DailyProblemInput = z.input<typeof DailyProblemInput>;
export type DailyProblemData = z.output<typeof DailyProblemInput>;

export const DailyProblemSummary = z.object({
  id: z.string(),
  topic: DailyTopic,
  level: z.number(),
  title: z.string(),
  status: DailyProblemStatus,
  /** 만든 곳: admin 또는 agent:<이름> */
  source: z.string(),
  /** 이 문제를 받은 사람 수와 그중 맞힌 사람 수 */
  picks: z.number(),
  solved: z.number(),
  createdAt: z.string(),
});
export type DailyProblemSummary = z.infer<typeof DailyProblemSummary>;
export const DailyProblemDetail = DailyProblemSummary.extend({
  description: z.string(),
  mode: ProblemMode,
  params: z.array(z.string()),
  timeLimitMs: z.number(),
  /** 예제만. 채점 케이스는 judge에 있다 */
  cases: z.array(TestCase),
  starterCode: CodeSet,
  hint: z.string(),
});
export type DailyProblemDetail = z.infer<typeof DailyProblemDetail>;
export const DailyBankCell = z.object({ topic: DailyTopic, level: z.number(), ready: z.number(), draft: z.number() });
export type DailyBankCell = z.infer<typeof DailyBankCell>;
/** 관리자 일괄 작업: 고른 문제들(한 번에 200개까지) */
export const DailyBulkInput = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200) });
export const DailyBulkStatusInput = DailyBulkInput.extend({ status: DailyProblemStatus });
/** changed: 바뀐(지운) 수, skipped: 없거나 받은 사람이 있어 남긴 수 */
export const DailyBulkResult = z.object({ changed: z.number(), skipped: z.number() });
export type DailyBulkResult = z.infer<typeof DailyBulkResult>;
/** 기준 풀이 검증 결과. 실패하면 어떤 케이스가 어떻게 틀렸는지 돌려준다 */
export const DailyVerifyResult = z.object({
  ok: z.boolean(),
  score: z.number().nullable(),
  failures: z.array(z.object({ id: z.string(), status: z.string(), expected: z.string(), actual: z.string().nullable(), stderr: z.string() })),
  error: z.string().nullable(),
});
export type DailyVerifyResult = z.infer<typeof DailyVerifyResult>;
export const DailySaveResult = z.object({ saved: z.boolean(), id: z.string().nullable(), verify: DailyVerifyResult });
export type DailySaveResult = z.infer<typeof DailySaveResult>;

/**
 * 출제 기준과 작업 절차. MCP 서버가 bank_guide 도구와 create_daily_batch 프롬프트로 그대로 준다.
 * 실행하는 쪽(Codex·Claude 등)의 프롬프트에는 "지침을 읽고 N개 만들라"만 두므로, 기준을 바꾸려면 여기만 고친다.
 */
export const DAILY_AUTHOR_GUIDE = `Solveline 일일 미니 문제 출제 기준

## 목적
코딩 테스트를 준비하는 사람이 매일 한 문제씩 풀며 핵심 자료구조·알고리즘 개념을 익히는 학습용 문제다.
- 문제마다 학습 목표 개념을 하나 정하고, 그 개념을 써야 자연스럽게 풀리게 만든다. 단순 구현·문자열 가공만으로 끝나는 문제는 만들지 않는다.
- 개념을 쓰지 않은 순진한 풀이(전수 비교 등)는 제한에서 시간 초과가 나도록 입력 크기 제한을 정한다.
- 이름만 바꾼 교과서 문제(두 수의 합, 괄호 검사 그대로 등)는 피하고, 상황과 조건을 새로 설계한다. 저작권이 있는 문제를 옮기지 않는다.

## 유형별 핵심 개념(이 중 하나를 학습 목표로)
- 배열·문자열: 누적 합, 차분 배열, 슬라이딩 윈도, 문자 빈도 배열
- 해시: 해시맵 개수 세기, 집합으로 중복·존재 판정, 누적 합과 해시 결합
- 스택·큐: 단조 스택(다음 큰 수 등), 괄호·되돌리기 처리, 큐 시뮬레이션, 덱
- 정렬: 정렬 후 탐욕·이웃 비교, 사용자 정의 비교, 구간 정렬·병합
- 이분 탐색: 정렬 배열의 경계 찾기, 답(매개변수) 이분 탐색
- 투 포인터: 정렬 후 양끝 포인터, 같은 방향 두 포인터(구간 조건)
- 그리디: 정렬 기준이 핵심인 선택, 구간 일정, 우선순위 큐로 매번 최선 고르기
- 완전 탐색: 백트래킹과 가지치기, 부분집합·순열, 비트마스크
- DFS·BFS: 격자 BFS 최단 거리, 연결 요소, 다중 시작점 BFS, 상태 공간 BFS
- 동적 계획법: 1차원·2차원 점화식, 배낭, 최장 증가 부분 수열, 구간 DP
- 그래프: 다익스트라, 위상 정렬, 유니온 파인드, 최소 신장 트리
- 트리: 트리 순회와 깊이·부모, 서브트리 합, 최소 공통 조상
- 수학: 소수 체(에라토스테네스), 최대공약수·최소공배수, 모듈러 연산, 조합
- 구현: 상태 기계·시뮬레이션이되 자료구조(맵·큐·우선순위 큐) 선택이 핵심인 것

## 난이도
- level 1 개념 하나를 그대로, 2 개념 하나를 한 번 응용, 3 대표 알고리즘을 조건에 맞게 변형, 4 개념 두 가지 결합·최적화, 5 실전 고난도.
- 학습용이므로 조금 어렵게: 주로 2~4로 만들고, 1은 해당 유형이 비어 있을 때만, 5는 가끔.

## 형식
- 기본은 함수형(mode=function). params는 매개변수 이름, 케이스 args는 매개변수별 JSON 리터럴 텍스트, expected는 반환값 JSON.
- 설명(description, 마크다운): 상황 1~3문장, 입력·출력 조건, 제한(크기·값 범위). 풀이 방법이나 개념 이름은 설명에 쓰지 않는다(스포일러). 예제는 cases의 hidden=false로만 둔다.
- 힌트(hint): 학습 목표 개념으로 이끄는 한두 문장. 개념 이름이나 "무엇을 저장해 두면 다시 계산하지 않을지" 같은 방향을 준다. 코드는 쓰지 않는다.
- 케이스: 예제 1~5개 + 채점 케이스(hidden=true) 6개 이상. 빈 입력·최솟값·최댓값·중복·음수 같은 경계와, 순진한 풀이가 틀리기 쉬운 경우를 넣는다. 정답이 하나로 정해지게.
- 케이스 입력은 작게: 케이스 하나의 args를 합쳐 2,000자 이하. 최대 크기 입력은 케이스로 넣지 말고 제한에만 적는다(큰 입력은 도구 호출 크기 제한에 걸린다).
- 시작 코드(starterCode): java는 class Solution { public <타입> solution(...) { } }, python은 def solution(...): 형태.
- 기준 풀이(referenceSolution): 학습 목표 개념을 쓴 효율적인 풀이. 모든 케이스를 통과해야 저장된다.
- 문체: 한국어, 존댓말 없이 간결한 문제 문체.`;

/** 한 번에 문제를 여러 개 만드는 작업 절차. MCP 프롬프트(create_daily_batch)와 자동 제작이 함께 쓴다 */
export const dailyBatchTask = (count?: number) => {
  const n = count ? `${count}개` : '요청받은 수만큼';
  return `Solveline 일일 미니 문제를 ${n} 새로 만든다. solveline_bank MCP 도구만 쓰고, 셸 명령·파일·인터넷은 쓰지 않는다.
1. bank_guide를 읽고 출제 기준을 그대로 따른다.
2. bank_overview에서 공개(ready) 문제가 적은 유형×난이도 칸을 고른다. 서로 다른 유형으로 고르고, 난이도는 출제 기준대로 2~4를 중심으로 한다.
3. 칸마다 list_problems로 같은 유형의 기존 제목을 보고, 학습 목표 개념과 상황이 겹치지 않는 새 문제를 설계한다.
4. create_problem으로 저장한다(status는 ready). saved가 false면 verify.failures를 보고 케이스나 기준 풀이를 고쳐 다시 시도한다(문제마다 최대 3번).
5. ${n} 저장하면 끝내고, 저장한 문제마다 id·유형·난이도·제목·학습 목표 개념을 한 줄씩 보고한다. 저장하지 못한 문제가 있으면 이유도 적는다.`;
};

/**
 * 문제은행 에이전트 도구(MCP). pahidc의 stdio MCP 서버가 이 목록을 그대로 내보내고, 호출은 서명해 Worker로 넘긴다.
 * 모델과 무관하게 MCP를 쓰는 에이전트라면 누구나 같은 도구로 문제를 만든다.
 */
export const DailyBankTools = {
  bank_guide: { description: '출제 기준(학습 목표 개념·유형별 핵심 개념·난이도·형식)과 여러 문제를 만드는 작업 절차. 문제를 만들기 전에 먼저 읽는다.', input: z.object({}) },
  bank_overview: { description: '문제은행 현황: 모든 유형(topic)×난이도(level) 칸의 공개(ready)·작성 중(draft) 문제 수(0인 칸 포함)와 공개 문제가 가장 적은 칸 목록. 그 칸부터 채운다.', input: z.object({}) },
  list_problems: {
    description: '문제 목록(제목·유형·난이도·받은 사람·맞힌 사람). 겹치는 문제를 만들지 않도록 같은 유형의 제목을 먼저 확인한다.',
    input: z.object({ topic: DailyTopic.optional(), status: DailyProblemStatus.optional(), limit: z.number().int().min(1).max(200).default(50) }),
  },
  get_problem: { description: '문제 하나의 설명·예제·시작 코드·힌트.', input: z.object({ id: z.string().max(64) }) },
  verify_problem: { description: '저장하지 않고 기준 풀이로 모든 케이스를 채점해 본다.', input: DailyProblemInput },
  create_problem: { description: '미니 문제를 만든다. 기준 풀이가 모든 케이스를 통과해야 저장되고, status=ready면 바로 발송 대상이 된다.', input: DailyProblemInput },
  update_problem: {
    description: '문제 내용을 고친다(기준 풀이 검증을 다시 한다). 이미 받은 사람이 있으면 설명·힌트 같은 문구만 고치고 케이스는 바꾸지 않는 편이 좋다.',
    input: z.object({ id: z.string().max(64), problem: DailyProblemInput }),
  },
  set_status: { description: '문제 상태를 바꾼다. ready는 발송 대상, draft는 작성 중, retired는 더 보내지 않음.', input: z.object({ id: z.string().max(64), status: DailyProblemStatus }) },
} as const;
export type DailyBankToolName = keyof typeof DailyBankTools;
export const DAILY_BANK_TOOL_NAMES = Object.keys(DailyBankTools) as [DailyBankToolName, ...DailyBankToolName[]];
export const DailyBankCall = z.object({ agent: z.string().regex(/^[\w.-]{1,40}$/), tool: z.enum(DAILY_BANK_TOOL_NAMES), args: z.unknown() });
/** pahidc의 MCP 서버가 서명해 부르는 Worker 경로 */
export const DAILY_BANK_PATH = '/api/internal/daily/bank';
export const DailySubscriber = z.object({
  id: z.string(),
  email: z.string(),
  status: z.enum(['pending', 'active', 'unsubscribed', 'bounced', 'complained']),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});
export type DailySubscriber = z.infer<typeof DailySubscriber>;
export const DailyAdminOverview = z.object({
  configured: z.boolean(),
  paused: z.boolean(),
  maxSubscribers: z.number(),
  today: z.string(),
  subscribers: z.array(DailySubscriber),
  /** 유형·난이도별 문제 수 */
  bank: z.array(DailyBankCell),
  /** 오늘 발송 현황 */
  delivery: z.object({ pending: z.number(), sent: z.number(), failed: z.number(), skipped: z.number() }),
});
export type DailyAdminOverview = z.infer<typeof DailyAdminOverview>;
export const DailyPauseInput = z.object({ paused: z.boolean() });
export const DailyTestInput = z.object({ emails: z.array(z.email().max(254)).min(1).max(5) });
export const DailySendResult = z.object({ outcome: z.string(), sent: z.number(), failed: z.number(), remaining: z.number() });
export type DailySendResult = z.infer<typeof DailySendResult>;
/** 받을 요일. 1(월)~5(금) */
export const DailySettingsInput = z.object({
  subscribed: z.boolean(),
  mail: z.boolean(),
  weekdays: z.array(z.number().int().min(1).max(5)).min(1).max(5),
});
export type DailySettingsInput = z.infer<typeof DailySettingsInput>;
export const DailySettings = DailySettingsInput.extend({
  /** 받는 주소. 로그인 계정의 이메일이며 따로 바꾸지 않는다 */
  email: z.string(),
  mailAvailable: z.boolean(),
  mailBlocked: z.boolean(),
  /** 임시 계정: 인박스로만 받고, 메일은 Google 계정으로 가입해야 받는다 */
  temporary: z.boolean(),
});
export type DailySettings = z.infer<typeof DailySettings>;
export const DailyInboxItem = z.object({
  date: z.string(),
  problemId: z.string(),
  topic: DailyTopic,
  level: z.number(),
  title: z.string(),
  /** 설명 앞부분(전체는 IDE에서 본다) */
  excerpt: z.string(),
  hint: z.string(),
  read: z.boolean(),
  /** 내 제출 결과: none(안 풀었음), tried(제출했지만 100점 아님), solved */
  progress: z.enum(['none', 'tried', 'solved']),
});
export type DailyInboxItem = z.infer<typeof DailyInboxItem>;
export const DailyInbox = z.object({ items: z.array(DailyInboxItem), unread: z.number() });
export type DailyInbox = z.infer<typeof DailyInbox>;

// ─── judge(채점 서비스) 계약: API(Worker) ↔ judge(pahidc) ───

/** API가 judge에 맡기는 실행. id는 API가 정한 제출 id. cases와 testsetHash 중 하나만 쓴다. */
export const JudgeJob = z.object({
  id: z.string().min(1).max(64),
  kind: SubmissionKind,
  language: Language,
  mode: ProblemMode,
  code: z.string().max(MAX_TEXT),
  cases: z.array(TestCase).max(60).nullable(),
  testsetHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  timeLimitMs: z.number().int().min(100).max(10_000),
});
export type JudgeJob = z.infer<typeof JudgeJob>;

/** judge가 아는 실행 상태. 끝나면 같은 모양으로 API에 결과를 보낸다(콜백). */
export const JudgeStatus = z.object({
  id: z.string(),
  status: SubmissionStatus,
  ahead: z.number().int().min(0).nullable(),
  caseIds: z.array(z.string()),
  result: RunResult.nullable(),
  score: z.number().int().min(0).max(100).nullable(),
  error: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type JudgeStatus = z.infer<typeof JudgeStatus>;

export const JUDGE_SIGNATURE_HEADER = 'x-judge-signature';
export const JUDGE_TIMESTAMP_HEADER = 'x-judge-timestamp';
/** 서명 시각 허용 오차(재전송 방지) */
const JUDGE_SKEW_MS = 5 * 60_000;

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** HMAC-SHA256(시각·메서드·경로·본문). WebCrypto라 Node와 Worker에서 똑같이 돈다. */
export async function judgeSignature(secret: string, timestamp: string, method: string, path: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`)));
}

/** 요청에 붙일 서명 헤더 */
export async function judgeHeaders(secret: string, method: string, path: string, body: string, now = Date.now()): Promise<Record<string, string>> {
  const ts = String(now);
  return { [JUDGE_TIMESTAMP_HEADER]: ts, [JUDGE_SIGNATURE_HEADER]: await judgeSignature(secret, ts, method, path, body) };
}

/**
 * 본문을 서명에 넣지 않는 요청(큰 히든 테스트셋). Worker는 CPU 한도(10ms) 때문에 수 MB 본문을 해시하지 않고 흘려보낸다.
 * 본문은 TLS가 지키고, 서명은 시각·메서드·경로를 묶는다. judge는 PUT /testsets에서만 받는다.
 */
export const JUDGE_PAYLOAD_HEADER = 'x-judge-payload';
const UNSIGNED_BODY = 'UNSIGNED-BODY';
export async function judgeStreamHeaders(secret: string, method: string, path: string, now = Date.now()): Promise<Record<string, string>> {
  return { ...(await judgeHeaders(secret, method, path, UNSIGNED_BODY, now)), [JUDGE_PAYLOAD_HEADER]: 'unsigned' };
}
/** 본문 없이 서명한 요청인지 검사한다 */
export function verifyJudgeUnsigned(secret: string, header: (name: string) => string | undefined, method: string, path: string, now = Date.now()): Promise<boolean> {
  return verifyJudge(secret, header, method, path, UNSIGNED_BODY, now);
}

/** 서명·시각 검사. 길이가 같은 문자열을 끝까지 비교한다(시간 차로 서명을 알아내지 못하게). */
export async function verifyJudge(secret: string, header: (name: string) => string | undefined, method: string, path: string, body: string, now = Date.now()): Promise<boolean> {
  const ts = header(JUDGE_TIMESTAMP_HEADER);
  const sig = header(JUDGE_SIGNATURE_HEADER);
  if (!ts || !sig || !/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > JUDGE_SKEW_MS) return false;
  const expected = await judgeSignature(secret, ts, method, path, body);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
