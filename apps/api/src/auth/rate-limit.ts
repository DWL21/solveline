/** 키(IP)별 고정 창 요청 제한. 단일 프로세스 메모리. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** 허용되면 0, 막히면 다시 시도할 수 있을 때까지 남은 초 */
  hit(key: string, now = Date.now()): number {
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    entry.count += 1;
    if (entry.count > this.limit) return Math.ceil((entry.resetAt - now) / 1000);
    return 0;
  }
}
