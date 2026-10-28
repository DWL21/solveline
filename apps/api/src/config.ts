import { z } from 'zod';

// 빈 문자열은 "미설정"으로 본다 (.env.example을 복사하면 빈 값이 남는다).
const optionalString = z
  .string()
  .optional()
  .transform((v) => v?.trim() || undefined);

const positiveNumber = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        ctx.addIssue({ code: 'custom', message: '양수여야 합니다.' });
        return z.NEVER;
      }
      return n;
    });

const EnvSchema = z.object({
  NODE_ENV: optionalString,
  PORT: positiveNumber(8787),
  DATA_DIR: optionalString,
  /** 채점 서비스(judge) 주소와, API·judge가 나눠 가진 서명 비밀(32자 이상) */
  JUDGE_URL: optionalString,
  JUDGE_SECRET: optionalString,
  SESSION_SECRET: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  /** 운영자 Google 이메일: 예전(비밀번호 시절) 데이터를 넘겨받고, 허용 목록에 항상 포함 */
  OWNER_EMAIL: optionalString,
  /** 관리자 페이지 비밀번호(예전 사이트 비밀번호). 없으면 관리자 페이지를 열 수 없다 */
  ACCESS_PASSWORD: optionalString,
  /** 약관·개인정보처리방침에 적는 문의 이메일(없으면 OWNER_EMAIL) */
  CONTACT_EMAIL: optionalString,
  SESSION_TTL_DAYS: positiveNumber(30),
  WEB_ORIGIN: optionalString,
  /** 자동화 테스트 전용 로그인 토큰(테스트 환경만). 운영(NODE_ENV=production)에서 설정하면 시작하지 않는다 */
  TEST_AUTH_TOKEN: optionalString,
  /** 공용 문제 데이터·히든 테스트셋을 게시할 Cloudflare R2. 넷 다 있어야 켜진다(없으면 SQLite·로컬 파일만 쓴다) */
  R2_ACCOUNT_ID: optionalString,
  R2_ACCESS_KEY_ID: optionalString,
  R2_SECRET_ACCESS_KEY: optionalString,
  R2_BUCKET: optionalString,
  /** R2 키 대신 Pages Worker의 R2 바인딩으로 게시할 때 Worker와 나눠 가진 비밀(32자 이상) */
  R2_PROXY_SECRET: optionalString,
});

export type Config = {
  port: number;
  dataDir: string;
  production: boolean;
  judgeUrl: string;
  /** judge와의 HMAC 서명 비밀. 개발 환경에서 없으면 프로세스마다 임의 값(judge도 같은 값을 받아야 한다) */
  judgeSecret: string;
  google: { clientId: string; clientSecret: string } | null;
  ownerEmail: string | null;
  adminPassword: string | null;
  contactEmail: string | null;
  sessionSecret: string;
  sessionTtlMs: number;
  webOrigin: string;
  /** 쿠키 Secure 속성. localhost 출처에서만 끈다. */
  secureCookie: boolean;
  /** 자동화 테스트 전용 로그인(POST /api/test/session). null이면 경로 자체가 없다 */
  testAuthToken: string | null;
  /** 카탈로그 게시 대상. null이면 게시하지 않는다 */
  r2: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string } | null;
  /** Worker를 거쳐 R2에 게시할 때의 공유 비밀. r2가 있으면 그쪽을 쓴다 */
  r2ProxySecret: string | null;
};

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // 값은 출력하지 않고 변수 이름과 사유만 알린다.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new ConfigError(`환경 변수 오류: ${issues}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const webOrigin = (e.WEB_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, '');

  checkSecrets(e, production);
  const host = hostOf(webOrigin);
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

  return {
    port: e.PORT,
    // 상대 경로는 main.ts가 절대 경로로 바꾼다(Worker에는 파일 시스템이 없다)
    dataDir: e.DATA_DIR ?? './data',
    production,
    judgeUrl: (e.JUDGE_URL ?? 'http://127.0.0.1:8790').replace(/\/$/, ''),
    judgeSecret: e.JUDGE_SECRET ?? cryptoRandom(),
    google: e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET ? { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET } : null,
    ownerEmail: e.OWNER_EMAIL?.toLowerCase() ?? null,
    adminPassword: e.ACCESS_PASSWORD ?? null,
    contactEmail: e.CONTACT_EMAIL ?? e.OWNER_EMAIL ?? null,
    // 개발 편의: 비밀이 없으면 프로세스마다 임의 값 (재시작하면 세션이 무효화된다)
    sessionSecret: e.SESSION_SECRET ?? cryptoRandom(),
    sessionTtlMs: e.SESSION_TTL_DAYS * 24 * 3_600_000,
    webOrigin,
    secureCookie: !isLocal,
    testAuthToken: production ? null : (e.TEST_AUTH_TOKEN ?? null),
    r2:
      e.R2_ACCOUNT_ID && e.R2_ACCESS_KEY_ID && e.R2_SECRET_ACCESS_KEY && e.R2_BUCKET
        ? { accountId: e.R2_ACCOUNT_ID, accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY, bucket: e.R2_BUCKET }
        : null,
    r2ProxySecret: e.R2_PROXY_SECRET ?? null,
  };
}

/** 비밀 값의 길이와 운영 환경 제약을 확인한다(값은 출력하지 않는다) */
function checkSecrets(e: z.infer<typeof EnvSchema>, production: boolean) {
  if (production && !e.SESSION_SECRET) throw new ConfigError('운영 환경에는 SESSION_SECRET이 필요합니다.');
  if (production && e.TEST_AUTH_TOKEN) throw new ConfigError('운영 환경에서는 TEST_AUTH_TOKEN을 쓸 수 없습니다.');
  if (e.TEST_AUTH_TOKEN && e.TEST_AUTH_TOKEN.length < 24) throw new ConfigError('TEST_AUTH_TOKEN은 24자 이상이어야 합니다.');
  if (e.ACCESS_PASSWORD && e.ACCESS_PASSWORD.length < 24) throw new ConfigError('ACCESS_PASSWORD는 24자 이상이어야 합니다.');
  if (e.SESSION_SECRET && e.SESSION_SECRET.length < 32) throw new ConfigError('SESSION_SECRET은 32자 이상이어야 합니다.');
  if (production && !e.JUDGE_SECRET) throw new ConfigError('운영 환경에는 JUDGE_SECRET이 필요합니다.');
  if (e.JUDGE_SECRET && e.JUDGE_SECRET.length < 32) throw new ConfigError('JUDGE_SECRET은 32자 이상이어야 합니다.');

  const r2Values = [e.R2_ACCOUNT_ID, e.R2_ACCESS_KEY_ID, e.R2_SECRET_ACCESS_KEY, e.R2_BUCKET];
  if (e.R2_PROXY_SECRET && e.R2_PROXY_SECRET.length < 32) throw new ConfigError('R2_PROXY_SECRET은 32자 이상이어야 합니다.');
  if (r2Values.some(Boolean) && !r2Values.every(Boolean)) throw new ConfigError('R2_ACCOUNT_ID·R2_ACCESS_KEY_ID·R2_SECRET_ACCESS_KEY·R2_BUCKET은 함께 설정해야 합니다.');
}

function hostOf(webOrigin: string) {
  try {
    return new URL(webOrigin).hostname;
  } catch {
    throw new ConfigError('WEB_ORIGIN 형식이 올바르지 않습니다.');
  }
}

function cryptoRandom() {
  return globalThis.crypto.getRandomValues(new Uint8Array(48)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}
