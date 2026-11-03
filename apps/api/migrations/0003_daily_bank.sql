-- 일일 미니 문제 은행(#165). 날짜별 회차 대신 사람마다 다른 문제를 고른다. db-node.ts의 dailyBankMigration과 같게 유지한다(테스트가 비교한다).
DROP TABLE daily_inbox_reads;
DROP TABLE daily_deliveries;
DROP TABLE daily_issues;
CREATE TABLE daily_bank (
  problem_id TEXT PRIMARY KEY REFERENCES problems(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  hint TEXT NOT NULL DEFAULT '',
  hint_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft','ready','retired')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX daily_bank_pick ON daily_bank(status, topic, level);
CREATE TABLE daily_picks (
  owner TEXT NOT NULL,
  pick_date TEXT NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner, pick_date),
  UNIQUE (owner, problem_id)
);
CREATE INDEX daily_picks_problem ON daily_picks(problem_id);
CREATE TABLE daily_deliveries (
  pick_date TEXT NOT NULL,
  subscriber_id TEXT NOT NULL REFERENCES daily_subscribers(id) ON DELETE CASCADE,
  problem_id TEXT REFERENCES problems(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  error TEXT,
  sent_at TEXT,
  PRIMARY KEY (pick_date, subscriber_id)
);
CREATE INDEX daily_deliveries_status ON daily_deliveries(pick_date, status);
