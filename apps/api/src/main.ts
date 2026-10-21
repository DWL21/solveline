import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { RunnerClient } from './runner.ts';
import { log, registerSecret } from './redact.ts';

const config = loadConfig();
registerSecret(config.sessionSecret);
registerSecret(config.accessPassword);
if (!config.accessPassword) log.warn('[config] ACCESS_PASSWORD가 없어 로그인할 수 없습니다.');

const db = openDb(config.dataDir);
const app = createApp({ config, db, runner: new RunnerClient(config.runnerUrl) });

const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => log.info(`codetest-api :${port} (runner=${config.runnerUrl})`));

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
