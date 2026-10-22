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
registerSecret(config.accessPassword);
if (!config.accessPassword) log.warn('[config] ACCESS_PASSWORD가 없어 로그인할 수 없습니다.');

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
  log.info(`codetest-api :${port} (runners=${config.runnerUrls.join(',')} × ${config.runnerSlots})`),
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
