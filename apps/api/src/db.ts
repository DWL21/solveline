import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  Collection,
  EMPTY_TIMER,
  Folder,
  Problem,
  type AdminUser,
  type AdminUserDetail,
  type CodeSet,
  type CollectionInput,
  type Language,
  type LastSubmission,
  type ProblemInput,
  type ProblemPatch,
  type ProblemSummary,
  type ProblemMode,
  type ProblemTimer,
  type TestCase,
  templateFor,
  type TestsetRef,
} from '@solveline/shared';
import type { TestsetStore } from './testsets.ts';

export type Db = Database.Database;

/** 순서대로 한 번씩만 적용되는 마이그레이션. fkOff: 참조되는 테이블을 다시 만들 때 외래 키 검사를 잠시 끈다. */
type Migration = string | { sql: string; fkOff: true } | ((db: Db) => void);
const migrations: Migration[] = [
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
  // 제출 큐 (#15)
  `CREATE TABLE submissions (
     id TEXT PRIMARY KEY,
     problem_id TEXT REFERENCES problems(id) ON DELETE SET NULL,
     kind TEXT NOT NULL CHECK (kind IN ('run','submit')),
     language TEXT NOT NULL,
     mode TEXT NOT NULL,
     code TEXT NOT NULL,
     cases TEXT,
     testset_hash TEXT,
     case_ids TEXT NOT NULL,
     priority INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
     result TEXT,
     score INTEGER,
     error TEXT,
     created_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT
   );
   CREATE INDEX submissions_queue ON submissions(status, priority, created_at);`,
  // 문제별 시간 제한 (#19)
  `ALTER TABLE submissions ADD COLUMN time_limit_ms INTEGER NOT NULL DEFAULT 10000;`,
  // 실행 중지 (#21): status CHECK에 cancelled 추가 → 테이블을 다시 만든다
  `CREATE TABLE submissions_new (
     id TEXT PRIMARY KEY,
     problem_id TEXT REFERENCES problems(id) ON DELETE SET NULL,
     kind TEXT NOT NULL CHECK (kind IN ('run','submit')),
     language TEXT NOT NULL,
     mode TEXT NOT NULL,
     code TEXT NOT NULL,
     cases TEXT,
     testset_hash TEXT,
     case_ids TEXT NOT NULL,
     priority INTEGER NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('queued','running','done','error','cancelled')),
     result TEXT,
     score INTEGER,
     error TEXT,
     created_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT,
     time_limit_ms INTEGER NOT NULL DEFAULT 10000
   );
   INSERT INTO submissions_new (id, problem_id, kind, language, mode, code, cases, testset_hash, case_ids, priority, status, result, score, error, created_at, started_at, finished_at, time_limit_ms)
     SELECT id, problem_id, kind, language, mode, code, cases, testset_hash, case_ids, priority, status, result, score, error, created_at, started_at, finished_at, time_limit_ms FROM submissions;
   DROP TABLE submissions;
   ALTER TABLE submissions_new RENAME TO submissions;
   CREATE INDEX submissions_queue ON submissions(status, priority, created_at);`,
  // Google 로그인 (#39): 문제·폴더·채점 케이스는 공용(편집 권한자만 수정), 작성 코드·내 테스트 케이스·메모·풀이 시간·제출·컬렉션은 사용자별.
  {
    fkOff: true,
    sql: `CREATE TABLE users (
       id TEXT PRIMARY KEY,
       google_sub TEXT NOT NULL UNIQUE,
       email TEXT NOT NULL,
       name TEXT NOT NULL DEFAULT '',
       picture TEXT NOT NULL DEFAULT '',
       role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','editor')),
       terms_version TEXT NOT NULL,
       privacy_version TEXT NOT NULL,
       agreed_at TEXT NOT NULL,
       created_at TEXT NOT NULL,
       last_login_at TEXT NOT NULL
     );
     CREATE INDEX users_email ON users(email);
     CREATE TABLE blocked_emails (
       email TEXT PRIMARY KEY,
       reason TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL
     );
     DELETE FROM sessions;
     ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
     ALTER TABLE submissions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
     CREATE INDEX submissions_user ON submissions(user_id, created_at);
     CREATE TABLE user_problems (
       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
       language TEXT,
       code TEXT,
       my_cases TEXT,
       memo TEXT,
       timer TEXT,
       last_submission TEXT,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (user_id, problem_id)
     );
     CREATE INDEX user_problems_problem ON user_problems(problem_id);
     -- 비밀번호 로그인 시절의 작성 코드·풀이 시간·채점 결과. 운영자가 처음 로그인할 때 넘겨받는다.
     CREATE TABLE legacy_state (
       problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE,
       language TEXT,
       code TEXT,
       timer TEXT,
       last_submission TEXT
     );
     INSERT INTO legacy_state (problem_id, language, code, timer, last_submission)
       SELECT id, language, json_extract(body, '$.code'), json_extract(body, '$.timer'), json_extract(body, '$.lastSubmission') FROM problems;
     UPDATE problems SET body = json_remove(body, '$.timer', '$.lastSubmission');
     CREATE TABLE collections_new (
       id TEXT PRIMARY KEY,
       user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       UNIQUE (user_id, name)
     );
     INSERT INTO collections_new (id, user_id, name, description, created_at, updated_at) SELECT id, NULL, name, description, created_at, updated_at FROM collections;
     DROP TABLE collections;
     ALTER TABLE collections_new RENAME TO collections;`,
  },
  // 공용 문제의 시작 코드: 예전 body.code는 운영자가 작성하던 코드(legacy_state로 옮김)이므로 기본 틀로 되돌린다.
  // 문제별 시그니처는 마스터가 PUT /api/admin/problems/:id/starter 로 다시 넣는다.
  (db) => {
    const rows = db.prepare('SELECT id, mode, body FROM problems').all() as { id: string; mode: ProblemMode; body: string }[];
    const upd = db.prepare('UPDATE problems SET body = ? WHERE id = ?');
    for (const r of rows) {
      const b = JSON.parse(r.body) as { params?: string[] };
      const params = b.params?.length ? b.params : undefined;
      upd.run(JSON.stringify({ ...b, code: { java: templateFor('java', r.mode, params), python: templateFor('python', r.mode, params) } }), r.id);
    }
  },
  // #49: 이메일별 차단을 없애고 신규 가입 전체 허용 여부를 영속적으로 관리한다.
  `CREATE TABLE signup_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
   );
   INSERT INTO signup_settings (id, enabled) VALUES (1, 1);
   DROP TABLE blocked_emails;`,
  // #79: 폴더는 사용자별, 컬렉션은 공용으로 역할을 바꾼다.
  // 기존 공용 폴더(user_id NULL)는 새 사용자에게 복사하는 틀로 남기고, problems.folder_id는 틀의 배치로 쓴다.
  // 사용자별 배치는 folder_items(사용자·문제마다 폴더 하나).
  {
    fkOff: true,
    sql: `CREATE TABLE folders_new (
       id TEXT PRIMARY KEY,
       user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       position INTEGER NOT NULL,
       created_at TEXT NOT NULL,
       UNIQUE (user_id, name)
     );
     INSERT INTO folders_new (id, user_id, name, position, created_at) SELECT id, NULL, name, position, created_at FROM folders;
     DROP TABLE folders;
     ALTER TABLE folders_new RENAME TO folders;
     CREATE INDEX folders_user ON folders(user_id, position);
     CREATE TABLE folder_items (
       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
       folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
       PRIMARY KEY (user_id, problem_id)
     );
     CREATE INDEX folder_items_folder ON folder_items(folder_id);
     UPDATE collections SET user_id = NULL;`,
  },
  // 기존 사용자에게 틀 폴더를 복사한다
  (db) => {
    for (const id of db.prepare('SELECT id FROM users').pluck().all() as string[]) copyTemplateFolders(db, id);
  },
  // 기존 문제와 폴더, 컬렉션의 표시를 정리한다.
  (db) => stripSourceMentions(db),
  `CREATE TABLE bookmarks (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
     PRIMARY KEY (user_id, problem_id)
   );`,
];

/** 기존 데이터 언급을 지운다. 마이그레이션에서 한 번 쓴다. */
export function stripSourceMentions(db: Db) {
  const sourceLine = /^\ubc31\uc900 \d+번 · .*$/;
  const originLine = /^원문:\s*https?:\/\/(www\.)?\u0061\u0063\u006d\u0069\u0063\u0070\u0063\.net\/\S*\s*$/;
  const figure = /\[그림(?: · [^:\]\n]*)?: https?:\/\/[^\]\s]*\u0061\u0063\u006d\u0069\u0063\u0070\u0063\.net[^\]\s]*\]/g;
  const updProblem = db.prepare('UPDATE problems SET title = ?, body = ? WHERE id = ?');
  for (const p of db.prepare('SELECT id, title, body FROM problems').all() as { id: string; title: string; body: string }[]) {
    const title = p.title.replace(/^\[\ubc31\uc900 (\d+)\]\s*/, '$1. ');
    const body = JSON.parse(p.body) as { description?: string };
    const description = (body.description ?? '')
      .split('\n')
      .filter((l) => !sourceLine.test(l) && !originLine.test(l))
      .join('\n')
      .replaceAll(figure, '[그림]')
      // 지문 속 괄호 링크 "(https://www.기존.net/problem/…)"와 남은 원문 주소
      .replaceAll(/\s*\(https?:\/\/[^)\s]*\u0061\u0063\u006d\u0069\u0063\u0070\u0063\.net[^)\s]*\)/g, '')
      .replaceAll(/https?:\/\/[^\s)\]]*\u0061\u0063\u006d\u0069\u0063\u0070\u0063\.net[^\s)\]]*/g, '')
      .replace(/^\n+/, '');
    if (title !== p.title || description !== (body.description ?? '')) updProblem.run(title, JSON.stringify({ ...body, description }), p.id);
  }

  const updCollection = db.prepare('UPDATE collections SET description = ? WHERE id = ?');
  for (const c of db.prepare('SELECT id, description FROM collections').all() as { id: string; description: string }[]) {
    const description = c.description.replaceAll(/\s*\(\ubc31\uc900 [^)]*\)/g, '').replaceAll(/\(\ud504\ub85c\uadf8\ub798\uba38\uc2a4\s*/g, '(').replaceAll(/\ud504\ub85c\uadf8\ub798\uba38\uc2a4\s*/g, '');
    if (description !== c.description) updCollection.run(description, c.id);
  }

  mergeSourceFolders(db);
}

/** 같은 사용자에게 동일한 폴더가 있으면 합친다. */
function mergeSourceFolders(db: Db) {
  const folders = db.prepare("SELECT id, user_id, name FROM folders WHERE name LIKE '\ubc31\uc900%'").all() as { id: string; user_id: string | null; name: string }[];
  for (const f of folders) {
    const name = f.name.replace(/^\ubc31\uc900\s*·\s*/, '');
    if (name === f.name || !name) continue;
    const same = (
      f.user_id === null
        ? db.prepare('SELECT id FROM folders WHERE user_id IS NULL AND name = ? AND id != ?').pluck().get(name, f.id)
        : db.prepare('SELECT id FROM folders WHERE user_id = ? AND name = ? AND id != ?').pluck().get(f.user_id, name, f.id)
    ) as string | undefined;
    if (!same) {
      db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, f.id);
      continue;
    }
    if (f.user_id === null) db.prepare('UPDATE problems SET folder_id = ? WHERE folder_id = ?').run(same, f.id);
    else db.prepare('UPDATE folder_items SET folder_id = ? WHERE folder_id = ?').run(same, f.id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(f.id);
  }
}

/** 틀 폴더(user_id NULL)와 그 배치를 이 사용자의 개인 폴더로 복사한다. 가입할 때와 마이그레이션에서 쓴다. */
export function copyTemplateFolders(db: Db, userId: string, now = new Date()) {
  const templates = db.prepare('SELECT id, name, position FROM folders WHERE user_id IS NULL ORDER BY position').all() as { id: string; name: string; position: number }[];
  const insFolder = db.prepare('INSERT OR IGNORE INTO folders (id, user_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)');
  const insItems = db.prepare('INSERT OR IGNORE INTO folder_items (user_id, problem_id, folder_id) SELECT ?, id, ? FROM problems WHERE folder_id = ?');
  for (const t of templates) {
    const id = randomUUID();
    if (insFolder.run(id, userId, t.name, t.position, now.toISOString()).changes) insItems.run(userId, id, t.id);
  }
}

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

/** 마이그레이션 하나를 적용하고 _migrations에 기록한다 */
function applyMigration(db: Db, m: Migration, i: number) {
  if (typeof m === 'function') {
    db.transaction(() => {
      m(db);
      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(i);
    })();
    return;
  }
  const sql = typeof m === 'string' ? m : m.sql;
  const fkOff = typeof m !== 'string';
  if (fkOff) db.pragma('foreign_keys = OFF'); // 트랜잭션 안에서는 바꿀 수 없으므로 밖에서 끈다
  try {
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(i);
      if (fkOff) {
        const broken = db.pragma('foreign_key_check') as unknown[];
        if (broken.length) throw new Error(`마이그레이션 ${i} 뒤 외래 키 위반 ${broken.length}건`);
      }
    })();
  } finally {
    if (fkOff) db.pragma('foreign_keys = ON');
  }
}

/** dataDir가 ':memory:'면 메모리 DB (테스트용) */
export function openDb(dataDir: string): Db {
  let db: Db;
  if (dataDir === ':memory:') db = new Database(':memory:');
  else {
    mkdirSync(dataDir, { recursive: true });
    // 예전 이름(codetest.db)이면 한 번 옮긴다(WAL·SHM 파일 포함, DB를 열기 전에)
    const file = join(dataDir, 'solveline.db');
    const legacy = join(dataDir, 'codetest.db');
    if (!existsSync(file) && existsSync(legacy))
      for (const ext of ['', '-wal', '-shm']) if (existsSync(legacy + ext)) renameSync(legacy + ext, file + ext);
    db = new Database(file);
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY)');
  const applied = new Set(db.prepare('SELECT id FROM _migrations').pluck().all() as number[]);
  for (const [i, m] of migrations.entries()) if (!applied.has(i)) applyMigration(db, m, i);
  return db;
}

type Row = {
  id: string;
  title: string;
  folder_id: string | null;
  mode: string;
  language: string;
  body: string;
  created_at: string;
  updated_at: string;
};

/** 공용 문제 내용. code는 시작 코드다. */
type Body = {
  description: string;
  params: string[];
  timeLimitMs: number;
  /** 보이는 케이스만 */
  cases: TestCase[];
  code: CodeSet;
  hiddenTestset: TestsetRef | null;
};

/** 사용자별 풀이 상태 */
type StateRow = { language: string | null; code: string | null; my_cases: string | null; memo: string | null; timer: string | null; last_submission: string | null; updated_at: string };

const parse = <T>(v: string | null | undefined): T | null => (v ? (JSON.parse(v) as T) : null);

/**
 * 문제 저장소. 문제 내용은 모두가 같이 보는 공용이고(관리자만 바꾼다), 작성 코드·언어·풀이 시간·마지막 제출은 user_problems에 사용자별로 둔다.
 * 히든 케이스는 body가 아니라 TestsetStore(해시 파일)에 두고 body에는 해시·개수만 남긴다.
 */
export class ProblemStore {
  constructor(
    private readonly db: Db,
    private readonly testsets: TestsetStore,
  ) {}

  /** userId가 null이면 비회원: 풀이 상태 없이 문제만(폴더는 틀 배치) */
  list(userId: string | null): ProblemSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, CASE WHEN @uid IS NULL THEN p.folder_id ELSE f.folder_id END AS folder_id, p.mode, p.language, p.updated_at,
                s.language AS my_language, s.timer, s.last_submission, b.problem_id AS bookmark_id
         FROM problems p
         LEFT JOIN user_problems s ON s.problem_id = p.id AND s.user_id = @uid
         LEFT JOIN bookmarks b ON b.problem_id = p.id AND b.user_id = @uid
         LEFT JOIN folder_items f ON f.problem_id = p.id AND f.user_id = @uid
         ORDER BY p.title`,
      )
      .all({ uid: userId }) as (Row & { my_language: string | null; timer: string | null; last_submission: string | null; bookmark_id: string | null })[];
    return rows.map((r) => ({
      id: r.id,
      bookmarked: r.bookmark_id !== null,
      title: r.title,
      folderId: r.folder_id,
      mode: r.mode as Problem['mode'],
      language: (r.my_language ?? r.language) as Language,
      lastSubmission: parse<LastSubmission>(r.last_submission),
      timer: parse<ProblemTimer>(r.timer) ?? EMPTY_TIMER,
      updatedAt: r.updated_at,
    }));
  }

  setBookmark(id: string, userId: string, bookmarked: boolean) {
    if (!this.exists(id)) return false;
    if (bookmarked) this.db.prepare('INSERT OR IGNORE INTO bookmarks (user_id, problem_id) VALUES (?, ?)').run(userId, id);
    else this.db.prepare('DELETE FROM bookmarks WHERE user_id = ? AND problem_id = ?').run(userId, id);
    return true;
  }

  private row(id: string) {
    return this.db.prepare('SELECT * FROM problems WHERE id = ?').get(id) as Row | undefined;
  }

  exists(id: string) {
    return !!this.row(id);
  }

  private body(row: Row): Body {
    const b = JSON.parse(row.body) as Partial<Body>;
    return {
      description: b.description ?? '',
      params: b.params ?? [],
      timeLimitMs: b.timeLimitMs ?? 10_000,
      cases: b.cases ?? [],
      code: b.code ?? { java: '', python: '' },
      hiddenTestset: b.hiddenTestset ?? null,
    };
  }

  private state(id: string, userId: string | null) {
    if (!userId) return undefined;
    return this.db.prepare('SELECT language, code, my_cases, memo, timer, last_submission, updated_at FROM user_problems WHERE user_id = ? AND problem_id = ?').get(userId, id) as
      | StateRow
      | undefined;
  }

  /** 사용자 상태의 일부를 바꾼다(없으면 만든다) */
  private upsertState(id: string, userId: string, patch: { language?: string; code?: string; my_cases?: string; memo?: string; timer?: string; last_submission?: string }, now = new Date()) {
    const cols = Object.keys(patch) as (keyof typeof patch)[];
    const updates = cols.map((c) => `${c} = excluded.${c}`).join(', ');
    this.db
      .prepare(
        `INSERT INTO user_problems (user_id, problem_id, ${cols.join(', ')}, updated_at) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)
         ON CONFLICT (user_id, problem_id) DO UPDATE SET ${updates}, updated_at = excluded.updated_at`,
      )
      .run(userId, id, ...cols.map((c) => patch[c]!), now.toISOString());
  }

  get(id: string, userId: string | null): Problem | null {
    const row = this.row(id);
    if (!row) return null;
    const b = this.body(row);
    const st = this.state(id, userId);
    return Problem.parse({
      description: b.description,
      params: b.params,
      timeLimitMs: b.timeLimitMs,
      cases: b.cases,
      hiddenTestset: b.hiddenTestset,
      starterCode: b.code,
      code: parse<CodeSet>(st?.code) ?? b.code,
      myCases: parse<TestCase[]>(st?.my_cases) ?? [],
      memo: st?.memo ?? '',
      language: st?.language ?? row.language,
      timer: parse<ProblemTimer>(st?.timer) ?? EMPTY_TIMER,
      lastSubmission: parse<LastSubmission>(st?.last_submission),
      id: row.id,
      title: row.title,
      folderId: this.folderOf(id, userId) ?? (userId ? null : row.folder_id),
      mode: row.mode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  /** 이 사용자가 문제를 넣어 둔 개인 폴더 */
  private folderOf(id: string, userId: string | null): string | null {
    if (!userId) return null;
    return (this.db.prepare('SELECT folder_id FROM folder_items WHERE user_id = ? AND problem_id = ?').pluck().get(userId, id) as string | undefined) ?? null;
  }

  /** 문제를 이 사용자의 개인 폴더에 넣는다(null이면 폴더 없음). 남의 폴더에는 넣을 수 없다. */
  private setFolder(id: string, userId: string, folderId: string | null) {
    if (!folderId) {
      this.db.prepare('DELETE FROM folder_items WHERE user_id = ? AND problem_id = ?').run(userId, id);
      return;
    }
    if (!this.db.prepare('SELECT 1 FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId)) throw new StoreError('folder_not_found', '없는 폴더입니다.');
    this.db
      .prepare('INSERT INTO folder_items (user_id, problem_id, folder_id) VALUES (?, ?, ?) ON CONFLICT (user_id, problem_id) DO UPDATE SET folder_id = excluded.folder_id')
      .run(userId, id, folderId);
  }

  /** 입력의 hidden 케이스는 테스트셋으로 옮기고, 없으면 기존 테스트셋을 유지한다. 시작 코드는 starterCode가 있을 때만 바꾼다. */
  private toBody(input: ProblemInput, prev: Body | null): Body {
    const hidden = input.cases.filter((c) => c.hidden);
    return {
      description: input.description,
      params: input.params,
      timeLimitMs: input.timeLimitMs,
      cases: input.cases.filter((c) => !c.hidden),
      code: input.starterCode ?? prev?.code ?? input.code,
      hiddenTestset: hidden.length ? this.testsets.put(hidden) : (prev?.hiddenTestset ?? null),
    };
  }

  /** 편집 권한자만. 만든 사람의 작성 코드는 시작 코드와 같다. */
  create(input: ProblemInput, userId: string, now = new Date()): Problem {
    const id = randomUUID();
    const ts = now.toISOString();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO problems (id, title, folder_id, mode, language, body, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
        .run(id, input.title, input.mode, input.language, JSON.stringify(this.toBody(input, null)), ts, ts);
      // 폴더는 개인 정리용: 만든 사람의 폴더에만 넣는다
      this.setFolder(id, userId, input.folderId);
    })();
    return this.get(id, userId)!;
  }

  /**
   * 자동 저장. 작성 코드·언어·내 케이스·메모는 언제나 그 사용자 것으로 저장하고, 문제 내용은 편집 권한이 있을 때만 바꾼다
   * (권한 없는 사용자가 보낸 내용 변경은 무시한다).
   */
  update(id: string, input: ProblemInput, userId: string, editor: boolean, now = new Date()): Problem | null {
    const row = this.row(id);
    if (!row) return null;
    if (editor) {
      const prev = this.body(row);
      const next = this.toBody(input, prev);
      if (row.title !== input.title || row.mode !== input.mode || JSON.stringify(prev) !== JSON.stringify(next))
        this.db.prepare('UPDATE problems SET title = ?, mode = ?, body = ?, updated_at = ? WHERE id = ?').run(input.title, input.mode, JSON.stringify(next), now.toISOString(), id);
    }
    // 폴더 배치는 사용자별(누구나 자기 폴더로 정리)
    if (input.folderId !== this.folderOf(id, userId)) this.setFolder(id, userId, input.folderId);
    this.upsertState(id, userId, { language: input.language, code: JSON.stringify(input.code), my_cases: JSON.stringify(input.myCases.map((c) => ({ ...c, hidden: false }))), memo: input.memo }, now);
    return this.get(id, userId);
  }

  /** 변경 필드만 최신 데이터에 합친다. 코드도 언어별로 합쳐 다른 언어의 풀이를 보존한다. */
  patch(id: string, patch: ProblemPatch, userId: string, editor: boolean): Problem | null {
    return this.db.transaction(() => {
      const current = this.get(id, userId);
      if (!current) return null;
      const { timer, ...fields } = patch;
      if (Object.keys(fields).length) {
        this.update(id, {
          ...current, ...fields,
          code: { ...current.code, ...fields.code },
          starterCode: fields.starterCode ? { ...current.starterCode, ...fields.starterCode } : undefined,
        }, userId, editor);
      }
      if (timer) this.setTimer(id, timer, userId);
      return this.get(id, userId);
    })();
  }

  /** 시작 코드만 바꾼다(마스터·편집 권한자) */
  setStarter(id: string, code: CodeSet, now = new Date()): boolean {
    const row = this.row(id);
    if (!row) return false;
    this.db.prepare('UPDATE problems SET body = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...this.body(row), code }), now.toISOString(), id);
    return true;
  }

  hidden(id: string): TestCase[] | null {
    const row = this.row(id);
    if (!row) return null;
    const ref = this.body(row).hiddenTestset;
    return ref ? (this.testsets.get(ref.hash) ?? []) : [];
  }

  setHidden(id: string, cases: TestCase[], now = new Date()): TestsetRef | null | false {
    const row = this.row(id);
    if (!row) return false;
    const ref = cases.length ? this.testsets.put(cases) : null;
    this.db.prepare('UPDATE problems SET body = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...this.body(row), hiddenTestset: ref }), now.toISOString(), id);
    return ref;
  }

  /** 풀이 시간 저장(사용자별) */
  setTimer(id: string, timer: ProblemTimer, userId: string): ProblemTimer | null {
    if (!this.row(id)) return null;
    this.upsertState(id, userId, { timer: JSON.stringify(timer) });
    return timer;
  }

  /** 채점 결과로 그 사용자의 마지막 제출을 갱신한다 */
  setLastSubmission(id: string, userId: string, sub: LastSubmission) {
    if (!this.row(id)) return;
    this.upsertState(id, userId, { last_submission: JSON.stringify(sub) });
  }

  /** 예전 형식(body.cases 안의 hidden 케이스)을 테스트셋으로 옮긴다. 옮긴 문제 수를 돌려준다. */
  migrateInlineHidden(): number {
    const rows = this.db.prepare('SELECT * FROM problems').all() as Row[];
    let moved = 0;
    for (const row of rows) {
      const raw = JSON.parse(row.body) as Partial<Body>;
      const hidden = (raw.cases ?? []).filter((c) => c.hidden);
      if (!hidden.length) continue;
      const b = this.body(row);
      b.cases = b.cases.filter((c) => !c.hidden);
      b.hiddenTestset = this.testsets.put(hidden);
      this.db.prepare('UPDATE problems SET body = ? WHERE id = ?').run(JSON.stringify(b), row.id);
      moved++;
    }
    return moved;
  }

  /** 문제들이 쓰는 테스트셋 해시 */
  testsetHashes(): Set<string> {
    const hashes = this.db.prepare("SELECT json_extract(body, '$.hiddenTestset.hash') FROM problems").pluck().all() as (string | null)[];
    return new Set(hashes.filter((h): h is string => !!h));
  }

  /** 편집 권한자만. 모든 사용자의 작성 코드·풀이 시간도 함께 지워진다. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM problems WHERE id = ?').run(id).changes > 0;
  }
}

type FolderRow = { id: string; name: string; position: number; created_at: string };

/** 폴더: 사용자별 개인 정리. 문제는 사용자마다 폴더 하나에 들어간다(folder_items). 비회원에게는 틀 폴더를 보여 준다. */
export class FolderStore {
  constructor(private readonly db: Db) {}

  private toFolder(r: FolderRow): Folder {
    return { id: r.id, name: r.name, position: r.position, createdAt: r.created_at };
  }

  private one(id: string, userId: string) {
    return this.db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(id, userId) as FolderRow | undefined;
  }

  list(userId: string | null): Folder[] {
    const rows = userId
      ? this.db.prepare('SELECT * FROM folders WHERE user_id = ? ORDER BY position, name').all(userId)
      : this.db.prepare('SELECT * FROM folders WHERE user_id IS NULL ORDER BY position, name').all();
    return (rows as FolderRow[]).map((r) => this.toFolder(r));
  }

  create(name: string, userId: string, now = new Date()): Folder {
    const id = randomUUID();
    const position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE user_id = ?').pluck().get(userId) as number) ?? 0;
    try {
      this.db.prepare('INSERT INTO folders (id, user_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, name, position, now.toISOString());
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoreError('duplicate_name', '같은 이름의 폴더가 있습니다.');
      throw e;
    }
    return this.toFolder(this.one(id, userId)!);
  }

  rename(id: string, name: string, userId: string): Folder | null {
    try {
      if (!this.db.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?').run(name, id, userId).changes) return null;
    } catch (e) {
      if (isUniqueViolation(e)) throw new StoreError('duplicate_name', '같은 이름의 폴더가 있습니다.');
      throw e;
    }
    return this.toFolder(this.one(id, userId)!);
  }

  /** 폴더를 지워도 문제는 남는다(폴더 없음). */
  delete(id: string, userId: string): boolean {
    return this.db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }
}

type CollectionRow = { id: string; name: string; description: string; created_at: string; updated_at: string };

/**
 * 컬렉션: 모두가 같이 보는 공용 묶음(편집 권한자만 바꾼다). 문제를 옮기지 않는 가상 묶음이라 한 문제가 여러 컬렉션에 들어갈 수 있다.
 * 이름의 '/'는 계층이다(예: "모의고사/1회"). 화면이 이름으로 나무를 그린다.
 */
export class CollectionStore {
  constructor(private readonly db: Db) {}

  private toCollection(r: CollectionRow): Collection {
    const problemIds = this.db.prepare('SELECT problem_id FROM collection_items WHERE collection_id = ? ORDER BY position').pluck().all(r.id) as string[];
    return Collection.parse({ id: r.id, name: r.name, description: r.description, problemIds, createdAt: r.created_at, updatedAt: r.updated_at });
  }

  list(): Collection[] {
    return (this.db.prepare('SELECT * FROM collections ORDER BY name').all() as CollectionRow[]).map((r) => this.toCollection(r));
  }

  get(id: string): Collection | null {
    const r = this.db.prepare('SELECT * FROM collections WHERE id = ?').get(id) as CollectionRow | undefined;
    return r ? this.toCollection(r) : null;
  }

  /** 경로 이름 정리: 앞뒤·구분자 주변 공백과 빈 단계를 없앤다("a / /b" → "a/b") */
  static normalize(name: string): string {
    return name
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean)
      .join('/');
  }

  private assertFree(name: string, exceptId?: string) {
    const hit = this.db.prepare('SELECT id FROM collections WHERE name = ?').pluck().get(name) as string | undefined;
    if (hit && hit !== exceptId) throw new StoreError('duplicate_name', '같은 이름의 컬렉션이 있습니다.');
  }

  create(input: CollectionInput, now = new Date()): Collection {
    const name = CollectionStore.normalize(input.name);
    if (!name) throw new StoreError('duplicate_name', '컬렉션 이름이 필요합니다.');
    this.assertFree(name);
    const id = randomUUID();
    const ts = now.toISOString();
    this.db.prepare('INSERT INTO collections (id, user_id, name, description, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?)').run(id, name, input.description, ts, ts);
    return this.get(id)!;
  }

  update(id: string, input: CollectionInput, now = new Date()): Collection | null {
    const name = CollectionStore.normalize(input.name);
    if (!name) throw new StoreError('duplicate_name', '컬렉션 이름이 필요합니다.');
    this.assertFree(name, id);
    const r = this.db.prepare('UPDATE collections SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, input.description, now.toISOString(), id);
    return r.changes ? this.get(id) : null;
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
      for (const [i, pid] of unique.entries()) ins.run(id, pid, i);
      this.db.prepare('UPDATE collections SET updated_at = ? WHERE id = ?').run(now.toISOString(), id);
    })();
    return this.get(id);
  }

  /** 컬렉션을 지워도 문제는 남는다. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM collections WHERE id = ?').run(id).changes > 0;
  }
}

type UserRow = {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string;
  role: 'user' | 'editor';
  terms_version: string;
  privacy_version: string;
  agreed_at: string;
  created_at: string;
  last_login_at: string;
};

export type GoogleProfile = { sub: string; email: string; name: string; picture: string };

export type User = { id: string; email: string; name: string; picture: string; editor: boolean };

/**
 * 사용자(Google 계정 1개 = 사용자 1명). 탈퇴하면 그 사용자의 작성 코드·컬렉션·제출이 모두 지워진다(ON DELETE CASCADE).
 * 편집 권한(role=editor)은 관리자 모드(마스터)에서 준다.
 */
export class UserStore {
  constructor(private readonly db: Db) {}

  private toUser(r: UserRow): User {
    return { id: r.id, email: r.email, name: r.name, picture: r.picture, editor: r.role === 'editor' };
  }

  byGoogleSub(sub: string) {
    const r = this.db.prepare('SELECT * FROM users WHERE google_sub = ?').get(sub) as UserRow | undefined;
    return r ? this.toUser(r) : null;
  }

  byId(id: string) {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? this.toUser(r) : null;
  }

  /** 동의를 받은 뒤 가입. 같은 Google 계정이 이미 있으면 그 사용자를 돌려준다. */
  create(p: GoogleProfile, versions: { terms: string; privacy: string }, opts: { editor?: boolean } = {}, now = new Date()) {
    const existing = this.byGoogleSub(p.sub);
    if (existing) return existing;
    const id = randomUUID();
    const ts = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO users (id, google_sub, email, name, picture, role, terms_version, privacy_version, agreed_at, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, p.sub, p.email, p.name, p.picture, opts.editor ? 'editor' : 'user', versions.terms, versions.privacy, ts, ts, ts);
    // 새 사용자도 기본 폴더 구성(틀)으로 시작한다
    copyTemplateFolders(this.db, id, now);
    return this.byId(id)!;
  }

  /** 로그인할 때 Google의 최신 이메일·이름·사진으로 갱신 */
  touch(id: string, p: GoogleProfile, now = new Date()) {
    this.db.prepare('UPDATE users SET email = ?, name = ?, picture = ?, last_login_at = ? WHERE id = ?').run(p.email, p.name, p.picture, now.toISOString(), id);
  }

  setEditor(id: string, editor: boolean): User | null {
    if (!this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(editor ? 'editor' : 'user', id).changes) return null;
    return this.byId(id);
  }

  /**
   * 소유자가 없는 예전 데이터(비밀번호 로그인 시절)를 이 사용자에게 넘긴다. 운영자 계정에만 쓴다.
   * 작성 코드·풀이 시간·채점 결과, 제출 기록. 넘긴 행 수를 돌려준다.
   */
  claimLegacy(userId: string, now = new Date()): number {
    let n = 0;
    this.db.transaction(() => {
      n += this.db
        .prepare(
          `INSERT OR IGNORE INTO user_problems (user_id, problem_id, language, code, timer, last_submission, updated_at)
           SELECT ?, problem_id, language, code, timer, last_submission, ? FROM legacy_state`,
        )
        .run(userId, now.toISOString()).changes;
      this.db.prepare('DELETE FROM legacy_state').run();
      // 컬렉션은 공용(user_id NULL)이므로 넘겨받지 않는다
      n += this.db.prepare('UPDATE submissions SET user_id = ? WHERE user_id IS NULL').run(userId).changes;
    })();
    return n;
  }

  private summaries(where: string, ...args: unknown[]): AdminUser[] {
    const rows = this.db
      .prepare(
        `SELECT u.*,
           (SELECT COUNT(*) FROM user_problems s WHERE s.user_id = u.id AND json_extract(s.last_submission, '$.score') = 100) AS solved,
           (SELECT COUNT(*) FROM submissions x WHERE x.user_id = u.id) AS submission_count
         FROM users u ${where} ORDER BY u.created_at`,
      )
      .all(...args) as (UserRow & { solved: number; submission_count: number })[];
    return rows.map((r) => ({
      ...this.toUser(r),
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      solved: r.solved,
      submissions: r.submission_count,
    }));
  }

  /** 관리자 페이지: 사용자 목록과 간단한 현황 */
  list(): AdminUser[] {
    return this.summaries('');
  }

  /** 관리자 페이지: 사용자 상세(문제별 풀이 현황, 최근 제출) */
  detail(id: string): AdminUserDetail | null {
    const [summary] = this.summaries('WHERE u.id = ?', id);
    if (!summary) return null;
    const r = this.db.prepare('SELECT terms_version, privacy_version, agreed_at FROM users WHERE id = ?').get(id) as UserRow;
    const problems = (
      this.db
        .prepare(
          `SELECT s.problem_id, p.title, s.timer, s.last_submission, s.updated_at FROM user_problems s JOIN problems p ON p.id = s.problem_id
           WHERE s.user_id = ? ORDER BY p.title`,
        )
        .all(id) as { problem_id: string; title: string; timer: string | null; last_submission: string | null; updated_at: string }[]
    ).map((x) => {
      const timer = parse<ProblemTimer>(x.timer) ?? EMPTY_TIMER;
      return {
        problemId: x.problem_id,
        title: x.title,
        score: parse<LastSubmission>(x.last_submission)?.score ?? null,
        elapsedMs: timer.elapsedMs,
        solvedMs: timer.solvedMs,
        updatedAt: x.updated_at,
      };
    });
    const recentSubmissions = (
      this.db
        .prepare(
          `SELECT x.id, p.title, x.kind, x.language, x.status, x.score, x.created_at FROM submissions x LEFT JOIN problems p ON p.id = x.problem_id
           WHERE x.user_id = ? ORDER BY x.created_at DESC LIMIT 30`,
        )
        .all(id) as { id: string; title: string | null; kind: 'run' | 'submit'; language: Language; status: string; score: number | null; created_at: string }[]
    ).map((x) => ({ id: x.id, problemTitle: x.title, kind: x.kind, language: x.language, status: x.status, score: x.score, createdAt: x.created_at }));
    return { ...summary, termsVersion: r.terms_version, privacyVersion: r.privacy_version, agreedAt: r.agreed_at, problems, recentSubmissions };
  }

  /** 탈퇴: 사용자와 그 사용자의 작성 코드·컬렉션·제출·세션을 모두 지운다. */
  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }
}

/** 전체 신규 가입 정책. 기본값은 기존처럼 가입 허용이다. */
export class SignupSettingsStore {
  constructor(private readonly db: Db) {}

  enabled(): boolean {
    return this.db.prepare('SELECT enabled FROM signup_settings WHERE id = 1').pluck().get() === 1;
  }

  setEnabled(enabled: boolean) {
    this.db.prepare('UPDATE signup_settings SET enabled = ? WHERE id = 1').run(enabled ? 1 : 0);
  }
}
