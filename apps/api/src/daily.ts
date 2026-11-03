import type { DailyAdminOverview, DailyBankCell, DailyInbox, DailyProblemDetail, DailyProblemStatus, DailyProblemSummary, DailySendResult, DailySettings, DailySettingsInput, DailySubscriber, DailyTopic, TestCase } from '@solveline/shared';
import type { DailyConfig } from './config.ts';
import { randomToken, sha256Hex } from './crypto.ts';
import { MailSendError, type MailSender, type OutgoingMail } from './mail-sender.ts';
import { stmt, type Sql } from './sql.ts';

// 일일 미니 문제: 구독자·문제은행·사람별 문제·발송 기록과 발송 한 번(tick). API(app.ts)와 발송 Worker(mailer-entry.ts)가 함께 쓴다.

/** 한 번에 보내는 수. 무료 Worker의 CPU 10ms 안에 만들 수 있게 작게 둔다 */
const BATCH_SIZE = 30;
/** 한 번에 새로 문제를 고르는 사람 수. 한 사람에 쿼리 3개라 무료 D1의 호출당 50쿼리 안에 든다 */
const PICK_BATCH = 10;
const MAX_ATTEMPTS = 3;
const CONFIRM_TTL_MS = 24 * 3_600_000;

const MAX_SUBSCRIBERS_FALLBACK = 90;
/** 메일·인박스에 넣는 설명 앞부분 길이 */
const EXCERPT_CHARS = 360;

/** 관리자가 주말에 보낼 때도 빠지지 않게 토·일 비트는 항상 켠다 */
const WEEKEND_BITS = 0b1100000;
const toWeekdayMask = (days: number[]) => days.reduce((mask, d) => mask | (1 << (d - 1)), WEEKEND_BITS);
const fromWeekdayMask = (mask: number) => [1, 2, 3, 4, 5].filter((d) => mask & (1 << (d - 1)));
/** 날짜의 요일 비트 위치(월 0 ~ 일 6) */
const weekdayBit = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
/** 그날 문제는 발송을 시작하는 07시(한국 시간)부터 인박스에 생긴다 */
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

/** 마크다운 설명의 앞부분을 평문으로 줄인다(코드 블록·표 기호는 뺀다) */
export function excerpt(markdown: string, max = EXCERPT_CHARS) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('\n'));
  return `${(end > max / 2 ? cut.slice(0, end + 1) : cut).trim()}…`;
}

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

/** 메일·인박스에 넣는 문제 내용 */
type MailProblem = { problem_id: string; title: string; description: string | null; topic: string; level: number; hint: string; hint_token: string };

const PROBLEM_COLUMNS = "p.title, json_extract(p.body, '$.description') AS description, b.topic, b.level, b.hint, b.hint_token";

/** 사람마다 문제를 받는 단위. 로그인 계정이면 계정, 아니면 구독자 */
const ownerOf = (s: { id: string; user_id: string | null }) => s.user_id ?? `s:${s.id}`;

// ─── 사람별 문제 고르기 ───

export type PickCandidate = { problem_id: string; topic: string; level: number };
export type PickStat = { topic: string; level: number; solved: number };

/** 문자열에서 0~1의 고정된 값(같은 사람·날짜면 같은 문제를 고른다) */
function jitter(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return (h >>> 0) / 2 ** 32;
}

const clampLevel = (n: number) => Math.min(5, Math.max(1, Math.round(n)));

/**
 * 다음 문제를 고른다. 정답률이 낮은 유형을 더 자주, 최근에 받은 유형은 덜 고르고,
 * 유형별로 잘 맞히면 한 단계 위, 자주 틀리면 한 단계 아래 난이도를 고른다. 처음 보는 유형은 맞힌 문제들의 평균 난이도에서 시작한다.
 */
export function pickProblem(candidates: PickCandidate[], stats: PickStat[], recentTopics: string[], seed: string): string | null {
  if (!candidates.length) return null;
  const byTopic = new Map<string, { tried: number; solved: number; top: number }>();
  for (const s of stats) {
    const t = byTopic.get(s.topic) ?? { tried: 0, solved: 0, top: 0 };
    t.tried++;
    if (s.solved) {
      t.solved++;
      t.top = Math.max(t.top, s.level);
    }
    byTopic.set(s.topic, t);
  }
  const solvedLevels = stats.filter((s) => s.solved).map((s) => s.level);
  const base = solvedLevels.length ? clampLevel(solvedLevels.reduce((a, b) => a + b, 0) / solvedLevels.length) : 1;
  const accuracy = (t: { tried: number; solved: number }) => (t.solved + 1) / (t.tried + 2);
  const target = (topic: string) => {
    const t = byTopic.get(topic);
    if (!t) return base;
    const acc = accuracy(t);
    const level = t.top || base;
    return clampLevel(acc >= 0.7 ? level + 1 : acc < 0.4 ? level - 1 : level);
  };
  const score = (c: PickCandidate) => {
    const t = byTopic.get(c.topic);
    const weakness = t ? 1 - accuracy(t) : 0.55;
    const recent = recentTopics[0] === c.topic ? 2 : recentTopics.includes(c.topic) ? 1 : 0;
    return weakness * 2 - recent - Math.abs(c.level - target(c.topic)) * 0.6 + jitter(`${seed}:${c.problem_id}`) * 0.5;
  };
  let best = candidates[0]!;
  let bestScore = score(best);
  for (const c of candidates.slice(1)) {
    const s = score(c);
    if (s > bestScore) [best, bestScore] = [c, s];
  }
  return best.problem_id;
}

/** 바인딩 수 제한 안에 들도록 나눈다 */
const chunks = <T>(items: T[], size = 50) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

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

  /** 받은 문제가 하나도 없는 사람(처음 구독한 날)인지 */
  async firstTime(userId: string) {
    return (await this.sql.value<number>('SELECT 1 FROM daily_picks WHERE owner = ? LIMIT 1', userId)) === undefined;
  }

  /**
   * 그날 문제를 정해 둔다(이미 있으면 그대로). 은행이 비었거나 다 받았으면 null.
   * 같은 사람의 같은 날짜는 언제 불러도 같은 문제다(메일과 인박스가 같은 문제를 보인다).
   */
  async ensurePick(owner: string, userId: string | null, date: string, now: number, ready?: PickCandidate[]): Promise<string | null> {
    const history = await this.sql.all<{ pick_date: string; problem_id: string; topic: string | null }>(
      'SELECT k.pick_date, k.problem_id, b.topic FROM daily_picks k LEFT JOIN daily_bank b ON b.problem_id = k.problem_id WHERE k.owner = ? ORDER BY k.pick_date DESC',
      owner,
    );
    const existing = history.find((h) => h.pick_date === date);
    if (existing) return existing.problem_id;
    const pool = ready ?? (await this.readyProblems());
    const stats = userId
      ? await this.sql.all<PickStat & { problem_id: string }>(
          `SELECT b.topic, b.level, s.problem_id, MAX(CASE WHEN s.score = 100 THEN 1 ELSE 0 END) AS solved
           FROM submissions s JOIN daily_bank b ON b.problem_id = s.problem_id
           WHERE s.user_id = ? AND s.kind = 'submit' AND s.status = 'done' GROUP BY s.problem_id`,
          userId,
        )
      : [];
    const seen = new Set([...history.map((h) => h.problem_id), ...stats.filter((s) => s.solved).map((s) => s.problem_id)]);
    const chosen = pickProblem(
      pool.filter((c) => !seen.has(c.problem_id)),
      stats,
      history.slice(0, 3).flatMap((h) => (h.topic ? [h.topic] : [])),
      `${owner}:${date}`,
    );
    if (!chosen) return null;
    await this.sql.run('INSERT OR IGNORE INTO daily_picks (owner, pick_date, problem_id, user_id, created_at) VALUES (?, ?, ?, ?, ?)', owner, date, chosen, userId, new Date(now).toISOString());
    return (await this.sql.value<string>('SELECT problem_id FROM daily_picks WHERE owner = ? AND pick_date = ?', owner, date)) ?? null;
  }

  readyProblems() {
    return this.sql.all<PickCandidate>("SELECT problem_id, topic, level FROM daily_bank WHERE status = 'ready'");
  }

  async inbox(userId: string, now: number): Promise<DailyInbox> {
    // 평일 07시가 지나면 그날 문제를 정해 둔다(메일을 끈 사람도 인박스로 받는다)
    const member = await this.member(userId);
    const opened = publishedThrough(now);
    if (member && !member.ended_date && opened >= member.started_date && weekdayBit(opened) < 5) await this.ensurePick(userId, userId, opened, now);
    const rows = await this.sql.all<MailProblem & { pick_date: string; read_at: string | null; best: number | null }>(
      `SELECT k.pick_date, k.problem_id, k.read_at, ${PROBLEM_COLUMNS},
         (SELECT MAX(s.score) FROM submissions s WHERE s.user_id = ? AND s.problem_id = k.problem_id AND s.kind = 'submit' AND s.status = 'done') AS best
       FROM daily_picks k JOIN problems p ON p.id = k.problem_id JOIN daily_bank b ON b.problem_id = k.problem_id
       WHERE k.owner = ? ORDER BY k.pick_date DESC LIMIT 60`,
      userId, userId,
    );
    const items = rows.map((r) => ({
      date: r.pick_date,
      problemId: r.problem_id,
      topic: r.topic as DailyTopic,
      level: r.level,
      title: r.title,
      excerpt: excerpt(r.description ?? ''),
      hint: r.hint,
      read: !!r.read_at,
      progress: r.best === 100 ? ('solved' as const) : r.best === null ? ('none' as const) : ('tried' as const),
    }));
    return { items, unread: items.filter((i) => !i.read).length };
  }

  async markRead(userId: string, date: string, now: number) {
    await this.sql.run('UPDATE daily_picks SET read_at = ? WHERE owner = ? AND pick_date = ? AND read_at IS NULL', new Date(now).toISOString(), userId, date);
  }

  async paused() {
    return (await this.sql.value<number>('SELECT paused FROM daily_settings WHERE id = 1')) === 1;
  }

  async setPaused(paused: boolean) {
    await this.sql.run('UPDATE daily_settings SET paused = ? WHERE id = 1', paused ? 1 : 0);
  }

  // ─── 문제은행 ───

  async bankCells(): Promise<DailyBankCell[]> {
    return this.sql.all<DailyBankCell>(
      `SELECT topic, level, SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready, SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft
       FROM daily_bank GROUP BY topic, level ORDER BY topic, level`,
    );
  }

  private summarySql(where: string) {
    return `SELECT b.problem_id AS id, b.topic, b.level, p.title, b.status, b.source, b.created_at AS createdAt,
        (SELECT COUNT(*) FROM daily_picks k WHERE k.problem_id = b.problem_id) AS picks,
        (SELECT COUNT(DISTINCT s.user_id) FROM submissions s WHERE s.problem_id = b.problem_id AND s.kind = 'submit' AND s.score = 100) AS solved
      FROM daily_bank b JOIN problems p ON p.id = b.problem_id ${where}`;
  }

  listProblems(filter: { topic?: string; status?: string; limit: number }): Promise<DailyProblemSummary[]> {
    return this.sql.all<DailyProblemSummary>(
      `${this.summarySql('WHERE (? IS NULL OR b.topic = ?) AND (? IS NULL OR b.status = ?)')} ORDER BY b.created_at DESC LIMIT ?`,
      filter.topic ?? null, filter.topic ?? null, filter.status ?? null, filter.status ?? null, filter.limit,
    );
  }

  async problem(id: string): Promise<DailyProblemDetail | null> {
    const row = await this.sql.get<DailyProblemSummary & { body: string; mode: DailyProblemDetail['mode']; hint: string }>(
      this.summarySql('WHERE b.problem_id = ?').replace('SELECT ', 'SELECT p.body, p.mode, b.hint, '),
      id,
    );
    if (!row) return null;
    const { body, ...rest } = row;
    const b = JSON.parse(body) as { description?: string; params?: string[]; timeLimitMs?: number; cases?: TestCase[]; code?: DailyProblemDetail['starterCode'] };
    return { ...rest, description: b.description ?? '', params: b.params ?? [], timeLimitMs: b.timeLimitMs ?? 10_000, cases: b.cases ?? [], starterCode: b.code ?? { java: '', python: '' } };
  }

  isBankProblem(id: string) {
    return this.sql.value<number>('SELECT 1 FROM daily_bank WHERE problem_id = ?', id).then((v) => v !== undefined);
  }

  /** 문제를 만드는 문과 한 번에 쓰도록 문으로 돌려준다(은행 행 없이 문제만 남으면 일반 목록에 보이므로) */
  addToBankStmt(id: string, meta: { topic: string; level: number; hint: string; status: DailyProblemStatus; source: string }, now: number) {
    const at = new Date(now).toISOString();
    return stmt(
      'INSERT INTO daily_bank (problem_id, topic, level, hint, hint_token, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, meta.topic, meta.level, meta.hint, crypto.randomUUID(), meta.status, meta.source, at, at,
    );
  }

  async updateBank(id: string, meta: { topic: string; level: number; hint: string; status: DailyProblemStatus }, now: number) {
    await this.sql.run('UPDATE daily_bank SET topic = ?, level = ?, hint = ?, status = ?, updated_at = ? WHERE problem_id = ?', meta.topic, meta.level, meta.hint, meta.status, new Date(now).toISOString(), id);
  }

  async setStatus(id: string, status: DailyProblemStatus, now: number) {
    return (await this.sql.run('UPDATE daily_bank SET status = ?, updated_at = ? WHERE problem_id = ?', status, new Date(now).toISOString(), id)).changes > 0;
  }

  /** 여러 문제의 상태를 한 번에 바꾼다. D1의 쿼리당 바인딩 수 제한(100) 때문에 나눠서 쓴다 */
  async setStatusMany(ids: string[], status: DailyProblemStatus, now: number) {
    const at = new Date(now).toISOString();
    const results = await this.sql.batch(
      chunks(ids).map((part) => stmt(`UPDATE daily_bank SET status = ?, updated_at = ? WHERE problem_id IN (${part.map(() => '?').join(',')})`, status, at, ...part)),
    );
    const changed = results.reduce((n, r) => n + r.changes, 0);
    return { changed, skipped: ids.length - changed };
  }

  /** 받은 사람이 없는 문제만 한꺼번에 지운다 */
  async deleteMany(ids: string[]) {
    const results = await this.sql.batch(
      chunks(ids).map((part) => {
        const marks = part.map(() => '?').join(',');
        return stmt(
          `DELETE FROM problems WHERE id IN (${marks}) AND id IN (SELECT problem_id FROM daily_bank) AND id NOT IN (SELECT problem_id FROM daily_picks)`,
          ...part,
        );
      }),
    );
    const changed = results.reduce((n, r) => n + r.changes, 0);
    return { changed, skipped: ids.length - changed };
  }

  /** 받은 사람이 없는 문제만 지운다(받은 문제는 retired로 둔다) */
  async deleteProblem(id: string) {
    const { changes } = await this.sql.run(
      'DELETE FROM problems WHERE id = ? AND EXISTS (SELECT 1 FROM daily_bank WHERE problem_id = ?) AND NOT EXISTS (SELECT 1 FROM daily_picks WHERE problem_id = ?)',
      id, id, id,
    );
    return changes > 0;
  }

  /** 메일의 "힌트 확인" 링크로 문제를 찾는다 */
  problemByHintToken(token: string) {
    return this.sql.get<{ title: string; hint: string }>('SELECT p.title, b.hint FROM daily_bank b JOIN problems p ON p.id = b.problem_id WHERE b.hint_token = ?', token);
  }

  mailProblem(id: string) {
    return this.sql.get<MailProblem>(`SELECT b.problem_id, ${PROBLEM_COLUMNS} FROM daily_bank b JOIN problems p ON p.id = b.problem_id WHERE b.problem_id = ?`, id);
  }

  /** 실패한 발송을 다시 대기열에 넣는다. 실패는 메일이 나가지 않은 경우뿐이다 */
  async retryFailed(date: string) {
    return (await this.sql.run("UPDATE daily_deliveries SET status = 'pending', attempts = 0, error = NULL WHERE pick_date = ? AND status = 'failed'", date)).changes;
  }

  async overview(config: DailyConfig | null, now: number): Promise<DailyAdminOverview> {
    const today = kstDate(now);
    const [subs, bank, counts, paused] = await Promise.all([
      this.sql.all<SubscriberRow>('SELECT * FROM daily_subscribers ORDER BY created_at DESC LIMIT 500'),
      this.bankCells(),
      this.sql.all<{ status: keyof DailyAdminOverview['delivery']; n: number }>('SELECT status, COUNT(*) AS n FROM daily_deliveries WHERE pick_date = ? GROUP BY status', today),
      this.paused(),
    ]);
    const delivery = { pending: 0, sent: 0, failed: 0, skipped: 0 };
    for (const c of counts) delivery[c.status] = c.n;
    return {
      configured: !!config,
      paused,
      maxSubscribers: config?.maxSubscribers ?? MAX_SUBSCRIBERS_FALLBACK,
      today,
      subscribers: subs.map((s) => ({ id: s.id, email: s.email, status: s.status, createdAt: s.created_at, confirmedAt: s.confirmed_at, endedAt: s.ended_at })),
      bank,
      delivery,
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

const unsubscribeUrlOf = (webOrigin: string, token: string) => `${webOrigin}/api/public/daily/unsubscribe?token=${encodeURIComponent(token)}`;

/** 문제 메일. unsubscribeUrl이 없으면 시험 발송이다(수신거부 대상이 아니다) */
export function problemMail(problem: MailProblem, opts: { from: string; to: string; webOrigin: string; date: string; unsubscribeUrl?: string; test?: boolean }): OutgoingMail {
  const problemUrl = `${opts.webOrigin}/#/p/${encodeURIComponent(problem.problem_id)}`;
  const prefix = opts.test ? '[시험] ' : '';
  const hintUrl = `${opts.webOrigin}/api/public/daily/hint?token=${encodeURIComponent(problem.hint_token)}`;
  const summary = excerpt(problem.description ?? '');
  const meta = `${problem.topic} · ${problem.level}단계`;
  // 메일 앱 대부분이 접기(details)를 지원하지 않아, 힌트는 본문에 넣지 않고 링크로 연다
  const hint = problem.hint
    ? `<div style="margin-top:28px;padding-top:22px;border-top:1px solid #ddd"><p style="margin:0;color:#444">막히는 부분이 있다면 힌트를 확인해 보세요.</p>${button(hintUrl, '힌트 확인', true)}</div>`
    : '';
  const footer = opts.unsubscribeUrl
    ? `<p style="margin:28px 0 0;font-size:12px;color:#666">Solveline 일일 문제를 구독해 주셔서 보내 드렸어요. 문제는 풀이 기록에 맞춰 사람마다 달라요. <a href="${escapeHtml(`${opts.webOrigin}/#/inbox`)}" style="color:#666">수신 설정</a> · <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#666">수신거부</a></p>`
    : '<p style="margin:28px 0 0;font-size:12px;color:#666">관리자가 보낸 시험 메일이에요.</p>';
  return {
    from: opts.from,
    to: opts.to,
    subject: `${prefix}[Solveline] ${problem.title}`,
    html: layout(`<div style="border-top:3px solid ${ACCENT};padding-top:18px"><p style="margin:0 0 8px;font-size:13px;font-weight:700;color:${ACCENT}">오늘의 문제</p><h1 style="margin:0 0 8px;font-size:23px;line-height:1.35">${escapeHtml(problem.title)}</h1><p style="margin:0 0 20px;font-size:13px;color:#666">${escapeHtml(opts.date)} · ${escapeHtml(meta)}</p></div>${paragraphs(summary)}${button(problemUrl, '바로 풀기')}${hint}${footer}`),
    text: [problem.title, meta, '', summary, '', `바로 풀기: ${problemUrl}`, ...(problem.hint ? [`힌트 확인: ${hintUrl}`] : []), ...(opts.unsubscribeUrl ? ['', `수신거부: ${opts.unsubscribeUrl}`] : [])].join('\n'),
    headers: opts.unsubscribeUrl ? { 'List-Unsubscribe': `<${opts.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : undefined,
  };
}

export function confirmMail(opts: { from: string; to: string; confirmUrl: string }): OutgoingMail {
  return {
    from: opts.from,
    to: opts.to,
    subject: '[Solveline] 일일 문제 구독을 확인해 주세요',
    html: layout(`<h1 style="margin:0 0 14px;font-size:21px">구독을 확인해 주세요</h1><p style="margin:0">아래 버튼을 눌러야 평일 아침마다 한 문제를 보내 드려요. 24시간 안에 눌러 주세요.</p>${button(opts.confirmUrl, '구독 확인하기')}<p style="margin:0;font-size:12px;color:#666">직접 신청하지 않았다면 이 메일을 무시해 주세요.</p>`),
    text: `아래 주소를 열어 구독을 확인해 주세요(24시간 안에).\n${opts.confirmUrl}\n\n직접 신청하지 않았다면 이 메일을 무시해 주세요.`,
  };
}

type TickDeps = { sql: Sql; sender: MailSender; from: string; webOrigin: string; now?: number; date?: string };
type Target = MailProblem & { id: string; email: string; unsubscribe_token: string; attempts: number };

const TARGET_SQL = `SELECT s.id, COALESCE(u.email, s.email) AS email, s.unsubscribe_token, d.attempts, d.problem_id, ${PROBLEM_COLUMNS}
  FROM daily_deliveries d JOIN daily_subscribers s ON s.id = d.subscriber_id
  JOIN problems p ON p.id = d.problem_id JOIN daily_bank b ON b.problem_id = d.problem_id
  LEFT JOIN users u ON u.id = s.user_id`;

/** 대기 중인 메일을 보내고 결과를 남긴다. 같은 묶음은 같은 key로 보내 중복 발송을 막는다 */
async function deliver(deps: TickDeps, date: string, now: number, targets: Target[]) {
  const { sql } = deps;
  const mails = targets.map((t) => problemMail(t, { from: deps.from, to: t.email, webOrigin: deps.webOrigin, date, unsubscribeUrl: unsubscribeUrlOf(deps.webOrigin, t.unsubscribe_token) }));
  const key = `daily-${date}-${(await sha256Hex(targets.map((t) => t.id).join(','))).slice(0, 32)}`;
  try {
    const ids = await deps.sender.sendBatch(mails, key);
    const at = new Date(now).toISOString();
    await sql.batch(targets.map((t, i) => stmt("UPDATE daily_deliveries SET status = 'sent', provider_id = ?, sent_at = ?, error = NULL WHERE pick_date = ? AND subscriber_id = ?", ids[i] ?? null, at, date, t.id)));
    return { sent: targets.length, failed: 0 };
  } catch (e) {
    const retryable = e instanceof MailSendError ? e.retryable : true;
    const message = e instanceof Error ? e.message.slice(0, 200) : '발송 실패';
    await sql.batch(targets.map((t) =>
      stmt('UPDATE daily_deliveries SET attempts = ?, status = ?, error = ? WHERE pick_date = ? AND subscriber_id = ?', t.attempts + 1, retryable && t.attempts + 1 < MAX_ATTEMPTS ? 'pending' : 'failed', message, date, t.id),
    ));
    return { sent: 0, failed: targets.length };
  }
}

/**
 * 발송 한 번. 아직 고르지 않은 구독자의 문제를 일부 정하고(PICK_BATCH), 대기 중인 메일을 일부 보낸다(BATCH_SIZE).
 * 몇 번을 실행해도 같은 사람에게 같은 날 두 번 보내지 않는다.
 */
export async function runDailyTick(deps: TickDeps): Promise<DailySendResult> {
  const { sql } = deps;
  const now = deps.now ?? Date.now();
  const date = deps.date ?? kstDate(now);
  const store = new DailyStore(sql);
  const done = (outcome: string, sent = 0, failed = 0, remaining = 0) => ({ outcome, sent, failed, remaining });
  if (await store.paused()) return done('paused');
  const ready = await store.readyProblems();
  if (!ready.length) return done('no_problems');

  const fresh = await sql.all<{ id: string; user_id: string | null }>(
    `SELECT s.id, s.user_id FROM daily_subscribers s WHERE s.status = 'active' AND (s.weekdays >> ?) & 1
     AND NOT EXISTS (SELECT 1 FROM daily_deliveries d WHERE d.pick_date = ? AND d.subscriber_id = s.id) ORDER BY s.id LIMIT ?`,
    weekdayBit(date), date, PICK_BATCH,
  );
  const queued = [];
  for (const s of fresh) {
    const problemId = await store.ensurePick(ownerOf(s), s.user_id, date, now, ready);
    // 받을 문제가 남지 않은 사람은 건너뛴다(관리자 화면의 '제외')
    queued.push(stmt('INSERT OR IGNORE INTO daily_deliveries (pick_date, subscriber_id, problem_id, status) VALUES (?, ?, ?, ?)', date, s.id, problemId, problemId ? 'pending' : 'skipped'));
  }
  // 대기 중에 수신거부·반송된 사람과 지워진 문제는 보내지 않는다
  queued.push(stmt(
    `UPDATE daily_deliveries SET status = 'skipped' WHERE pick_date = ? AND status = 'pending'
     AND (problem_id IS NULL OR subscriber_id NOT IN (SELECT id FROM daily_subscribers WHERE status = 'active'))`,
    date,
  ));
  await sql.batch(queued);

  const remaining = async () => (await sql.value<number>("SELECT COUNT(*) FROM daily_deliveries WHERE pick_date = ? AND status = 'pending'", date)) ?? 0;
  const targets = await sql.all<Target>(`${TARGET_SQL} WHERE d.pick_date = ? AND d.status = 'pending' ORDER BY s.id LIMIT ?`, date, BATCH_SIZE);
  if (!targets.length) return fresh.length ? done('picked', 0, 0, 0) : done('finished');
  const result = await deliver(deps, date, now, targets);
  return done(result.sent ? 'sent' : 'failed', result.sent, result.failed, await remaining());
}

/**
 * 처음 구독한 날: 다음 아침을 기다리지 않고 그날 문제를 바로 보낸다.
 * 발송 기록을 먼저 남기므로 07시 발송과 겹쳐도 두 번 보내지 않는다.
 */
export async function sendFirstProblem(deps: Omit<TickDeps, 'date'> & { userId: string }): Promise<boolean> {
  const { sql } = deps;
  const now = deps.now ?? Date.now();
  const date = kstDate(now);
  const store = new DailyStore(sql);
  if (await store.paused()) return false;
  const sub = await sql.get<{ id: string; user_id: string }>("SELECT id, user_id FROM daily_subscribers WHERE user_id = ? AND status = 'active'", deps.userId);
  if (!sub) return false;
  const problemId = await store.ensurePick(deps.userId, deps.userId, date, now);
  if (!problemId) return false;
  const { changes } = await sql.run("INSERT OR IGNORE INTO daily_deliveries (pick_date, subscriber_id, problem_id, status) VALUES (?, ?, ?, 'pending')", date, sub.id, problemId);
  if (!changes) return false;
  const targets = await sql.all<Target>(`${TARGET_SQL} WHERE d.pick_date = ? AND d.subscriber_id = ?`, date, sub.id);
  if (!targets.length) return false;
  return (await deliver(deps, date, now, targets)).sent > 0;
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
