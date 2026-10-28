import { randomBytes } from 'node:crypto';
import { stmt, type Sql } from '../sql.ts';

/** 서버 측 세션 저장소. 쿠키에는 서명된 세션 ID만 담고, 로그아웃·탈퇴 시 행을 지워 무효화한다. */
export class SessionStore {
  constructor(
    private readonly sql: Sql,
    private readonly ttlMs: number,
  ) {}

  async create(userId: string, now = Date.now()) {
    const id = randomBytes(32).toString('base64url');
    const expiresAt = now + this.ttlMs;
    await this.sql.batch([
      stmt('DELETE FROM sessions WHERE expires_at < ?', now),
      stmt('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', id, userId, expiresAt, new Date(now).toISOString()),
    ]);
    return { id, expiresAt };
  }

  /** 유효하면 { expiresAt, userId }, 아니면 null. 사용자가 없는(예전) 세션은 무효. */
  async validate(id: string, now = Date.now()): Promise<{ expiresAt: number; userId: string } | null> {
    const row = await this.sql.get<{ expires_at: number; user_id: string | null }>('SELECT expires_at, user_id FROM sessions WHERE id = ?', id);
    if (!row) return null;
    if (row.expires_at < now || !row.user_id) {
      await this.revoke(id);
      return null;
    }
    return { expiresAt: row.expires_at, userId: row.user_id };
  }

  async revoke(id: string) {
    await this.sql.run('DELETE FROM sessions WHERE id = ?', id);
  }
}
