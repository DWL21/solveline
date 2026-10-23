import { serve } from '@hono/node-server';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { BackupJob } from './backup.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { RunnerClient } from './runner.ts';
import { TestsetStore } from './testsets.ts';
import { log, registerSecret } from './redact.ts';

const config = loadConfig();
registerSecret(config.sessionSecret);
registerSecret(config.google?.clientSecret);
registerSecret(config.adminPassword);
if (!config.adminPassword) log.warn('[config] ACCESS_PASSWORD가 없어 관리자 모드를 열 수 없습니다.');
if (!config.google) log.warn('[config] GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET이 없어 로그인할 수 없습니다.');
if (!config.ownerEmail) log.warn('[config] OWNER_EMAIL이 없어 예전 데이터를 넘겨받을 계정이 없습니다.');

const db = openDb(config.dataDir);
const testsets = new TestsetStore(join(config.dataDir, 'testsets'));
const runners = config.runnerUrls.map((u) => new RunnerClient(u));
const { app, dispatcher, problems, submissions } = createApp({ config, db, runners, testsets });

const moved = problems.migrateInlineHidden();
if (moved) log.info(`[migrate] 문제 ${moved}개의 히든 케이스를 테스트셋 파일로 옮겼습니다.`);
dispatcher.start();
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
