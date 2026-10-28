import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { BackupJob } from './backup.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { HttpJudge } from './judge.ts';
import { R2ObjectStore } from '@solveline/judge/r2';
import { log, registerSecret } from './redact.ts';

const config = loadConfig();
registerSecret(config.sessionSecret);
registerSecret(config.google?.clientSecret);
registerSecret(config.adminPassword);
registerSecret(config.r2?.secretAccessKey);
registerSecret(config.judgeSecret);
if (!config.adminPassword) log.warn('[config] ACCESS_PASSWORD가 없어 관리자 모드를 열 수 없습니다.');
if (!config.google) log.warn('[config] GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET이 없어 로그인할 수 없습니다.');
if (!config.ownerEmail) log.warn('[config] OWNER_EMAIL이 없어 예전 데이터를 넘겨받을 계정이 없습니다.');

const db = openDb(config.dataDir);
const judge = new HttpJudge(config.judgeUrl, config.judgeSecret);
const objectStore = config.r2 ? new R2ObjectStore(config.r2) : null;
const { app, submissions, catalog } = createApp({ config, db, judge, objectStore });

if (catalog) {
  // R2와 맞춘다: 바뀐 문제를 올린다(처음 켤 때 전체 이전). 히든 테스트셋은 judge가 올린다
  void (async () => {
    try {
      const r = await catalog.sync();
      log.info(`[catalog] R2 게시: 문제 ${r.problems}개, 목록 ${r.index ? '갱신' : '그대로'}`);
    } catch (e) {
      log.error('[catalog] R2 동기화 실패', e);
    }
  })();
} else log.info('[catalog] R2 설정이 없어 게시하지 않습니다(SQLite·로컬 테스트셋만 사용).');
const backup = new BackupJob(db, config.dataDir, submissions);
backup.start();

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) =>
  log.info(`solveline-api :${port} (judge=${config.judgeUrl})`),
);

const shutdown = () => {
  backup.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
