import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createJudge } from './app.ts';
import { openJobsDb } from './jobs.ts';
import { TestsetMirror } from './mirror.ts';
import { R2ObjectStore, WorkerR2Store } from './r2.ts';
import { RunnerClient } from './runner.ts';
import { TestsetStore } from './testsets.ts';
import { log, registerSecret } from './redact.ts';

// 환경 변수: JUDGE_SECRET(필수, API와 같은 값), RESULTS_URL(결과를 보낼 API 주소), RUNNER_URLS, RUNNER_SLOTS, DATA_DIR,
// 테스트셋 R2 미러(선택): R2_PROXY_SECRET + WEB_ORIGIN(Worker를 거친다) 또는 R2_*(S3 키, 있으면 우선)
const env = process.env;
const secret = env.JUDGE_SECRET?.trim() ?? '';
if (secret.length < 32) {
  console.error('JUDGE_SECRET(32자 이상)이 필요합니다.');
  process.exit(1);
}
registerSecret(secret);
registerSecret(env.R2_SECRET_ACCESS_KEY);
registerSecret(env.R2_PROXY_SECRET);
const dataDir = env.DATA_DIR ?? './data';
const runners = (env.RUNNER_URLS ?? 'http://127.0.0.1:8000').split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean).map((u) => new RunnerClient(u));
const testsets = new TestsetStore(join(dataDir, 'testsets'));
const r2 =
  env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
    ? new R2ObjectStore({ accountId: env.R2_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket: env.R2_BUCKET })
    : env.R2_PROXY_SECRET?.trim() && env.WEB_ORIGIN?.trim()
      ? new WorkerR2Store(env.WEB_ORIGIN.trim().replace(/\/$/, ''), env.R2_PROXY_SECRET.trim())
      : null;
const mirror = r2 ? new TestsetMirror(r2, testsets) : null;

const judge = createJudge({
  db: openJobsDb(join(dataDir, 'judge')),
  runners,
  slotsPerRunner: Math.max(1, Number(env.RUNNER_SLOTS) || 2),
  testsets,
  secret,
  resultsUrl: env.RESULTS_URL?.replace(/\/$/, '') || null,
  mirror,
});
judge.start();
if (mirror)
  // 로컬에만 있는 테스트셋을 R2에 올린다(처음 켤 때 전체 이전). Worker가 잠시 안 될 수 있으므로 1분마다 다시 시도한다(최대 1시간).
  void (async () => {
    for (let attempt = 1; attempt <= 60; attempt++) {
      try {
        log.info(`[testsets] R2에 ${await mirror.syncUp()}개를 올렸습니다.`);
        return;
      } catch (e) {
        log.error(`[testsets] R2 동기화 실패(${attempt}번째, 1분 뒤 다시)`, e);
        await new Promise((r) => setTimeout(r, 60_000).unref());
      }
    }
  })();

const port = Number(env.PORT) || 8790;
const server = serve({ fetch: judge.app.fetch, port }, () => log.info(`solveline-judge :${port} (runners=${runners.map((r) => r.baseUrl).join(',')})`));
const shutdown = () => {
  judge.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
