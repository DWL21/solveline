import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Problem, type ProblemInput, type ProblemSummary } from '@codetest/shared';

export type Db = Database.Database;

// 순서대로 한 번씩만 적용되는 마이그레이션
const migrations: string[] = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE auth_nonces (
     nonce TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL
   );
   CREATE TABLE problems (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     mode TEXT NOT NULL CHECK (mode IN ('function','stdin')),
     language TEXT NOT NULL CHECK (language IN ('java','python')),
     body TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX problems_updated ON problems(updated_at);`,
];

/** dataDir가 ':memory:'면 메모리 DB (테스트용) */
export function openDb(dataDir: string): Db {
  let db: Db;
  if (dataDir === ':memory:') db = new Database(':memory:');
  else {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, 'codetest.db'));
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY)');
  const applied = new Set(db.prepare('SELECT id FROM _migrations').pluck().all() as number[]);
  migrations.forEach((sql, i) => {
    if (applied.has(i)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(i);
    })();
  });
  return db;
}

type Row = { id: string; title: string; mode: string; language: string; body: string; created_at: string; updated_at: string };

/** 문제 저장소. 검색할 열만 따로 두고 나머지(설명·케이스·코드)는 JSON body에 둔다. */
export class ProblemStore {
  constructor(private db: Db) {}

  list(): ProblemSummary[] {
    const rows = this.db.prepare('SELECT id, title, mode, language, updated_at FROM problems ORDER BY updated_at DESC').all() as Row[];
    return rows.map((r) => ({ id: r.id, title: r.title, mode: r.mode as Problem['mode'], language: r.language as Problem['language'], updatedAt: r.updated_at }));
  }

  get(id: string): Problem | null {
    const row = this.db.prepare('SELECT * FROM problems WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const body = JSON.parse(row.body) as Omit<ProblemInput, 'title' | 'mode' | 'language'>;
    return Problem.parse({ ...body, id: row.id, title: row.title, mode: row.mode, language: row.language, createdAt: row.created_at, updatedAt: row.updated_at });
  }

  create(input: ProblemInput, now = new Date()): Problem {
    const id = randomUUID();
    const ts = now.toISOString();
    this.db
      .prepare('INSERT INTO problems (id, title, mode, language, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.title, input.mode, input.language, bodyOf(input), ts, ts);
    return this.get(id)!;
  }

  update(id: string, input: ProblemInput, now = new Date()): Problem | null {
    const r = this.db
      .prepare('UPDATE problems SET title = ?, mode = ?, language = ?, body = ?, updated_at = ? WHERE id = ?')
      .run(input.title, input.mode, input.language, bodyOf(input), now.toISOString(), id);
    return r.changes ? this.get(id) : null;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM problems WHERE id = ?').run(id).changes > 0;
  }
}

function bodyOf(p: ProblemInput) {
  return JSON.stringify({ description: p.description, params: p.params, cases: p.cases, code: p.code });
}
