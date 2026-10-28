import type { Sql } from '../sql.ts';

/** 키(IP·사용자)별 고정 창 요청 제한. 허용되면 0, 막히면 다시 시도할 수 있을 때까지 남은 초 */
export interface Limiter {
  hit(key: string, now?: number): Promise<number>;
}

/** 이름이 다른 제한(로그인·관리자·실행)끼리 키가 섞이지 않게 만든다 */
export type LimiterFactory = (name: string, limit: number, windowMs: number) => Limiter;

const retryAfter = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 1000));

/** 단일 프로세스 메모리(pahidc api). */
export class RateLimiter implements Limiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  async hit(key: string, now = Date.now()): Promise<number> {
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    entry.count += 1;
    if (entry.count > this.limit) return retryAfter(entry.resetAt, now);
    return 0;
  }
}

export const memoryLimiters: LimiterFactory = (_name, limit, windowMs) => new RateLimiter(limit, windowMs);

/**
 * SQL 테이블(rate_limits)에 세는 제한. Worker는 요청마다 다른 격리 공간에서 돌 수 있어 메모리로는 셀 수 없다.
 * 한 문장(UPSERT … RETURNING)으로 세므로 동시에 와도 빠지지 않는다. 쓰기는 요청당 1행이다.
 */
export class SqlRateLimiter implements Limiter {
  constructor(
    private sql: Sql,
    private name: string,
    private limit: number,
    private windowMs: number,
  ) {}

  async hit(key: string, now = Date.now()): Promise<number> {
    const id = `${this.name}:${key}`;
    const row = await this.sql.get<{ count: number; reset_at: number }>(
      `INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
       RETURNING count, reset_at`,
      id, now + this.windowMs, now, now,
    );
    if (!row || row.count <= this.limit) return 0;
    return retryAfter(row.reset_at, now);
  }

  /** 창이 지난 행을 지운다(매일 정리) */
  static prune(sql: Sql, now = Date.now()) {
    return sql.run('DELETE FROM rate_limits WHERE reset_at <= ?', now);
  }
}

export const sqlLimiters =
  (sql: Sql): LimiterFactory =>
  (name, limit, windowMs) =>
    new SqlRateLimiter(sql, name, limit, windowMs);
