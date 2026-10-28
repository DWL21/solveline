import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { BackupJob } from './backup.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { RunnerClient } from './runner.ts';
import { TestsetStore } from './testsets.ts';
import { R2ObjectStore } from './r2.ts';
import { log, registerSecret } from './redact.ts';

const config = loadConfig();
registerSecret(config.sessionSecret);
registerSecret(config.google?.clientSecret);
registerSecret(config.adminPassword);
registerSecret(config.r2?.secretAccessKey);
if (!config.adminPassword) log.warn('[config] ACCESS_PASSWORD가 없어 관리자 모드를 열 수 없습니다.');
if (!config.google) log.warn('[config] GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET이 없어 로그인할 수 없습니다.');
if (!config.ownerEmail) log.warn('[config] OWNER_EMAIL이 없어 예전 데이터를 넘겨받을 계정이 없습니다.');

const db = openDb(config.dataDir);
const testsets = new TestsetStore(join(config.dataDir, 'testsets'));
const runners = config.runnerUrls.map((u) => new RunnerClient(u));
const objectStore = config.r2 ? new R2ObjectStore(config.r2) : null;
const { app, dispatcher, problems, submissions, catalog } = createApp({ config, db, runners, testsets, objectStore });

const moved = await problems.migrateInlineHidden();
if (moved) log.info(`[migrate] 문제 ${moved}개의 히든 케이스를 테스트셋 파일로 옮겼습니다.`);
dispatcher.start();
if (catalog) {
  // R2와 맞춘다: 로컬에 없는 테스트셋은 받아 오고, 바뀐 문제·테스트셋은 올린다(처음 켤 때 전체 이전)
  void (async () => {
    try {
      const restored = await catalog.hydrate();
      if (restored) log.info(`[catalog] R2에서 테스트셋 ${restored}개를 받았습니다.`);
      const r = await catalog.sync();
      log.info(`[catalog] R2 게시: 문제 ${r.problems}개, 테스트셋 ${r.testsets}개, 목록 ${r.index ? '갱신' : '그대로'}`);
    } catch (e) {
      log.error('[catalog] R2 동기화 실패', e);
    }
  })();
} else log.info('[catalog] R2 설정이 없어 게시하지 않습니다(SQLite·로컬 테스트셋만 사용).');
const backup = new BackupJob(db, config.dataDir, problems, submissions, testsets);
backup.start();

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) =>
  log.info(`solveline-api :${port} (runners=${config.runnerUrls.join(',')} × ${config.runnerSlots})`),
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
