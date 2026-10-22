import { randomUUID } from 'node:crypto';
import { Submission, type Language, type ProblemMode, type RunResult, type SubmissionKind, type TestCase } from '@codetest/shared';
import type { Db, ProblemStore } from './db.ts';
import type { RunnerClient, RunJob } from './runner.ts';
import type { TestsetStore } from './testsets.ts';
import { log, redact } from './redact.ts';

const RUN_TEXT_LIMIT = 20_000;
const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}\n… (${t.length.toLocaleString()}자 중 ${n.toLocaleString()}자만 표시)` : t);

/**
 * 저장·조회되는 결과를 작게 유지한다. 채점(submit)은 화면에 반환값·출력을 보여 주지 않으므로 저장하지 않고,
 * 코드 실행(run)은 반환값·출력을 잘라 둔다(큰 효율성 케이스가 수 MB를 반환해도 조회 응답이 작다).
 */
function trimResult(r: RunResult['results'][number], kind: SubmissionKind): RunResult['results'][number] {
  if (kind === 'submit') return { ...r, actual: null, stdout: '', stderr: cut(r.stderr, 2000) };
  return { ...r, actual: r.actual === null ? null : cut(r.actual, RUN_TEXT_LIMIT), stdout: cut(r.stdout, RUN_TEXT_LIMIT), stderr: cut(r.stderr, RUN_TEXT_LIMIT) };
}

/** 숫자가 작을수록 먼저. 코드 실행이 제출 채점 뒤에 밀리지 않게 한다(기존의 우선순위 큐와 같은 생각). */
export const PRIORITY: Record<SubmissionKind, number> = { run: 0, submit: 1 };

type Row = {
  id: string;
  problem_id: string | null;
  kind: SubmissionKind;
  language: Language;
  mode: ProblemMode;
  code: string;
  cases: string | null;
  testset_hash: string | null;
  case_ids: string;
  time_limit_ms: number;
  priority: number;
  status: Submission['status'];
  result: string | null;
  score: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type NewSubmission = {
  problemId: string | null;
  kind: SubmissionKind;
  language: Language;
  mode: ProblemMode;
  code: string;
  /** 요청에 담긴 케이스(코드 실행, 또는 히든 테스트셋이 없을 때의 제출) */
  cases: TestCase[] | null;
  testsetHash: string | null;
  caseIds: string[];
  timeLimitMs: number;
};

export class SubmissionStore {
  constructor(private db: Db) {}

  insert(s: NewSubmission, now = new Date()): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO submissions (id, problem_id, kind, language, mode, code, cases, testset_hash, case_ids, time_limit_ms, priority, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(
        id,
        s.problemId,
        s.kind,
        s.language,
        s.mode,
        s.code,
        s.cases ? JSON.stringify(s.cases) : null,
        s.testsetHash,
        JSON.stringify(s.caseIds),
        s.timeLimitMs,
        PRIORITY[s.kind],
        now.toISOString(),
      );
    return id;
  }

  row(id: string) {
    return this.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as Row | undefined;
  }

  get(id: string): Submission | null {
    const r = this.row(id);
    if (!r) return null;
    const ahead =
      r.status === 'queued'
        ? (this.db
            .prepare("SELECT COUNT(*) FROM submissions WHERE status IN ('queued','running') AND id != ? AND (priority < ? OR (priority = ? AND created_at <= ?))")
            .pluck()
            .get(r.id, r.priority, r.priority, r.created_at) as number)
        : null;
    return Submission.parse({
      id: r.id,
      problemId: r.problem_id,
      kind: r.kind,
      language: r.language,
      status: r.status,
      ahead,
      caseIds: JSON.parse(r.case_ids) as string[],
      result: r.result ? (JSON.parse(r.result) as RunResult) : null,
      score: r.score,
      error: r.error,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    });
  }

  /** 다음 제출을 꺼내 running으로 바꾼다(없으면 null). 한 프로세스 안에서만 부르므로 경쟁이 없다. */
  claim(now = new Date()): Row | null {
    return this.db.transaction(() => {
      const r = this.db.prepare("SELECT * FROM submissions WHERE status = 'queued' ORDER BY priority, created_at LIMIT 1").get() as Row | undefined;
      if (!r) return null;
      this.db.prepare("UPDATE submissions SET status = 'running', started_at = ? WHERE id = ?").run(now.toISOString(), r.id);
      return { ...r, status: 'running' as const };
    })();
  }

  finish(id: string, out: { result: RunResult; score: number | null } | { error: string } | { cancelled: RunResult | null }, now = new Date()) {
    if ('cancelled' in out)
      this.db
        .prepare("UPDATE submissions SET status = 'cancelled', result = ?, finished_at = ? WHERE id = ?")
        .run(out.cancelled ? JSON.stringify(out.cancelled) : null, now.toISOString(), id);
    else if ('error' in out) this.db.prepare("UPDATE submissions SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(out.error, now.toISOString(), id);
    else
      this.db
        .prepare("UPDATE submissions SET status = 'done', result = ?, score = ?, finished_at = ? WHERE id = ?")
        .run(JSON.stringify(out.result), out.score, now.toISOString(), id);
  }

  /** 대기 중인 제출을 바로 중지한다. 바뀌었으면 true */
  cancelQueued(id: string, now = new Date()): boolean {
    return this.db.prepare("UPDATE submissions SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").run(now.toISOString(), id).changes > 0;
  }

  /** 프로세스가 죽어 running으로 남은 제출을 다시 대기열로 */
  requeueStale(): number {
    return this.db.prepare("UPDATE submissions SET status = 'queued', started_at = NULL WHERE status = 'running'").run().changes;
  }

  activeTestsets(): Set<string> {
    const hashes = this.db.prepare("SELECT DISTINCT testset_hash FROM submissions WHERE status IN ('queued','running') AND testset_hash IS NOT NULL").pluck().all() as string[];
    return new Set(hashes);
  }

  /** 끝난 지 오래된 제출 기록을 지운다 */
  prune(olderThan: Date): number {
    return this.db.prepare("DELETE FROM submissions WHERE status IN ('done','error','cancelled') AND finished_at < ?").run(olderThan.toISOString()).changes;
  }
}

/**
 * 디스패처: 대기열에서 우선순위 순으로 꺼내 비어 있는 runner 슬롯에 보낸다.
 * runner는 상태가 없으므로 RUNNER_URLS에 주소를 더하면 처리량이 늘어난다.
 */
export class Dispatcher {
  private active = new Map<RunnerClient, number>();
  private waiters = new Map<string, ((s: Submission) => void)[]>();
  /** 실행 중인 제출 → 맡은 runner, 중지 요청을 받은 제출 */
  private running = new Map<string, RunnerClient>();
  private cancelling = new Set<string>();

  constructor(
    private store: SubmissionStore,
    private problems: ProblemStore,
    private testsets: TestsetStore,
    private runners: RunnerClient[],
    private slotsPerRunner: number,
  ) {
    for (const r of runners) this.active.set(r, 0);
  }

  start() {
    const n = this.store.requeueStale();
    if (n) log.warn(`[queue] 끝나지 않은 제출 ${n}개를 다시 대기열에 넣었습니다.`);
    this.kick();
  }

  /** 빈 슬롯을 채운다. 새 제출이 들어오거나 하나가 끝날 때마다 부른다. */
  kick() {
    for (;;) {
      const runner = this.freeRunner();
      if (!runner) return;
      const job = this.store.claim();
      if (!job) return;
      this.active.set(runner, (this.active.get(runner) ?? 0) + 1);
      void this.execute(job, runner).finally(() => {
        this.active.set(runner, (this.active.get(runner) ?? 1) - 1);
        this.kick();
      });
    }
  }

  /** 제출이 끝날 때까지 기다린다(동기 API·테스트용) */
  wait(id: string): Promise<Submission> {
    const cur = this.store.get(id);
    if (cur && cur.status !== 'queued' && cur.status !== 'running') return Promise.resolve(cur);
    return new Promise((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]));
  }

  /**
   * 제출을 중지한다. 대기 중이면 바로 cancelled, 실행 중이면 runner에 알리고 execute가 cancelled로 마무리한다.
   * 이미 끝난 제출은 그대로 둔다. 없는 제출이면 null.
   */
  async cancel(id: string): Promise<Submission | null> {
    if (this.store.cancelQueued(id)) {
      this.notify(id);
      return this.store.get(id);
    }
    const runner = this.running.get(id);
    if (runner && !this.cancelling.has(id)) {
      this.cancelling.add(id);
      await runner.cancel(id);
    }
    return this.store.get(id);
  }

  private notify(id: string) {
    const done = this.store.get(id);
    if (done) for (const w of this.waiters.get(id) ?? []) w(done);
    this.waiters.delete(id);
  }

  private freeRunner(): RunnerClient | null {
    let best: RunnerClient | null = null;
    for (const [r, n] of this.active) if (n < this.slotsPerRunner && (!best || n < (this.active.get(best) ?? 0))) best = r;
    return best;
  }

  private async execute(job: NonNullable<ReturnType<SubmissionStore['claim']>>, runner: RunnerClient) {
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
      let score: number | null = null;
      if (job.kind === 'submit') {
        const total = ids.length;
        const passed = result.compile.ok ? result.results.filter((r) => r.status === 'pass').length : 0;
        score = total ? Math.round((passed / total) * 100) : 0;
        if (job.problem_id) this.problems.setLastSubmission(job.problem_id, { score, passed, total, language: job.language, at: new Date().toISOString() });
      }
      this.store.finish(job.id, { result, score });
    } catch (e) {
      if (this.cancelling.has(job.id)) this.store.finish(job.id, { cancelled: null });
      else {
        const msg = e instanceof Error ? e.message : String(e);
        log.error(`[queue] 제출 ${job.id} 실패`, e);
        this.store.finish(job.id, { error: redact(msg) });
      }
    } finally {
      this.running.delete(job.id);
      this.cancelling.delete(job.id);
      this.notify(job.id);
    }
  }
}
