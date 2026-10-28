import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { JudgeStatus, lastSubmissionOf, type JudgeJob, type RunResult, type SubmissionKind, type TestCase } from '@solveline/shared';
import type { RunnerClient, RunJob } from './runner.ts';
import type { TestsetStore } from './testsets.ts';
import { log, redact } from './redact.ts';

const RUN_TEXT_LIMIT = 20_000;
const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}\n… (${t.length.toLocaleString()}자 중 ${n.toLocaleString()}자만 표시)` : t);

/**
 * 결과를 작게 유지한다. 채점(submit)은 화면에 반환값·출력을 보여 주지 않으므로 남기지 않고,
 * 코드 실행(run)은 반환값·출력을 잘라 둔다(큰 효율성 케이스가 수 MB를 반환해도 응답이 작다).
 */
function trimResult(r: RunResult['results'][number], kind: SubmissionKind): RunResult['results'][number] {
  if (kind === 'submit') return { ...r, actual: null, stdout: '', stderr: cut(r.stderr, 2000) };
  return { ...r, actual: r.actual === null ? null : cut(r.actual, RUN_TEXT_LIMIT), stdout: cut(r.stdout, RUN_TEXT_LIMIT), stderr: cut(r.stderr, RUN_TEXT_LIMIT) };
}

/** 숫자가 작을수록 먼저. 코드 실행이 제출 채점 뒤에 밀리지 않게 한다. */
export const PRIORITY: Record<SubmissionKind, number> = { run: 0, submit: 1 };

type Row = {
  id: string;
  kind: SubmissionKind;
  language: JudgeJob['language'];
  mode: JudgeJob['mode'];
  code: string;
  cases: string | null;
  testset_hash: string | null;
  case_ids: string;
  time_limit_ms: number;
  priority: number;
  status: JudgeStatus['status'];
  result: string | null;
  score: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  delivered: number;
};

/** judge의 대기열(사용자 데이터 없음). 끝난 작업은 API에 결과를 전달(delivered)하고 하루 뒤 지운다. */
export function openJobsDb(dataDir: string): Database.Database {
  let db: Database.Database;
  if (dataDir === ':memory:') db = new Database(':memory:');
  else {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(join(dataDir, 'judge.db'));
    db.pragma('journal_mode = WAL');
  }
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    language TEXT NOT NULL,
    mode TEXT NOT NULL,
    code TEXT NOT NULL,
    cases TEXT,
    testset_hash TEXT,
    case_ids TEXT NOT NULL,
    time_limit_ms INTEGER NOT NULL,
    priority INTEGER NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    score INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    delivered INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, priority, created_at);
  CREATE INDEX IF NOT EXISTS jobs_outbox ON jobs(delivered, finished_at);`);
  return db;
}

const TERMINAL = new Set(['done', 'error', 'cancelled']);
export const isTerminal = (s: JudgeStatus['status']) => TERMINAL.has(s);

export class JobStore {
  constructor(private db: Database.Database) {}

  /** 같은 id가 이미 있으면 넣지 않는다(API가 다시 보내도 한 번만 실행) */
  insert(job: JudgeJob, caseIds: string[], now = new Date()) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO jobs (id, kind, language, mode, code, cases, testset_hash, case_ids, time_limit_ms, priority, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(job.id, job.kind, job.language, job.mode, job.code, job.cases ? JSON.stringify(job.cases) : null, job.testsetHash, JSON.stringify(caseIds), job.timeLimitMs, PRIORITY[job.kind], now.toISOString());
  }

  private row(id: string) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
  }

  status(id: string): JudgeStatus | null {
    const r = this.row(id);
    return r ? this.toStatus(r) : null;
  }

  private toStatus(r: Row): JudgeStatus {
    const ahead =
      r.status === 'queued'
        ? (this.db
            .prepare("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running') AND id != ? AND (priority < ? OR (priority = ? AND created_at <= ?))")
            .pluck()
            .get(r.id, r.priority, r.priority, r.created_at) as number)
        : null;
    return JudgeStatus.parse({
      id: r.id,
      status: r.status,
      ahead,
      caseIds: JSON.parse(r.case_ids) as string[],
      result: r.result ? (JSON.parse(r.result) as RunResult) : null,
      score: r.score,
      error: r.error,
      finishedAt: r.finished_at,
    });
  }

  /** 다음 작업을 꺼내 running으로 바꾼다(없으면 null). 한 프로세스 안에서만 부르므로 경쟁이 없다. */
  claim(now = new Date()): Row | null {
    return this.db.transaction(() => {
      const r = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY priority, created_at LIMIT 1").get() as Row | undefined;
      if (!r) return null;
      this.db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(now.toISOString(), r.id);
      return { ...r, status: 'running' as const };
    })();
  }

  finish(id: string, out: { result: RunResult; score: number | null } | { error: string } | { cancelled: RunResult | null }, now = new Date()) {
    if ('cancelled' in out)
      this.db.prepare("UPDATE jobs SET status = 'cancelled', result = ?, finished_at = ? WHERE id = ?").run(out.cancelled ? JSON.stringify(out.cancelled) : null, now.toISOString(), id);
    else if ('error' in out) this.db.prepare("UPDATE jobs SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(out.error, now.toISOString(), id);
    else this.db.prepare("UPDATE jobs SET status = 'done', result = ?, score = ?, finished_at = ? WHERE id = ?").run(JSON.stringify(out.result), out.score, now.toISOString(), id);
  }

  /** 대기 중인 작업을 바로 중지한다. 바뀌었으면 true */
  cancelQueued(id: string, now = new Date()): boolean {
    return this.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(now.toISOString(), id).changes > 0;
  }

  /** 프로세스가 죽어 running으로 남은 작업을 다시 대기열로 */
  requeueStale(): number {
    return this.db.prepare("UPDATE jobs SET status = 'queued', started_at = NULL WHERE status = 'running'").run().changes;
  }

  /** 끝났지만 API에 아직 전달하지 못한 작업 */
  undelivered(limit = 50): JudgeStatus[] {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE delivered = 0 AND status IN ('done','error','cancelled') ORDER BY finished_at LIMIT ?").all(limit) as Row[];
    return rows.map((r) => this.toStatus(r));
  }

  markDelivered(id: string) {
    this.db.prepare('UPDATE jobs SET delivered = 1 WHERE id = ?').run(id);
  }

  /** 전달을 마치고 오래된 작업을 지운다 */
  prune(olderThan: Date): number {
    return this.db.prepare("DELETE FROM jobs WHERE delivered = 1 AND finished_at < ?").run(olderThan.toISOString()).changes;
  }
}

/**
 * 디스패처: 대기열에서 우선순위 순으로 꺼내 비어 있는 runner 슬롯에 보낸다.
 * runner는 상태가 없으므로 RUNNER_URLS에 주소를 더하면 처리량이 늘어난다. 작업이 끝나면 onFinished로 알린다(결과 전달).
 */
export class Dispatcher {
  private active = new Map<RunnerClient, number>();
  /** 상태 변화(대기 순번·실행 시작·끝남)를 기다리는 조회 요청 */
  private watchers = new Set<() => void>();
  /** 실행 중인 작업 → 맡은 runner, 중지 요청을 받은 작업 */
  private running = new Map<string, RunnerClient>();
  private cancelling = new Set<string>();
  onFinished?: (id: string) => void;

  constructor(
    private store: JobStore,
    private testsets: TestsetStore,
    private runners: RunnerClient[],
    private slotsPerRunner: number,
  ) {
    for (const r of runners) this.active.set(r, 0);
  }

  start() {
    const n = this.store.requeueStale();
    if (n) log.warn(`[queue] 끝나지 않은 작업 ${n}개를 다시 대기열에 넣었습니다.`);
    this.kick();
  }

  /** 빈 슬롯을 채운다. 새 작업이 들어오거나 하나가 끝날 때마다 부른다. */
  kick() {
    for (;;) {
      const runner = this.freeRunner();
      if (!runner) return;
      const job = this.store.claim();
      if (!job) return;
      // 실행이 시작되면 그 작업과 뒤에 기다리는 작업의 대기 순번이 바뀐다
      this.changed();
      this.active.set(runner, (this.active.get(runner) ?? 0) + 1);
      void this.execute(job, runner).finally(() => {
        this.active.set(runner, (this.active.get(runner) ?? 1) - 1);
        this.kick();
      });
    }
  }

  /** 긴 조회: 끝났으면 바로, 아니면 상태가 바뀌거나 ms가 지날 때 현재 상태를 돌려준다. 없는 작업이면 null. */
  async poll(id: string, ms: number): Promise<JudgeStatus | null> {
    const cur = this.store.status(id);
    if (!cur || isTerminal(cur.status) || ms <= 0) return cur;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.watchers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.watchers.add(done);
    });
    return this.store.status(id);
  }

  /** 끝날 때까지 기다린다(테스트용) */
  async wait(id: string): Promise<JudgeStatus> {
    for (;;) {
      const s = await this.poll(id, 60_000);
      if (!s || isTerminal(s.status)) return s!;
    }
  }

  private changed() {
    const all = [...this.watchers];
    this.watchers.clear();
    for (const w of all) w();
  }

  /**
   * 작업을 중지한다. 대기 중이면 바로 cancelled, 실행 중이면 runner에 알리고 execute가 cancelled로 마무리한다.
   * 이미 끝난 작업은 그대로 둔다. 없는 작업이면 null.
   */
  async cancel(id: string): Promise<JudgeStatus | null> {
    if (this.store.cancelQueued(id)) {
      this.finished(id);
      return this.store.status(id);
    }
    const runner = this.running.get(id);
    if (runner && !this.cancelling.has(id)) {
      this.cancelling.add(id);
      await runner.cancel(id);
    }
    return this.store.status(id);
  }

  private finished(id: string) {
    this.changed();
    this.onFinished?.(id);
  }

  private freeRunner(): RunnerClient | null {
    let best: RunnerClient | null = null;
    for (const [r, n] of this.active) if (n < this.slotsPerRunner && (!best || n < (this.active.get(best) ?? 0))) best = r;
    return best;
  }

  private async execute(job: Row, runner: RunnerClient) {
    this.running.set(job.id, runner);
    try {
      const run: RunJob = { language: job.language, mode: job.mode, code: job.code, timeLimitMs: job.time_limit_ms, jobId: job.id };
      if (job.testset_hash) {
        const hash = job.testset_hash;
        run.testset = { hash, raw: () => this.testsets.raw(hash) };
      } else run.cases = JSON.parse(job.cases ?? '[]') as TestCase[];
      const raw = await runner.run(run);
      const ids = JSON.parse(job.case_ids) as string[];
      const result: RunResult = { compile: raw.compile, results: raw.results.map((r, i) => trimResult({ ...r, id: ids[i] ?? String(i) }, job.kind)) };
      if (raw.cancelled || this.cancelling.has(job.id)) {
        // 중지된 제출은 점수를 기록하지 않는다
        this.store.finish(job.id, { cancelled: job.kind === 'run' ? result : null });
        return;
      }
      const score = job.kind === 'submit' ? lastSubmissionOf(result, ids.length, job.language, new Date().toISOString()).score : null;
      this.store.finish(job.id, { result, score });
    } catch (e) {
      if (this.cancelling.has(job.id)) this.store.finish(job.id, { cancelled: null });
      else {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(`[queue] 작업 ${job.id} 실패`, e);
        this.store.finish(job.id, { error: redact(msg) });
      }
    } finally {
      this.running.delete(job.id);
      this.cancelling.delete(job.id);
      this.finished(job.id);
    }
  }
}
