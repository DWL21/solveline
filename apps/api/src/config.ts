import { resolve } from 'node:path';
import { z } from 'zod';

// 빈 문자열은 "미설정"으로 본다 (.env.example을 복사하면 빈 값이 남는다).
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

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
  RUNNER_URL: optionalString,
  /** 쉼표로 구분한 runner 주소들. 있으면 RUNNER_URL보다 우선 */
  RUNNER_URLS: optionalString,
  RUNNER_SLOTS: positiveNumber(2),
  ACCESS_PASSWORD: optionalString,
  SESSION_SECRET: optionalString,
  SESSION_TTL_DAYS: positiveNumber(30),
  WEB_ORIGIN: optionalString,
});

export type Config = {
  port: number;
  dataDir: string;
  production: boolean;
  runnerUrls: string[];
  /** runner 한 대에 동시에 보내는 제출 수(runner의 RUN_SLOTS와 맞춘다) */
  runnerSlots: number;
  /** 로그인 비밀번호. 없으면 로그인할 수 없다. */
  accessPassword: string | null;
  sessionSecret: string;
  sessionTtlMs: number;
  webOrigin: string;
  /** 쿠키 Secure 속성. localhost 출처에서만 끈다. */
  secureCookie: boolean;
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

  if (production && !e.SESSION_SECRET) throw new ConfigError('운영 환경에는 SESSION_SECRET이 필요합니다.');
  if (e.SESSION_SECRET && e.SESSION_SECRET.length < 32) throw new ConfigError('SESSION_SECRET은 32자 이상이어야 합니다.');
  if (production && !e.ACCESS_PASSWORD) throw new ConfigError('운영 환경에는 ACCESS_PASSWORD가 필요합니다.');
  if (e.ACCESS_PASSWORD && e.ACCESS_PASSWORD.length < 24) throw new ConfigError('ACCESS_PASSWORD는 24자 이상이어야 합니다.');

  let host = '';
  try {
    host = new URL(webOrigin).hostname;
  } catch {
    throw new ConfigError('WEB_ORIGIN 형식이 올바르지 않습니다.');
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

  return {
    port: e.PORT,
    dataDir: resolve(e.DATA_DIR ?? './data'),
    production,
    runnerUrls: (e.RUNNER_URLS ?? e.RUNNER_URL ?? 'http://127.0.0.1:8000')
      .split(',')
      .map((u) => u.trim().replace(/\/$/, ''))
      .filter(Boolean),
    runnerSlots: Math.floor(e.RUNNER_SLOTS),
    accessPassword: e.ACCESS_PASSWORD ?? null,
    // 개발 편의: 비밀이 없으면 프로세스마다 임의 값 (재시작하면 세션이 무효화된다)
    sessionSecret: e.SESSION_SECRET ?? cryptoRandom(),
    sessionTtlMs: e.SESSION_TTL_DAYS * 24 * 3600_000,
    webOrigin,
    secureCookie: !isLocal,
  };
}

function cryptoRandom() {
  return globalThis.crypto.getRandomValues(new Uint8Array(48)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}
