import type Database from 'better-sqlite3';

/**
 * 운영 SQLite를 D1에 넣을 SQL로 내보낸다(0007 5단계 전환 때 한 번). 스키마는 D1 마이그레이션이 만들고, 여기서는 행만 넣는다.
 * - 다시 실행해도 같도록 INSERT OR REPLACE를 쓴다.
 * - 외래 키 검사는 끝까지 미룬다(표 순서와 무관하게 넣는다).
 * - D1은 SQL 한 문장이 100KB를 넘으면 받지 않는다. 그런 행은 긴 글자 열을 비워 넣은 뒤 조각을 이어 붙인다(UPDATE … || …).
 */
export const D1_TABLES = ['users', 'folders', 'problems', 'collections', 'collection_items', 'user_problems', 'folder_items', 'bookmarks', 'legacy_state', 'submissions', 'sessions', 'signup_settings'];

/** 한 문장 최대 길이(D1 한도 100KB보다 넉넉히 작게) */
const MAX_STATEMENT = 90_000;
const CHUNK = 30_000;

const quote = (v: unknown): string => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (Buffer.isBuffer(v)) return `X'${v.toString('hex')}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};

/** 문자열을 UTF-8 바이트 기준이 아니라 글자 수로 자른다(따옴표 이스케이프 뒤에도 CHUNK 근처) */
const chunks = (s: string) => Array.from({ length: Math.ceil(s.length / CHUNK) }, (_, i) => s.slice(i * CHUNK, (i + 1) * CHUNK));

export function exportForD1(db: Database.Database): { sql: string; rows: Record<string, number> } {
  const out: string[] = ['PRAGMA defer_foreign_keys = on;'];
  const rows: Record<string, number> = {};
  for (const table of D1_TABLES) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
    const cols = info.map((c) => c.name);
    const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    const all = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    rows[table] = all.length;
    for (const r of all) {
      const insert = (values: unknown[]) => `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${values.map(quote).join(', ')});`;
      const full = insert(cols.map((c) => r[c]));
      if (full.length <= MAX_STATEMENT) {
        out.push(full);
        continue;
      }
      // 긴 글자 열은 비우고 넣은 뒤 조각을 이어 붙인다
      const long = cols.filter((c) => typeof r[c] === 'string' && (r[c] as string).length > CHUNK && !pk.includes(c));
      out.push(insert(cols.map((c) => (long.includes(c) ? '' : r[c]))));
      const where = pk.map((c) => `${c} = ${quote(r[c])}`).join(' AND ');
      for (const c of long) for (const part of chunks(r[c] as string)) out.push(`UPDATE ${table} SET ${c} = ${c} || ${quote(part)} WHERE ${where};`);
    }
  }
  return { sql: `${out.join('\n')}\n`, rows };
}
