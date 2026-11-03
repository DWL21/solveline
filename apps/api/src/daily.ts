import type { DailyAdminOverview, DailyInbox, DailyIssue, DailyIssueInput, DailySendResult, DailySettings, DailySettingsInput, DailySubscriber } from '@solveline/shared';
import type { DailyConfig } from './config.ts';
import { randomToken, sha256Hex } from './crypto.ts';
import { MailSendError, type MailSender, type OutgoingMail } from './mail-sender.ts';
import { stmt, type Sql } from './sql.ts';

// 일일 메일: 구독자·회차·발송 기록과 발송 한 번(tick). API(app.ts)와 발송 Worker(mailer-entry.ts)가 함께 쓴다.

/** 한 번에 보내는 수. 무료 Worker의 CPU 10ms 안에 만들 수 있게 작게 둔다 */
const BATCH_SIZE = 30;
const MAX_ATTEMPTS = 3;
const CONFIRM_TTL_MS = 24 * 3_600_000;

const MAX_SUBSCRIBERS_FALLBACK = 90;

/** 관리자가 주말 회차를 보낼 때도 빠지지 않게 토·일 비트는 항상 켠다 */
const WEEKEND_BITS = 0b1100000;
const toWeekdayMask = (days: number[]) => days.reduce((mask, d) => mask | (1 << (d - 1)), WEEKEND_BITS);
const fromWeekdayMask = (mask: number) => [1, 2, 3, 4, 5].filter((d) => mask & (1 << (d - 1)));
/** 회차 날짜의 요일 비트 위치(월 0 ~ 일 6) */
const weekdayBit = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
/** 그날 회차는 발송을 시작하는 07시(한국 시간)부터 인박스에 보인다 */
const publishedThrough = (now: number) => kstDate(now - 7 * 3_600_000);

type DailyUser = { id: string; email: string };

/** mailer Worker의 env에서 발송 설정을 읽는다(API의 loadConfig는 로그인 비밀까지 요구한다) */
export function dailyConfigFrom(env: Record<string, unknown>): DailyConfig | null {
  const str = (k: string) => (typeof env[k] === 'string' ? env[k].trim() : '') || null;
  const resendApiKey = str('RESEND_API_KEY');
  const from = str('DAILY_FROM');
  if (!resendApiKey || !from) return null;
  return { resendApiKey, from, webhookSecret: str('RESEND_WEBHOOK_SECRET'), maxSubscribers: Number(str('DAILY_MAX_SUBSCRIBERS')) || MAX_SUBSCRIBERS_FALLBACK };
}

/** 한국 시간 기준 날짜(YYYY-MM-DD) */
export const kstDate = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

type SubscriberRow = {
  id: string;
  email: string;
  status: DailySubscriber['status'];
  confirm_hash: string | null;
  confirm_expires_at: number | null;
  unsubscribe_token: string;
  created_at: string;
  confirmed_at: string | null;
  ended_at: string | null;
  user_id: string | null;
  weekdays: number;
};

type IssueRow = {
  issue_date: string;
  problem_id: string;
  title: string;
  body: string;
  difficulty: string;
  hint: string;
  hint_token: string;
  status: 'draft' | 'ready';
};

const toIssue = (r: IssueRow, delivery: DailyIssue['delivery']): DailyIssue => ({
  issueDate: r.issue_date,
  problemId: r.problem_id,
  title: r.title,
  body: r.body,
  difficulty: r.difficulty,
  hint: r.hint,
  status: r.status,
  delivery,
});

export class DailyStore {
  constructor(private sql: Sql) {}

  activeCount() {
    return this.sql.value<number>("SELECT COUNT(*) FROM daily_subscribers WHERE status = 'active'").then((n) => n ?? 0);
  }

  byEmail(email: string) {
    return this.sql.get<SubscriberRow>('SELECT * FROM daily_subscribers WHERE email = ?', email);
  }

  /** 인증 대기로 만들거나 되돌리고, 메일에 넣을 인증 토큰을 돌려준다 */
  async startPending(email: string, now: number) {
    const token = randomToken();
    const hash = await sha256Hex(token);
    await this.sql.run(
      `INSERT INTO daily_subscribers (id, email, status, confirm_hash, confirm_expires_at, unsubscribe_token, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET status = 'pending', confirm_hash = excluded.confirm_hash, confirm_expires_at = excluded.confirm_expires_at, ended_at = NULL`,
      crypto.randomUUID(), email, hash, now + CONFIRM_TTL_MS, randomToken(), new Date(now).toISOString(),
    );
    return token;
  }

  /** 상한을 넘기지 않을 때만 활성으로 바꾼다. 토큰이 틀리거나 만료면 invalid */
  async confirm(token: string, now: number, maxSubscribers: number): Promise<'confirmed' | 'invalid' | 'full'> {
    const hash = await sha256Hex(token);
    const row = await this.sql.get<SubscriberRow>("SELECT * FROM daily_subscribers WHERE confirm_hash = ? AND status = 'pending'", hash);
    if (!row || (row.confirm_expires_at ?? 0) < now) return 'invalid';
    const { changes } = await this.sql.run(
      `UPDATE daily_subscribers SET status = 'active', confirm_hash = NULL, confirm_expires_at = NULL, confirmed_at = ?
       WHERE id = ? AND (SELECT COUNT(*) FROM daily_subscribers WHERE status = 'active') < ?`,
      new Date(now).toISOString(), row.id, maxSubscribers,
    );
    return changes ? 'confirmed' : 'full';
  }

  async unsubscribe(token: string, now: number) {
    const { changes } = await this.sql.run(
      "UPDATE daily_subscribers SET status = 'unsubscribed', ended_at = ? WHERE unsubscribe_token = ? AND status IN ('active','pending')",
      new Date(now).toISOString(), token,
    );
    return changes > 0;
  }

  /** 반송·스팸 신고. 다시 구독 신청해도 메일을 보내지 않는다 */
  async stop(email: string, reason: 'bounced' | 'complained', now: number) {
    await this.sql.run('UPDATE daily_subscribers SET status = ?, ended_at = ? WHERE email = ?', reason, new Date(now).toISOString(), email);
  }

  async remove(id: string) {
    return (await this.sql.run('DELETE FROM daily_subscribers WHERE id = ?', id)).changes > 0;
  }

  /** 계정에 연결된 수신 주소. 로그인 전에 같은 주소로 구독했다면 그 기록을 쓴다 */
  private subscriberOf(user: DailyUser) {
    return this.sql.get<SubscriberRow>('SELECT * FROM daily_subscribers WHERE user_id = ? OR email = ? ORDER BY user_id IS NULL LIMIT 1', user.id, normalizeEmail(user.email));
  }

  private member(userId: string) {
    return this.sql.get<{ started_date: string; ended_date: string | null }>('SELECT started_date, ended_date FROM daily_members WHERE user_id = ?', userId);
  }

  async settings(user: DailyUser, config: DailyConfig | null): Promise<DailySettings> {
    const [member, sub] = await Promise.all([this.member(user.id), this.subscriberOf(user)]);
    return {
      email: user.email,
      subscribed: !!member && !member.ended_date,
      mail: sub?.status === 'active',
      mailAvailable: !!config,
      mailBlocked: sub?.status === 'bounced' || sub?.status === 'complained',
      weekdays: sub ? fromWeekdayMask(sub.weekdays) : [1, 2, 3, 4, 5],
    };
  }

  /** 구독(인박스)과 메일 수신을 함께 정한다. 계정 이메일은 로그인에서 인증되어 확인 메일을 보내지 않는다. 메일 자리가 없어도 인박스는 받을 수 있다 */
  async saveSettings(user: DailyUser, input: DailySettingsInput, config: DailyConfig | null, now: number): Promise<'ok' | 'full' | 'blocked'> {
    const today = kstDate(now);
    if (input.subscribed) {
      await this.sql.run('INSERT INTO daily_members (user_id, started_date) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET ended_date = NULL', user.id, today);
    } else {
      await this.sql.run('UPDATE daily_members SET ended_date = ? WHERE user_id = ? AND ended_date IS NULL', today, user.id);
    }
    const at = new Date(now).toISOString();
    const mask = toWeekdayMask(input.weekdays);
    const sub = await this.subscriberOf(user);
    if (!input.subscribed || !input.mail || !config) {
      if (sub) {
        await this.sql.run(
          `UPDATE daily_subscribers SET user_id = ?, weekdays = ?, confirm_hash = NULL, confirm_expires_at = NULL,
             ended_at = CASE WHEN status IN ('active','pending') THEN ? ELSE ended_at END,
             status = CASE WHEN status IN ('active','pending') THEN 'unsubscribed' ELSE status END
           WHERE id = ?`,
          user.id, mask, at, sub.id,
        );
      }
      return 'ok';
    }
    if (sub?.status === 'bounced' || sub?.status === 'complained') return 'blocked';
    if (sub?.status === 'active') {
      await this.sql.run('UPDATE daily_subscribers SET user_id = ?, weekdays = ? WHERE id = ?', user.id, mask, sub.id);
      return 'ok';
    }
    const seats = "(SELECT COUNT(*) FROM daily_subscribers WHERE status = 'active') < ?";
    const { changes } = sub
      ? await this.sql.run(
          `UPDATE daily_subscribers SET user_id = ?, weekdays = ?, status = 'active', confirm_hash = NULL, confirm_expires_at = NULL, confirmed_at = ?, ended_at = NULL WHERE id = ? AND ${seats}`,
          user.id, mask, at, sub.id, config.maxSubscribers,
        )
      : await this.sql.run(
          `INSERT INTO daily_subscribers (id, email, status, unsubscribe_token, created_at, confirmed_at, user_id, weekdays)
           SELECT ?, ?, 'active', ?, ?, ?, ?, ? WHERE ${seats}`,
          crypto.randomUUID(), normalizeEmail(user.email), randomToken(), at, at, user.id, mask, config.maxSubscribers,
        );
    return changes ? 'ok' : 'full';
  }

  /** 인박스 범위: 구독을 시작한 날부터 구독을 끝낸 날 또는 이미 열린 회차까지 */
  private async inboxRange(userId: string, now: number) {
    const member = await this.member(userId);
    if (!member) return null;
    const opened = publishedThrough(now);
    return { from: member.started_date, to: member.ended_date && member.ended_date < opened ? member.ended_date : opened };
  }

  async inbox(userId: string, now: number): Promise<DailyInbox> {
    const range = await this.inboxRange(userId, now);
    if (!range) return { items: [], unread: 0 };
    const rows = await this.sql.all<IssueRow & { read_at: string | null }>(
      `SELECT i.*, r.read_at FROM daily_issues i LEFT JOIN daily_inbox_reads r ON r.issue_date = i.issue_date AND r.user_id = ?
       WHERE i.status = 'ready' AND i.issue_date BETWEEN ? AND ? ORDER BY i.issue_date DESC LIMIT 60`,
      userId, range.from, range.to,
    );
    const items = rows.map((r) => ({ issueDate: r.issue_date, problemId: r.problem_id, title: r.title, body: r.body, difficulty: r.difficulty, hint: r.hint, read: !!r.read_at }));
    return { items, unread: items.filter((i) => !i.read).length };
  }

  /** 인박스에 보이는 회차만 읽음으로 남긴다 */
  async markRead(userId: string, date: string, now: number) {
    const range = await this.inboxRange(userId, now);
    if (!range) return;
    await this.sql.run(
      `INSERT OR IGNORE INTO daily_inbox_reads (user_id, issue_date, read_at)
       SELECT ?, issue_date, ? FROM daily_issues WHERE issue_date = ? AND status = 'ready' AND issue_date BETWEEN ? AND ?`,
      userId, new Date(now).toISOString(), date, range.from, range.to,
    );
  }

  async paused() {
    return (await this.sql.value<number>('SELECT paused FROM daily_settings WHERE id = 1')) === 1;
  }

  async setPaused(paused: boolean) {
    await this.sql.run('UPDATE daily_settings SET paused = ? WHERE id = 1', paused ? 1 : 0);
  }

  async saveIssue(date: string, input: DailyIssueInput, now: number) {
    const at = new Date(now).toISOString();
    await this.sql.run(
      `INSERT INTO daily_issues (issue_date, problem_id, title, body, difficulty, hint, hint_token, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (issue_date) DO UPDATE SET problem_id = excluded.problem_id, title = excluded.title, body = excluded.body,
         difficulty = excluded.difficulty, hint = excluded.hint, status = excluded.status, updated_at = excluded.updated_at`,
      date, input.problemId, input.title, input.body, input.difficulty, input.hint, crypto.randomUUID(), input.status, at, at,
    );
  }

  issue(date: string) {
    return this.sql.get<IssueRow>('SELECT * FROM daily_issues WHERE issue_date = ?', date);
  }

  /** 메일의 "힌트 확인" 링크로 회차를 찾는다 */
  issueByHintToken(token: string) {
    return this.sql.get<IssueRow>('SELECT * FROM daily_issues WHERE hint_token = ?', token);
  }

  /** 발송 기록이 있는 회차는 지우지 않는다(발송 현황을 남긴다) */
  async deleteIssue(date: string) {
    const { changes } = await this.sql.run(
      'DELETE FROM daily_issues WHERE issue_date = ? AND NOT EXISTS (SELECT 1 FROM daily_deliveries WHERE issue_date = ?)',
      date, date,
    );
    return changes > 0;
  }

  /** 실패한 발송을 다시 대기열에 넣는다. 실패는 메일이 나가지 않은 경우뿐이다 */
  async retryFailed(date: string) {
    return (await this.sql.run("UPDATE daily_deliveries SET status = 'pending', attempts = 0, error = NULL WHERE issue_date = ? AND status = 'failed'", date)).changes;
  }

  async overview(config: DailyConfig | null, now: number): Promise<DailyAdminOverview> {
    const [subs, issues, counts, paused] = await Promise.all([
      this.sql.all<SubscriberRow>('SELECT * FROM daily_subscribers ORDER BY created_at DESC LIMIT 500'),
      this.sql.all<IssueRow>('SELECT * FROM daily_issues ORDER BY issue_date DESC LIMIT 60'),
      this.sql.all<{ issue_date: string; status: keyof DailyIssue['delivery']; n: number }>(
        'SELECT issue_date, status, COUNT(*) AS n FROM daily_deliveries GROUP BY issue_date, status',
      ),
      this.paused(),
    ]);
    const deliveryOf = (date: string) => {
      const d = { pending: 0, sent: 0, failed: 0, skipped: 0 };
      for (const c of counts) if (c.issue_date === date) d[c.status] = c.n;
      return d;
    };
    return {
      configured: !!config,
      paused,
      maxSubscribers: config?.maxSubscribers ?? MAX_SUBSCRIBERS_FALLBACK,
      today: kstDate(now),
      subscribers: subs.map((s) => ({ id: s.id, email: s.email, status: s.status, createdAt: s.created_at, confirmedAt: s.confirmed_at, endedAt: s.ended_at })),
      issues: issues.map((i) => toIssue(i, deliveryOf(i.issue_date))),
    };
  }
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const paragraphs = (text: string) =>
  text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.65">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');

const layout = (body: string) =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"></head><body style="margin:0;background:#fff;color:#111"><div style="max-width:560px;margin:0 auto;padding:24px 20px;font:15px/1.6 -apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif">${body}</div></body></html>`;

const ACCENT = '#0066e0';

/** 메일 앱이 a의 여백을 잘라 내지 않게 표 칸에 배경과 여백을 준다. quiet는 테두리만 있는 보조 버튼이다 */
const button = (href: string, label: string, quiet = false) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;border-collapse:separate"><tr><td ${quiet ? '' : `bgcolor="${ACCENT}" `}style="padding:12px 22px;border-radius:6px;${quiet ? 'border:1px solid #111' : `background:${ACCENT}`}"><a href="${escapeHtml(href)}" style="color:${quiet ? '#111' : '#fff'};text-decoration:none;font-weight:700">${escapeHtml(label)}</a></td></tr></table>`;

/** 회차 메일. unsubscribeUrl이 없으면 시험 발송이다(수신거부 대상이 아니다) */
export function issueMail(issue: IssueRow, opts: { from: string; to: string; webOrigin: string; unsubscribeUrl?: string; test?: boolean }): OutgoingMail {
  const problemUrl = `${opts.webOrigin}/#/p/${encodeURIComponent(issue.problem_id)}`;
  const prefix = opts.test ? '[시험] ' : '';
  const hintUrl = `${opts.webOrigin}/api/public/daily/hint?token=${encodeURIComponent(issue.hint_token)}`;
  // 메일 앱 대부분이 접기(details)를 지원하지 않아, 힌트는 본문에 넣지 않고 링크로 연다
  const hint = issue.hint
    ? `<div style="margin-top:28px;padding-top:22px;border-top:1px solid #ddd"><p style="margin:0;color:#444">막히는 부분이 있다면 힌트를 확인해 보세요.</p>${button(hintUrl, '힌트 확인', true)}</div>`
    : '';
  const footer = opts.unsubscribeUrl
    ? `<p style="margin:28px 0 0;font-size:12px;color:#666">Solveline 일일 메일을 구독해 주셔서 보내 드렸어요. <a href="${escapeHtml(`${opts.webOrigin}/#/inbox`)}" style="color:#666">수신 설정</a> · <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#666">수신거부</a></p>`
    : '<p style="margin:28px 0 0;font-size:12px;color:#666">관리자가 보낸 시험 메일이에요.</p>';
  return {
    from: opts.from,
    to: opts.to,
    subject: `${prefix}[Solveline] ${issue.title}`,
    html: layout(`<div style="border-top:3px solid ${ACCENT};padding-top:18px"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:${ACCENT}">오늘의 문제</p><h1 style="margin:0 0 8px;font-size:23px;line-height:1.35">${escapeHtml(issue.title)}</h1><p style="margin:0 0 20px;font-size:13px;color:#666">${escapeHtml(issue.issue_date)} · ${escapeHtml(issue.difficulty)}</p></div>${paragraphs(issue.body)}${button(problemUrl, '바로 풀기')}${hint}${footer}`),
    text: [issue.title, issue.difficulty, '', issue.body, '', `바로 풀기: ${problemUrl}`, ...(issue.hint ? [`힌트 확인: ${hintUrl}`] : []), ...(opts.unsubscribeUrl ? ['', `수신거부: ${opts.unsubscribeUrl}`] : [])].join('\n'),
    headers: opts.unsubscribeUrl ? { 'List-Unsubscribe': `<${opts.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
  };
}

export function confirmMail(opts: { from: string; to: string; confirmUrl: string }): OutgoingMail {
  return {
    from: opts.from,
    to: opts.to,
    subject: '[Solveline] 일일 메일 구독을 확인해 주세요',
    html: layout(`<h1 style="margin:0 0 14px;font-size:21px">구독을 확인해 주세요</h1><p style="margin:0">아래 버튼을 눌러야 평일 아침마다 한 문제를 보내 드려요. 24시간 안에 눌러 주세요.</p>${button(opts.confirmUrl, '구독 확인하기')}<p style="margin:0;font-size:12px;color:#666">직접 신청하지 않았다면 이 메일을 무시해 주세요.</p>`),
    text: `아래 주소를 열어 구독을 확인해 주세요(24시간 안에).\n${opts.confirmUrl}\n\n직접 신청하지 않았다면 이 메일을 무시해 주세요.`,
  };
}

type TickDeps = { sql: Sql; sender: MailSender; from: string; webOrigin: string; now?: number; date?: string };

/**
 * 발송 한 번. 활성 구독자를 그날 회차의 대기열에 넣고 일부를 보낸다. 몇 번을 실행해도 같은 사람에게 두 번 보내지 않는다.
 * 묶음을 subscriber_id 순서로 고르므로, 보낸 뒤 기록하기 전에 멈춰도 같은 key로 다시 보내 중복 발송을 막는다.
 */
export async function runDailyTick(deps: TickDeps): Promise<DailySendResult> {
  const { sql } = deps;
  const now = deps.now ?? Date.now();
  const date = deps.date ?? kstDate(now);
  const store = new DailyStore(sql);
  const done = (outcome: string, sent = 0, failed = 0, remaining = 0) => ({ outcome, sent, failed, remaining });
  if (await store.paused()) return done('paused');
  const issue = await store.issue(date);
  if (issue?.status !== 'ready') return done('no_issue');

  await sql.batch([
    stmt("INSERT OR IGNORE INTO daily_deliveries (issue_date, subscriber_id, status) SELECT ?, id, 'pending' FROM daily_subscribers WHERE status = 'active' AND (weekdays >> ?) & 1", date, weekdayBit(date)),
    // 대기 중에 수신거부·반송된 사람은 보내지 않는다
    stmt(
      `UPDATE daily_deliveries SET status = 'skipped' WHERE issue_date = ? AND status = 'pending'
       AND subscriber_id NOT IN (SELECT id FROM daily_subscribers WHERE status = 'active')`,
      date,
    ),
  ]);
  const remaining = async () => (await sql.value<number>("SELECT COUNT(*) FROM daily_deliveries WHERE issue_date = ? AND status = 'pending'", date)) ?? 0;
  const targets = await sql.all<{ id: string; email: string; unsubscribe_token: string; attempts: number }>(
    `SELECT s.id, COALESCE(u.email, s.email) AS email, s.unsubscribe_token, d.attempts FROM daily_deliveries d JOIN daily_subscribers s ON s.id = d.subscriber_id
     LEFT JOIN users u ON u.id = s.user_id
     WHERE d.issue_date = ? AND d.status = 'pending' ORDER BY s.id LIMIT ?`,
    date, BATCH_SIZE,
  );
  if (!targets.length) return done('finished');

  const mails = targets.map((t) =>
    issueMail(issue, { from: deps.from, to: t.email, webOrigin: deps.webOrigin, unsubscribeUrl: `${deps.webOrigin}/api/public/daily/unsubscribe?token=${encodeURIComponent(t.unsubscribe_token)}` }),
  );
  const key = `daily-${date}-${(await sha256Hex(targets.map((t) => t.id).join(','))).slice(0, 32)}`;
  try {
    const ids = await deps.sender.sendBatch(mails, key);
    const at = new Date(now).toISOString();
    await sql.batch(targets.map((t, i) => stmt("UPDATE daily_deliveries SET status = 'sent', provider_id = ?, sent_at = ?, error = NULL WHERE issue_date = ? AND subscriber_id = ?", ids[i] ?? null, at, date, t.id)));
    return done('sent', targets.length, 0, await remaining());
  } catch (e) {
    const retryable = e instanceof MailSendError ? e.retryable : true;
    const message = e instanceof Error ? e.message.slice(0, 200) : '발송 실패';
    await sql.batch(targets.map((t) =>
      stmt('UPDATE daily_deliveries SET attempts = ?, status = ?, error = ? WHERE issue_date = ? AND subscriber_id = ?', t.attempts + 1, retryable && t.attempts + 1 < MAX_ATTEMPTS ? 'pending' : 'failed', message, date, t.id),
    ));
    return done('failed', 0, targets.length, await remaining());
  }
}

const decodeBase64 = (v: string) => Uint8Array.from(atob(v), (ch) => ch.charCodeAt(0));
const WEBHOOK_TOLERANCE_S = 300;

/** Resend(Svix) 웹훅 서명 확인: `id.timestamp.본문`의 HMAC-SHA256. 서명 값 중 하나만 맞으면 된다 */
export async function verifyWebhook(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: string, nowMs: number) {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_S) return false;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', decodeBase64(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  } catch {
    return false;
  }
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  for (const part of signature.split(' ')) {
    const value = part.split(',')[1];
    if (!value) continue;
    try {
      if (await crypto.subtle.verify('HMAC', key, decodeBase64(value), signed)) return true;
    } catch {
      // 잘못된 base64는 틀린 서명으로 본다
    }
  }
  return false;
}
