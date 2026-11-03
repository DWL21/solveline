import { dailyConfigFrom, runDailyTick } from './daily.ts';
import { log, registerSecret } from './redact.ts';
import { ResendSender } from './mail-sender.ts';
import { d1Sql, type D1Like } from './sql.ts';

// 일일 메일 발송 Worker(apps/mailer/wrangler.toml). 설정이 없으면 아무것도 보내지 않는다.
type MailerEnv = { DB: D1Like; WEB_ORIGIN: string } & Record<string, unknown>;

export default {
  async scheduled(_event: unknown, env: MailerEnv) {
    const config = dailyConfigFrom(env);
    if (!config) return;
    registerSecret(config.resendApiKey);
    const result = await runDailyTick({ sql: d1Sql(env.DB), sender: new ResendSender(config.resendApiKey), from: config.from, webOrigin: env.WEB_ORIGIN.replace(/\/$/, '') });
    log.info(`[daily] ${result.outcome}: 보냄 ${result.sent}, 실패 ${result.failed}, 남음 ${result.remaining}`);
  },
};
