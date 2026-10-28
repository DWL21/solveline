import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { templateFor, type ProblemMode } from '@solveline/shared';

// Node(pahidc api·테스트) 전용: better-sqlite3 파일 DB와 마이그레이션. Worker(D1)는 migrations/*.sql을 쓴다.
// 마이그레이션을 더하면 `pnpm --filter @solveline/api d1:schema`로 D1 스키마 파일도 다시 만든다.

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
  // 요청 제한(Worker는 메모리로 셀 수 없어 테이블에 센다). key는 "<제한 이름>:<IP·사용자>"
  `CREATE TABLE rate_limits (
     key TEXT PRIMARY KEY,
     count INTEGER NOT NULL,
     reset_at INTEGER NOT NULL
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
    const id = crypto.randomUUID();
    if (insFolder.run(id, userId, t.name, t.position, now.toISOString()).changes) insItems.run(userId, id, t.id);
  }
}

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
