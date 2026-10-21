import { randomBytes } from 'node:crypto';
import type { Db } from '../db.ts';

export const NONCE_TTL_MS = 60_000;
const MAX_PENDING = 1000;

export type ConsumeResult = 'ok' | 'expired' | 'unknown';

/** 로그인 nonce: 60초 유효, 1회용. 메모리 대신 SQLite에 둔다(컨테이너 메모리 상한 256MB). */
export class NonceStore {
  constructor(private db: Db) {}

  issue(now = Date.now()) {
    this.db.prepare('DELETE FROM auth_nonces WHERE expires_at < ?').run(now);
    // 남용 방지: 대기 중인 nonce가 너무 많으면 오래된 것부터 버린다.
    this.db
      .prepare('DELETE FROM auth_nonces WHERE nonce IN (SELECT nonce FROM auth_nonces ORDER BY expires_at DESC LIMIT -1 OFFSET ?)')
      .run(MAX_PENDING - 1);
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = now + NONCE_TTL_MS;
    this.db.prepare('INSERT INTO auth_nonces (nonce, expires_at) VALUES (?, ?)').run(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  /** 꺼내는 즉시 삭제한다(재사용 불가). */
  consume(nonce: string, now = Date.now()): ConsumeResult {
    const row = this.db.prepare('DELETE FROM auth_nonces WHERE nonce = ? RETURNING expires_at').get(nonce) as { expires_at: number } | undefined;
    if (!row) return 'unknown';
    return now > row.expires_at ? 'expired' : 'ok';
  }
}
