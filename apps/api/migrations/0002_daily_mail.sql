-- 일일 메일 구독(#156). db-node.ts의 dailyMigration과 같게 유지한다(테스트가 비교한다).
CREATE TABLE daily_subscribers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','active','unsubscribed','bounced','complained')),
  confirm_hash TEXT,
  confirm_expires_at INTEGER,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  ended_at TEXT,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  weekdays INTEGER NOT NULL DEFAULT 127
);
CREATE INDEX daily_subscribers_status ON daily_subscribers(status);
CREATE TABLE daily_issues (
  issue_date TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',
  hint_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft','ready')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE daily_deliveries (
  issue_date TEXT NOT NULL REFERENCES daily_issues(issue_date) ON DELETE CASCADE,
  subscriber_id TEXT NOT NULL REFERENCES daily_subscribers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  error TEXT,
  sent_at TEXT,
  PRIMARY KEY (issue_date, subscriber_id)
);
CREATE INDEX daily_deliveries_status ON daily_deliveries(issue_date, status);
CREATE TABLE daily_members (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  started_date TEXT NOT NULL,
  ended_date TEXT
);
CREATE TABLE daily_inbox_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issue_date TEXT NOT NULL REFERENCES daily_issues(issue_date) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY (user_id, issue_date)
);
CREATE TABLE daily_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL DEFAULT 0
);
INSERT INTO daily_settings (id, paused) VALUES (1, 0);
