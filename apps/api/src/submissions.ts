import { Submission, SubmissionDetail, SubmissionHistory, type JudgeStatus, type Language, type ProblemMode, type RunResult, type SubmissionKind, type TestCase } from '@solveline/shared';
import { stmt, type Sql } from './sql.ts';

type Row = {
  id: string;
  problem_id: string | null;
  kind: SubmissionKind;
  language: Language;
  mode: ProblemMode;
  code: string;
  case_ids: string;
  status: Submission['status'];
  result: string | null;
  score: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
  user_id: string | null;
};

export type NewSubmission = {
  id: string;
  userId: string;
  problemId: string | null;
  kind: SubmissionKind;
  language: Language;
  mode: ProblemMode;
  code: string;
  /** 요청에 담긴 케이스(코드 실행, 또는 히든 테스트셋이 없을 때의 제출) */
  cases: TestCase[] | null;
  testsetHash: string | null;
  timeLimitMs: number;
};

const TERMINAL = new Set(['done', 'error', 'cancelled']);
export const isTerminal = (s: Submission['status']) => TERMINAL.has(s);

/**
 * 제출 기록(사용자 데이터). 실행은 judge가 하고, 끝난 결과를 apply로 반영한다.
 * 대기열의 원본은 judge이므로 여기의 queued·running은 마지막으로 들은 상태다.
 */
export class SubmissionStore {
  constructor(private sql: Sql) {}

  async insert(s: NewSubmission, now = new Date()): Promise<void> {
    // priority는 예전 대기열의 열이다(judge로 옮긴 뒤로는 쓰지 않지만 NOT NULL이라 채운다)
    await this.sql.run(
      `INSERT INTO submissions (id, user_id, problem_id, kind, language, mode, code, cases, testset_hash, case_ids, time_limit_ms, priority, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      s.id, s.userId, s.problemId, s.kind, s.language, s.mode, s.code,
      s.cases ? JSON.stringify(s.cases) : null, s.testsetHash, JSON.stringify(s.cases?.map((c) => c.id) ?? []), s.timeLimitMs, s.kind === 'run' ? 0 : 1, now.toISOString(),
    );
  }

  private row(id: string) {
    return this.sql.get<Row>('SELECT * FROM submissions WHERE id = ?', id);
  }

  /** 이 사용자의 제출인가(다른 사용자의 제출은 없는 것과 같다) */
  async ownedBy(id: string, userId: string): Promise<boolean> {
    return (await this.sql.value('SELECT 1 FROM submissions WHERE id = ? AND user_id = ?', id, userId)) !== undefined;
  }

  private toSubmission(r: Row, ahead: number | null = null): Submission {
    return Submission.parse({
      id: r.id,
      problemId: r.problem_id,
      kind: r.kind,
      language: r.language,
      status: r.status,
      ahead: r.status === 'queued' ? ahead : null,
      caseIds: JSON.parse(r.case_ids) as string[],
      result: r.result ? (JSON.parse(r.result) as RunResult) : null,
      score: r.score,
      error: r.error,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
    });
  }

  async get(id: string, ahead: number | null = null): Promise<Submission | null> {
    const r = await this.row(id);
    return r ? this.toSubmission(r, ahead) : null;
  }

  /**
   * judge가 알려 준 상태를 반영한다. 끝난 기록은 다시 바꾸지 않는다(콜백과 긴 조회가 같은 결과를 두 번 줘도 한 번만).
   * 이번에 처음 끝났으면 finished=true와 함께 기록을 돌려준다(마지막 제출 갱신에 쓴다).
   */
  async apply(s: JudgeStatus): Promise<{ submission: Submission; finished: boolean; userId: string | null } | null> {
    const terminal = isTerminal(s.status);
    const [res] = await this.sql.batch([
      stmt(
        `UPDATE submissions SET status = ?, case_ids = ?, result = ?, score = ?, error = ?, finished_at = ?
         WHERE id = ? AND status IN ('queued','running')`,
        s.status, JSON.stringify(s.caseIds), s.result ? JSON.stringify(s.result) : null, s.score, s.error, s.finishedAt, s.id,
      ),
    ]);
    const r = await this.row(s.id);
    if (!r) return null;
    return { submission: this.toSubmission(r, s.ahead), finished: terminal && res!.changes > 0, userId: r.user_id };
  }

  async history(userId: string, offset: number) {
    const rows = await this.sql.all<Pick<Row, 'id' | 'language' | 'status' | 'score' | 'created_at' | 'finished_at'> & { problem_id: string | null; problem_title: string | null }>(
      `SELECT s.id, s.problem_id, p.title AS problem_title, s.language, s.status, s.score, s.created_at, s.finished_at
       FROM submissions s LEFT JOIN problems p ON p.id = s.problem_id
       WHERE s.user_id = ? AND s.kind = 'submit'
       ORDER BY s.created_at DESC, s.rowid DESC LIMIT 21 OFFSET ?`,
      userId,
      offset,
    );
    return SubmissionHistory.parse({
      items: rows.slice(0, 20).map((r) => ({ id: r.id, problemId: r.problem_id, problemTitle: r.problem_title, language: r.language, status: r.status, score: r.score, createdAt: r.created_at, finishedAt: r.finished_at })),
      nextOffset: rows.length > 20 ? offset + 20 : null,
    });
  }

  async detail(id: string, userId: string) {
    const row = await this.sql.get<{ code: string; problem_title: string | null }>(
      `SELECT s.code, p.title AS problem_title FROM submissions s
       LEFT JOIN problems p ON p.id = s.problem_id WHERE s.id = ? AND s.user_id = ? AND s.kind = 'submit'`,
      id,
      userId,
    );
    const submission = row ? await this.get(id) : null;
    return row && submission ? SubmissionDetail.parse({ ...submission, code: row.code, problemTitle: row.problem_title }) : null;
  }

  /** judge가 받지 않은 제출(잘못된 케이스 등)의 기록을 지운다 */
  async remove(id: string): Promise<void> {
    await this.sql.run('DELETE FROM submissions WHERE id = ?', id);
  }

  /** 끝난 지 오래된 제출 기록을 지운다 */
  async prune(olderThan: Date): Promise<number> {
    return (await this.sql.run("DELETE FROM submissions WHERE status IN ('done','error','cancelled') AND finished_at < ?", olderThan.toISOString())).changes;
  }
}
