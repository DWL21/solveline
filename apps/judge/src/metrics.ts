import type Database from 'better-sqlite3';

/**
 * 채점 지표(0011 Tier 0). jobs는 전달 뒤 하루면 지워지므로, 끝난 작업마다 시간 정보만 job_stats에 남겨 오래 본다.
 * 코드·입력·결과·사용자 정보는 남기지 않는다.
 */
export const STATS_RETENTION_DAYS = 90;

export function createStatsTable(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_stats (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    language TEXT NOT NULL,
    status TEXT NOT NULL,
    cases INTEGER NOT NULL,
    queued_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    wait_ms INTEGER,
    run_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS job_stats_finished ON job_stats(finished_at);`);
}

/** 끝난 작업 한 건을 기록한다(같은 id는 덮어쓴다). 실행 전에 중지된 작업은 실행 시간이 없다. */
export function recordStats(db: Database.Database, id: string) {
  db.prepare(
    `INSERT OR REPLACE INTO job_stats (id, kind, language, status, cases, queued_at, finished_at, wait_ms, run_ms)
     SELECT id, kind, language, status, json_array_length(case_ids), created_at, finished_at,
            CASE WHEN started_at IS NULL THEN NULL ELSE CAST(ROUND((julianday(started_at) - julianday(created_at)) * 86400000) AS INTEGER) END,
            CASE WHEN started_at IS NULL THEN NULL ELSE CAST(ROUND((julianday(finished_at) - julianday(started_at)) * 86400000) AS INTEGER) END
     FROM jobs WHERE id = ? AND finished_at IS NOT NULL`,
  ).run(id);
}

export function pruneStats(db: Database.Database, olderThan: Date): number {
  return db.prepare('DELETE FROM job_stats WHERE finished_at < ?').run(olderThan.toISOString()).changes;
}

type StatRow = { kind: string; language: string; status: string; cases: number; wait_ms: number | null; run_ms: number | null };

export type GroupMetrics = {
  kind: string;
  language: string;
  count: number;
  statuses: Record<string, number>;
  avgCases: number;
  runMs: { avg: number | null; p50: number | null; p95: number | null; max: number | null };
  waitMs: { p50: number | null; p95: number | null; max: number | null };
};

export type JudgeMetrics = {
  at: string;
  queue: { queued: Record<string, number>; running: number; slots: number };
  windows: Record<'5m' | '24h' | '7d', { count: number; perMinutePeak: number; groups: GroupMetrics[] }>;
  retentionDays: number;
};

/** 가장 가까운 순위(nearest-rank) 백분위수 */
function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function summarize(rows: StatRow[]): GroupMetrics[] {
  const groups = new Map<string, StatRow[]>();
  for (const r of rows) {
    const key = `${r.kind}\u0000${r.language}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()]
    .map((list) => {
      const run = list.map((r) => r.run_ms).filter((v): v is number => v !== null).sort((a, b) => a - b);
      const wait = list.map((r) => r.wait_ms).filter((v): v is number => v !== null).sort((a, b) => a - b);
      const statuses: Record<string, number> = {};
      for (const r of list) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      return {
        kind: list[0]!.kind,
        language: list[0]!.language,
        count: list.length,
        statuses,
        avgCases: Math.round((list.reduce((s, r) => s + r.cases, 0) / list.length) * 10) / 10,
        runMs: { avg: run.length ? Math.round(run.reduce((s, v) => s + v, 0) / run.length) : null, p50: percentile(run, 0.5), p95: percentile(run, 0.95), max: run.at(-1) ?? null },
        waitMs: { p50: percentile(wait, 0.5), p95: percentile(wait, 0.95), max: wait.at(-1) ?? null },
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.language.localeCompare(b.language));
}

/** 지금 대기열 상태와 최근 5분·24시간·7일 지표 */
export function collectMetrics(db: Database.Database, slots: number, now = new Date()): JudgeMetrics {
  const queued: Record<string, number> = { run: 0, submit: 0 };
  let running = 0;
  for (const r of db.prepare("SELECT kind, status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running') GROUP BY kind, status").all() as { kind: string; status: string; n: number }[]) {
    if (r.status === 'queued') queued[r.kind] = r.n;
    else running += r.n;
  }
  const window = (ms: number) => {
    const since = new Date(now.getTime() - ms).toISOString();
    const rows = db.prepare('SELECT kind, language, status, cases, wait_ms, run_ms FROM job_stats WHERE finished_at >= ?').all(since) as StatRow[];
    const peak = db.prepare('SELECT COALESCE(MAX(n), 0) FROM (SELECT COUNT(*) AS n FROM job_stats WHERE finished_at >= ? GROUP BY substr(queued_at, 1, 16))').pluck().get(since) as number;
    return { count: rows.length, perMinutePeak: peak, groups: summarize(rows) };
  };
  return {
    at: now.toISOString(),
    queue: { queued, running, slots },
    windows: { '5m': window(5 * 60_000), '24h': window(24 * 3600_000), '7d': window(7 * 24 * 3600_000) },
    retentionDays: STATS_RETENTION_DAYS,
  };
}

/** 최근 평균 실행 시간이 없을 때의 가정값(ms). 0011 5장 측정(2026-11-04)보다 넉넉하게 둔다 */
const DEFAULT_RUN_MS: Record<string, number> = { run: 1000, submit: 3000 };

/** 이 종류의 최근 평균 실행 시간(최근 30분, 없으면 7일, 그것도 없으면 가정값) */
export function recentRunMs(db: Database.Database, kind: string, now = new Date()): number {
  for (const ms of [30 * 60_000, 7 * 24 * 3600_000]) {
    const avg = db
      .prepare("SELECT AVG(run_ms) FROM job_stats WHERE kind = ? AND status = 'done' AND run_ms IS NOT NULL AND finished_at >= ?")
      .pluck()
      .get(kind, new Date(now.getTime() - ms).toISOString()) as number | null;
    if (avg !== null) return avg;
  }
  return DEFAULT_RUN_MS[kind] ?? 3000;
}

/**
 * 지금 넣으면 실행을 시작하기까지 기다릴 예상 시간(ms) = 앞에 있는 작업 수 ÷ 슬롯 × 최근 평균 실행 시간.
 * 코드 실행은 실행 중인 것과 대기 중인 코드 실행만, 제출은 대기 중인 모든 작업을 앞에 둔다(aging은 무시해 넉넉하게 센다).
 */
export function estimateWaitMs(db: Database.Database, kind: 'run' | 'submit', slots: number, now = new Date()): number {
  const ahead = db
    .prepare(`SELECT COUNT(*) FROM jobs WHERE status = 'running' OR (status = 'queued' AND (? = 'submit' OR kind = 'run'))`)
    .pluck()
    .get(kind) as number;
  return (ahead / Math.max(1, slots)) * recentRunMs(db, kind, now);
}
