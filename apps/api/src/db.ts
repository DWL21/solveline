import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Collection, Folder, Problem, type CollectionInput, type ProblemInput, type ProblemSummary } from '@codetest/shared';

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
  // 개인키 로그인 제거 (#9)
  `DROP TABLE IF EXISTS auth_nonces;`,
  // 폴더(문제마다 하나)·컬렉션(가상 묶음) (#11)
  `CREATE TABLE folders (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     position INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );
   ALTER TABLE problems ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
   CREATE INDEX problems_folder ON problems(folder_id);
   CREATE TABLE collections (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     description TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE collection_items (
     collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
     problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     PRIMARY KEY (collection_id, problem_id)
   );
   CREATE INDEX collection_items_problem ON collection_items(problem_id);`,
];

/** 이름 중복·없는 폴더처럼 요청을 고쳐야 하는 오류 */
export class StoreError extends Error {
  constructor(
    public code: 'duplicate_name' | 'folder_not_found' | 'problem_not_found',
    message: string,
  ) {
    super(message);
  }
}

const isUniqueViolation = (e: unknown) => e instanceof Error && 'code' in e && (e as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';

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

type Row = { id: string; title: string; folder_id: string | null; mode: string; language: string; body: string; created_at: string; updated_at: string };

/** 문제 저장소. 검색할 열만 따로 두고 나머지(설명·케이스·코드)는 JSON body에 둔다. */
export class ProblemStore {
  constructor(private db: Db) {}

  list(): ProblemSummary[] {
    const rows = this.db
      .prepare("SELECT id, title, folder_id, mode, language, json_extract(body, '$.lastSubmission') AS last_submission, updated_at FROM problems ORDER BY updated_at DESC")
      .all() as (Row & { last_submission: string | null })[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      folderId: r.folder_id,
      mode: r.mode as Problem['mode'],
      language: r.language as Problem['language'],
      lastSubmission: r.last_submission ? (JSON.parse(r.last_submission) as Problem['lastSubmission']) : null,
      updatedAt: r.updated_at,
    }));
  }

  get(id: string): Problem | null {
    const row = this.db.prepare('SELECT * FROM problems WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const body = JSON.parse(row.body) as Omit<ProblemInput, 'title' | 'folderId' | 'mode' | 'language'>;
    return Problem.parse({
      ...body,
      id: row.id,
      title: row.title,
      folderId: row.folder_id,
      mode: row.mode,
      language: row.language,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private checkFolder(folderId: string | null) {
    if (folderId && !this.db.prepare('SELECT 1 FROM folders WHERE id = ?').get(folderId)) throw new StoreError('folder_not_found', '없는 폴더입니다.');
  }

  create(input: ProblemInput, now = new Date()): Problem {
    this.checkFolder(input.folderId);
    const id = randomUUID();
    const ts = now.toISOString();
    this.db
      .prepare('INSERT INTO problems (id, title, folder_id, mode, language, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.title, input.folderId, input.mode, input.language, bodyOf(input), ts, ts);
    return this.get(id)!;
  }

  update(id: string, input: ProblemInput, now = new Date()): Problem | null {
    this.checkFolder(input.folderId);
    const r = this.db
      .prepare('UPDATE problems SET title = ?, folder_id = ?, mode = ?, language = ?, body = ?, updated_at = ? WHERE id = ?')
      .run(input.title, input.folderId, input.mode, input.language, bodyOf(input), now.toISOString(), id);
    return r.changes ? this.get(id) : null;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM problems WHERE id = ?').run(id).changes > 0;
  }
}

function bodyOf(p: ProblemInput) {
  return JSON.stringify({ description: p.description, params: p.params, cases: p.cases, code: p.code, lastSubmission: p.lastSubmission });
}

type FolderRow = { id: string; name: string; position: number; created_at: string };

export class FolderStore {
  constructor(private db: Db) {}

  private toFolder(r: FolderRow): Folder {
    return { id: r.id, name: r.name, position: r.position, createdAt: r.created_at };
  }

  list(): Folder[] {
    return (this.db.prepare('SELECT * FROM folders ORDER BY position, name').all() as FolderRow[]).map((r) => this.toFolder(r));
  }

  create(name: string, now = new Date()): Folder {
    const id = randomUUID();
    const position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 FROM folders').pluck().get() as number) ?? 0;
    try {
      this.db.prepare('INSERT INTO folders (id, name, position, created_at) VALUES (?, ?, ?, ?)').run(id, name, position, now.toISOString());
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoreError('duplicate_name', '같은 이름의 폴더가 있습니다.');
      throw e;
    }
    return this.toFolder(this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow);
  }

  rename(id: string, name: string): Folder | null {
    try {
      if (!this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, id).changes) return null;
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoreError('duplicate_name', '같은 이름의 폴더가 있습니다.');
      throw e;
    }
    return this.toFolder(this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow);
  }

  /** 폴더를 지워도 문제는 남는다(폴더 없음). */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM folders WHERE id = ?').run(id).changes > 0;
  }
}

type CollectionRow = { id: string; name: string; description: string; created_at: string; updated_at: string };

/** 컬렉션: 문제를 옮기지 않는 가상 묶음. 한 문제가 여러 컬렉션에 들어갈 수 있다. */
export class CollectionStore {
  constructor(private db: Db) {}

  private toCollection(r: CollectionRow): Collection {
    const problemIds = this.db.prepare('SELECT problem_id FROM collection_items WHERE collection_id = ? ORDER BY position').pluck().all(r.id) as string[];
    return Collection.parse({ id: r.id, name: r.name, description: r.description, problemIds, createdAt: r.created_at, updatedAt: r.updated_at });
  }

  list(): Collection[] {
    return (this.db.prepare('SELECT * FROM collections ORDER BY created_at, name').all() as CollectionRow[]).map((r) => this.toCollection(r));
  }

  get(id: string): Collection | null {
    const r = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow | undefined;
    return r ? this.toCollection(r) : null;
  }

  create(input: CollectionInput, now = new Date()): Collection {
    const id = randomUUID();
    const ts = now.toISOString();
    try {
      this.db.prepare('INSERT INTO collections (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, input.name, input.description, ts, ts);
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoreError('duplicate_name', '같은 이름의 컬렉션이 있습니다.');
      throw e;
    }
    return this.get(id)!;
  }

  update(id: string, input: CollectionInput, now = new Date()): Collection | null {
    try {
      const r = this.db
        .prepare('UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?')
        .run(input.name, input.description, now.toISOString(), id);
      if (!r.changes) return null;
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoreError('duplicate_name', '같은 이름의 컬렉션이 있습니다.');
      throw e;
    }
    return this.get(id);
  }

  /** 컬렉션의 문제 목록을 통째로 바꾼다(순서 포함). 중복 id는 처음 것만 남긴다. */
  setItems(id: string, problemIds: string[], now = new Date()): Collection | null {
    if (!this.db.prepare('SELECT 1 FROM collections WHERE id = ?').get(id)) return null;
    const unique = [...new Set(problemIds)];
    const exists = this.db.prepare('SELECT 1 FROM problems WHERE id = ?');
    for (const pid of unique) if (!exists.get(pid)) throw new StoreError('problem_not_found', `없는 문제입니다: ${pid}`);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(id);
      const ins = this.db.prepare('INSERT INTO collection_items (collection_id, problem_id, position) VALUES (?, ?, ?)');
      unique.forEach((pid, i) => ins.run(id, pid, i));
      this.db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(now.toISOString(), id);
    })();
    return this.get(id);
  }

  /** 컬렉션을 지워도 문제는 남는다. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM collections WHERE id = ?').run(id).changes > 0;
  }
}
