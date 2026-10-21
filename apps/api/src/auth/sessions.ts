import { randomBytes } from 'node:crypto';
import type { Db } from '../db.ts';

/** 서버 측 세션 저장소. 쿠키에는 서명된 세션 ID만 담고, 로그아웃 시 행을 지워 무효화한다. */
export class SessionStore {
  constructor(
    private db: Db,
    private ttlMs: number,
  ) {}

  create(now = Date.now()) {
    const id = randomBytes(32).toString('base64url');
    const expiresAt = now + this.ttlMs;
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    this.db.prepare('INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)').run(id, expiresAt, new Date(now).toISOString());
    return { id, expiresAt };
  }

  /** 유효하면 만료 시각(ms), 아니면 null */
  validate(id: string, now = Date.now()): number | null {
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE id = ?').get(id) as { expires_at: number } | undefined;
    if (!row) return null;
    if (row.expires_at < now) {
      this.revoke(id);
      return null;
    }
    return row.expires_at;
  }

  revoke(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}
