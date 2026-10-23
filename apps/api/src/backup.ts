import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, ProblemStore } from './db.ts';
import type { SubmissionStore } from './dispatcher.ts';
import type { TestsetStore } from './testsets.ts';
import { log } from './redact.ts';

const KEEP_DAYS = 7;
const SUBMISSION_DAYS = 30;

/**
 * 매일 한 번: SQLite 온라인 백업(DATA_DIR/backups/solveline-YYYY-MM-DD.db, 7일 보관),
 * 테스트셋 파일 복사(내용이 바뀌지 않으므로 없는 것만), 오래된 제출 기록·안 쓰는 테스트셋 정리.
 * 같은 디스크라 디스크 고장은 못 막는다 — 외부 저장소로 내보내는 것은 로드맵.
 */
export class BackupJob {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Db,
    private dataDir: string,
    private problems: ProblemStore,
    private submissions: SubmissionStore,
    private testsets: TestsetStore,
  ) {}

  start() {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 3600_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 오늘 백업이 없으면 만든다. 만든 파일 경로를 돌려준다. */
  async tick(now = new Date()): Promise<string | null> {
    if (this.dataDir === ':memory:') return null;
    const dir = join(this.dataDir, 'backups');
    mkdirSync(join(dir, 'testsets'), { recursive: true });
    const day = now.toISOString().slice(0, 10);
    const file = join(dir, `solveline-${day}.db`);
    if (existsSync(file)) return null;
    try {
      await this.db.backup(`${file}.tmp`);
      copyFileSync(`${file}.tmp`, file);
      unlinkSync(`${file}.tmp`);
      let copied = 0;
      const src = this.testsets.directory;
      for (const name of readdirSync(src)) {
        if (!name.endsWith('.json') || existsSync(join(dir, 'testsets', name))) continue;
        copyFileSync(join(src, name), join(dir, 'testsets', name));
        copied++;
      }
      const old = readdirSync(dir)
        .filter((n) => /^(solveline|codetest)-\d{4}-\d{2}-\d{2}\.db$/.test(n))
        .sort()
        .slice(0, -KEEP_DAYS);
      for (const n of old) unlinkSync(join(dir, n));
      const pruned = this.submissions.prune(new Date(now.getTime() - SUBMISSION_DAYS * 86400_000));
      const inUse = new Set([...this.problems.testsetHashes(), ...this.submissions.activeTestsets()]);
      const gced = this.testsets.gc(inUse);
      log.info(`[backup] ${file} (테스트셋 +${copied}, 오래된 백업 -${old.length}, 제출 기록 -${pruned}, 안 쓰는 테스트셋 -${gced})`);
      return file;
    } catch (e) {
      log.error('[backup] 실패', e);
      return null;
    }
  }
}
