-- 자동 생성: pnpm --filter @solveline/api d1:schema (apps/api/src/db-node.ts의 마이그레이션 결과). 직접 고치지 않는다.
CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL,
     created_at TEXT NOT NULL
   , user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE problems (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     mode TEXT NOT NULL CHECK (mode IN ('function','stdin')),
     language TEXT NOT NULL CHECK (language IN ('java','python')),
     body TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   , folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL);
CREATE INDEX problems_updated ON problems(updated_at);
CREATE INDEX problems_folder ON problems(folder_id);
CREATE TABLE collection_items (
     collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
     problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     PRIMARY KEY (collection_id, problem_id)
   );
CREATE INDEX collection_items_problem ON collection_items(problem_id);
CREATE TABLE "submissions" (
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
   , user_id TEXT REFERENCES users(id) ON DELETE CASCADE);
CREATE INDEX submissions_queue ON submissions(status, priority, created_at);
CREATE TABLE users (
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
CREATE TABLE legacy_state (
       problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE,
       language TEXT,
       code TEXT,
       timer TEXT,
       last_submission TEXT
     );
CREATE TABLE "collections" (
       id TEXT PRIMARY KEY,
       user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       description TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       UNIQUE (user_id, name)
     );
CREATE TABLE signup_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
   );
CREATE TABLE "folders" (
       id TEXT PRIMARY KEY,
       user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
       name TEXT NOT NULL,
       position INTEGER NOT NULL,
       created_at TEXT NOT NULL,
       UNIQUE (user_id, name)
     );
CREATE INDEX folders_user ON folders(user_id, position);
CREATE TABLE folder_items (
       user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
       folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
       PRIMARY KEY (user_id, problem_id)
     );
CREATE INDEX folder_items_folder ON folder_items(folder_id);
CREATE TABLE bookmarks (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
     PRIMARY KEY (user_id, problem_id)
   );
CREATE TABLE rate_limits (
     key TEXT PRIMARY KEY,
     count INTEGER NOT NULL,
     reset_at INTEGER NOT NULL
   );
INSERT INTO signup_settings (id, enabled) VALUES (1, 1);
