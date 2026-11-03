import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { DailyStore, dailyConfigFrom, kstDate, runDailyTick, verifyWebhook } from '../src/daily.ts';
import { openDb, type Db } from '../src/db-node.ts';
import { MailSendError, ResendSender, type MailSender, type OutgoingMail } from '../src/mail-sender.ts';
import { sqliteSql } from '../src/sql.ts';
import type { Judge } from '../src/judge.ts';

const ORIGIN = 'https://solveline.test';
const PASSWORD = 'p'.repeat(24);
// Svix 문서 형식의 시험 비밀(base64)
const WEBHOOK_SECRET = `whsec_${btoa('webhook-secret-for-test')}`;
const NOW = Date.UTC(2026, 10, 2, 22, 0, 0); // 2026-11-03 07:00 KST
const DATE = '2026-11-03';

class FakeSender implements MailSender {
  sent: OutgoingMail[] = [];
  keys: string[] = [];
  error: Error | null = null;
  async sendBatch(mails: OutgoingMail[], key: string) {
    if (this.error) throw this.error;
    this.sent.push(...mails);
    this.keys.push(key);
    return mails.map((_, i) => `id-${this.sent.length}-${i}`);
  }
}

const ISSUE = { problemId: 'daily-1', title: '두 수의 합', body: '정수 배열에서\n두 수를 찾으세요.', difficulty: '쉬움', hint: '', status: 'ready' as const };

let db: Db;
let sender: FakeSender;
let adminCookie = '';

function build(env: Record<string, string> = {}, mailSender: MailSender | null = sender) {
  const config = loadConfig({ WEB_ORIGIN: ORIGIN, SESSION_SECRET: 's'.repeat(40), ACCESS_PASSWORD: PASSWORD, RESEND_API_KEY: 'key', DAILY_FROM: 'Solveline <daily@solveline.test>', RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET, ...env });
  return createApp({ config, db, judge: {} as Judge, mailSender, now: () => NOW }).app;
}

const post = (body: unknown, ip = '1.1.1.1') => ({ method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) });

async function adminLogin(app: ReturnType<typeof build>) {
  const res = await app.request('/api/admin/login', post({ password: PASSWORD }));
  expect(res.status).toBe(200);
  adminCookie = res.headers.get('set-cookie')!.split(';')[0]!;
}

const admin = (method: string, body?: unknown) => ({ method, headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

/** 구독 신청 후 메일의 링크로 인증까지 마친다 */
async function subscribe(app: ReturnType<typeof build>, email: string, ip = '1.1.1.1') {
  const res = await app.request('/api/public/daily/subscribe', post({ email, consent: true }, ip));
  expect(res.status).toBe(200);
  const url = /api\/public\/daily\/confirm\?token=[^\s]+/.exec(sender.sent.at(-1)!.text)![0];
  return app.request(`/${url}`, { method: 'POST' });
}

const tick = (date = DATE) => runDailyTick({ sql: sqliteSql(db), sender, from: 'x@solveline.test', webOrigin: ORIGIN, now: NOW, date });
const status = (email: string) => db.prepare('SELECT status FROM daily_subscribers WHERE email = ?').pluck().get(email);
const saveIssue = (app: ReturnType<typeof build>, issue: object = ISSUE) => app.request(`/api/admin/daily/issues/${DATE}`, admin('PUT', issue));

beforeEach(() => {
  db = openDb(':memory:');
  sender = new FakeSender();
});

describe('일일 메일 구독', () => {
  it('설정이 없으면 구독을 받지 않는다', async () => {
    const app = build({ RESEND_API_KEY: '', DAILY_FROM: '' }, null);
    const res = await app.request('/api/public/daily/subscribe', post({ email: 'a@example.com', consent: true }));
    expect(res.status).toBe(503);
  });

  it('수신 동의가 없으면 거절한다', async () => {
    const res = await build().request('/api/public/daily/subscribe', post({ email: 'a@example.com', consent: false }));
    expect(res.status).toBe(400);
    expect(sender.sent).toHaveLength(0);
  });

  it('인증 전에는 발송 대상이 아니고, 링크를 열기만 해서는 인증되지 않는다', async () => {
    const app = build();
    await app.request('/api/public/daily/subscribe', post({ email: 'A@Example.com', consent: true }));
    expect(status('a@example.com')).toBe('pending');
    const url = /api\/public\/daily\/confirm\?token=[^\s]+/.exec(sender.sent[0]!.text)![0];
    expect((await app.request(`/${url}`)).status).toBe(200);
    expect(status('a@example.com')).toBe('pending');
    expect((await app.request(`/${url}`, { method: 'POST' })).status).toBe(200);
    expect(status('a@example.com')).toBe('active');
    expect((await app.request(`/${url}`, { method: 'POST' })).status).toBe(400);
  });

  it('이미 구독 중이면 같은 응답을 주고 메일을 보내지 않는다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    const before = sender.sent.length;
    const res = await app.request('/api/public/daily/subscribe', post({ email: 'a@example.com', consent: true }));
    expect(res.status).toBe(200);
    expect(sender.sent).toHaveLength(before);
  });

  it('상한에 도달하면 새 구독을 받지 않는다', async () => {
    const app = build({ DAILY_MAX_SUBSCRIBERS: '1' });
    await subscribe(app, 'a@example.com');
    const res = await app.request('/api/public/daily/subscribe', post({ email: 'b@example.com', consent: true }, '2.2.2.2'));
    expect(res.status).toBe(409);
  });

  it('두 사람이 동시에 대기 중이어도 인증 시점에 상한을 지킨다', async () => {
    const app = build({ DAILY_MAX_SUBSCRIBERS: '1' });
    await app.request('/api/public/daily/subscribe', post({ email: 'a@example.com', consent: true }));
    const first = /api\/public\/daily\/confirm\?token=[^\s]+/.exec(sender.sent[0]!.text)![0];
    await app.request('/api/public/daily/subscribe', post({ email: 'b@example.com', consent: true }));
    const second = /api\/public\/daily\/confirm\?token=[^\s]+/.exec(sender.sent[1]!.text)![0];
    expect((await app.request(`/${first}`, { method: 'POST' })).status).toBe(200);
    expect((await app.request(`/${second}`, { method: 'POST' })).status).toBe(409);
    expect(status('b@example.com')).toBe('pending');
  });

  it('IP별 신청 횟수를 제한한다', async () => {
    const app = build();
    for (let i = 0; i < 5; i++) await app.request('/api/public/daily/subscribe', post({ email: `u${i}@example.com`, consent: true }));
    const res = await app.request('/api/public/daily/subscribe', post({ email: 'u9@example.com', consent: true }));
    expect(res.status).toBe(429);
  });

  it('인증 메일은 전체 하루 10통까지만 보낸다', async () => {
    const app = build();
    for (let i = 0; i < 10; i++) expect((await app.request('/api/public/daily/subscribe', post({ email: `u${i}@example.com`, consent: true }, `3.3.3.${i}`))).status).toBe(200);
    const res = await app.request('/api/public/daily/subscribe', post({ email: 'u10@example.com', consent: true }, '4.4.4.4'));
    expect(res.status).toBe(429);
    expect(sender.sent).toHaveLength(10);
  });
});

describe('일일 메일 발송', () => {
  it('회차가 없거나 작성 중이면 보내지 않는다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    const before = sender.sent.length;
    expect((await tick()).outcome).toBe('no_issue');
    await adminLogin(app);
    await saveIssue(app, { ...ISSUE, status: 'draft' });
    expect((await tick()).outcome).toBe('no_issue');
    expect(sender.sent).toHaveLength(before);
  });

  it('여러 번 실행해도 같은 사람에게 한 번만 보내고, 원클릭 수신거부 헤더를 넣는다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    sender.sent = [];
    expect(await tick()).toMatchObject({ outcome: 'sent', sent: 1, remaining: 0 });
    expect((await tick()).outcome).toBe('finished');
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.to).toBe('a@example.com');
    expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.html).toContain(`${ORIGIN}/#/p/daily-1`);
  });

  it('문제 힌트은 메일 본문에 넣지 않고 링크로 연다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app, { ...ISSUE, hint: '해시맵으로 <O(n)>\n둘째 줄' });
    sender.sent = [];
    await tick();
    const mail = sender.sent[0]!;
    expect(mail.html).toContain('힌트 확인');
    expect(mail.html + mail.text).not.toContain('해시맵');
    expect(mail.html).not.toMatch(/약 \d+분/);

    const url = /api\/public\/daily\/hint\?token=[^\s]+/.exec(mail.text)![0];
    await saveIssue(app, { ...ISSUE, hint: '해시맵으로 <O(n)>\n둘째 줄' }); // 다시 저장해도 보낸 링크는 그대로 열린다
    const page = await app.request(`/${url}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('해시맵으로 &lt;O(n)&gt;<br>둘째 줄');
    expect((await app.request('/api/public/daily/hint?token=nope')).status).toBe(404);
  });

  it('힌트가 없는 회차에는 보기 링크를 넣지 않는다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    sender.sent = [];
    await tick();
    expect(sender.sent[0]!.html).not.toContain('힌트 확인');
  });

  it('메일 내용의 HTML을 이스케이프한다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app, { ...ISSUE, title: '<script>x</script>' });
    sender.sent = [];
    await tick();
    expect(sender.sent[0]!.html).not.toContain('<script>');
  });

  it('30명씩 나눠 보내고 묶음마다 다른 key를 쓴다', async () => {
    const app = build({ DAILY_MAX_SUBSCRIBERS: '100' });
    const insert = db.prepare("INSERT INTO daily_subscribers (id, email, status, unsubscribe_token, created_at) VALUES (?, ?, 'active', ?, 'now')");
    for (let i = 0; i < 35; i++) insert.run(`id${String(i).padStart(2, '0')}`, `u${i}@example.com`, `t${i}`);
    await adminLogin(app);
    await saveIssue(app);
    expect(await tick()).toMatchObject({ sent: 30, remaining: 5 });
    expect(await tick()).toMatchObject({ sent: 5, remaining: 0 });
    expect(new Set(sender.keys).size).toBe(2);
  });

  it('수신거부한 사람은 대기 중이어도 보내지 않는다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    db.prepare("INSERT INTO daily_deliveries (issue_date, subscriber_id, status) SELECT ?, id, 'pending' FROM daily_subscribers").run(DATE);
    const token = db.prepare('SELECT unsubscribe_token FROM daily_subscribers').pluck().get() as string;
    const res = await app.request(`/api/public/daily/unsubscribe?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(res.status).toBe(200);
    sender.sent = [];
    expect((await tick()).outcome).toBe('finished');
    expect(sender.sent).toHaveLength(0);
    expect(db.prepare('SELECT status FROM daily_deliveries').pluck().get()).toBe('skipped');
  });

  it('일시적 실패는 3번까지 재시도하고 같은 key를 쓰며, 영구 실패는 바로 멈춘다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    const delivery = () => db.prepare('SELECT status, attempts FROM daily_deliveries').get();
    sender.error = new MailSendError('Resend 응답 500', true);
    await tick();
    await tick();
    expect(delivery()).toEqual({ status: 'pending', attempts: 2 });
    await tick();
    expect(delivery()).toEqual({ status: 'failed', attempts: 3 });
    expect((await tick()).outcome).toBe('finished');

    db.prepare("UPDATE daily_deliveries SET status = 'pending', attempts = 0").run();
    sender.error = new MailSendError('Resend 응답 422', false);
    await tick();
    expect(delivery()).toEqual({ status: 'failed', attempts: 1 });
  });

  it('멈춤 상태면 보내지 않는다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    await app.request('/api/admin/daily/pause', admin('PUT', { paused: true }));
    expect((await tick()).outcome).toBe('paused');
  });

  it('날짜는 한국 시간 기준이다', () => {
    expect(kstDate(NOW)).toBe(DATE);
    expect(kstDate(Date.UTC(2026, 10, 2, 14, 59))).toBe('2026-11-02');
  });
});

describe('Resend 웹훅', () => {
  const sign = async (id: string, ts: string, body: string) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('webhook-secret-for-test'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`));
    return `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
  };
  const deliver = async (app: ReturnType<typeof build>, event: object, signature?: string) => {
    const body = JSON.stringify(event);
    const ts = String(Math.floor(NOW / 1000));
    return app.request('/api/public/daily/webhook/resend', { method: 'POST', headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': signature ?? (await sign('msg_1', ts, body)) }, body });
  };

  it('서명이 틀리면 거절한다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    const res = await deliver(app, { type: 'email.complained', data: { to: ['a@example.com'] } }, 'v1,AAAA');
    expect(res.status).toBe(401);
    expect(status('a@example.com')).toBe('active');
  });

  it('오래된 서명을 거절한다', async () => {
    const ok = await verifyWebhook(WEBHOOK_SECRET, { id: 'm', timestamp: String(NOW / 1000 - 1000), signature: await sign('m', String(NOW / 1000 - 1000), 'x') }, 'x', NOW);
    expect(ok).toBe(false);
  });

  it('스팸 신고와 영구 반송은 구독을 멈추고, 다시 신청해도 메일을 보내지 않는다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await subscribe(app, 'b@example.com');
    await deliver(app, { type: 'email.complained', data: { to: ['a@example.com'] } });
    await deliver(app, { type: 'email.bounced', data: { to: ['b@example.com'], bounce: { type: 'Permanent' } } });
    expect(status('a@example.com')).toBe('complained');
    expect(status('b@example.com')).toBe('bounced');
    const before = sender.sent.length;
    await app.request('/api/public/daily/subscribe', post({ email: 'a@example.com', consent: true }, '5.5.5.5'));
    expect(sender.sent).toHaveLength(before);
  });

  it('일시적 반송은 구독을 유지한다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await deliver(app, { type: 'email.bounced', data: { to: ['a@example.com'], bounce: { type: 'Temporary' } } });
    expect(status('a@example.com')).toBe('active');
  });
});

describe('관리자 일일 메일', () => {
  it('관리자 모드가 아니면 열 수 없다', async () => {
    expect((await build().request('/api/admin/daily')).status).toBe(401);
    expect((await build().request(`/api/admin/daily/issues/${DATE}/send`, { method: 'POST' })).status).toBe(401);
  });

  it('시험 발송은 지정한 주소로만 보내고 발송 기록을 남기지 않는다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app, { ...ISSUE, status: 'draft' });
    sender.sent = [];
    const res = await app.request(`/api/admin/daily/issues/${DATE}/test`, admin('POST', { emails: ['t1@example.com', 't2@example.com'] }));
    expect(res.status).toBe(200);
    expect(sender.sent.map((m) => m.to)).toEqual(['t1@example.com', 't2@example.com']);
    expect(sender.sent[0]!.subject).toContain('[시험]');
    expect(sender.sent[0]!.headers).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) FROM daily_deliveries').pluck().get()).toBe(0);
  });

  it('지금 보내기는 실패 건을 다시 시도하고 현황에 반영한다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    sender.error = new MailSendError('Resend 응답 422', false);
    await tick();
    sender.error = null;
    const res = await app.request(`/api/admin/daily/issues/${DATE}/send`, admin('POST'));
    expect(((await res.json()) as { data: { sent: number } }).data.sent).toBe(1);
    const overview = ((await (await app.request('/api/admin/daily', admin('GET'))).json()) as { data: { issues: { delivery: { sent: number; failed: number } }[] } }).data;
    expect(overview.issues[0]!.delivery).toMatchObject({ sent: 1, failed: 0 });
  });

  it('발송 기록이 있는 회차는 지울 수 없고, 구독자는 완전히 지운다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    await tick();
    expect((await app.request(`/api/admin/daily/issues/${DATE}`, admin('DELETE'))).status).toBe(409);
    const id = db.prepare('SELECT id FROM daily_subscribers').pluck().get() as string;
    expect((await app.request(`/api/admin/daily/subscribers/${id}`, admin('DELETE'))).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) FROM daily_subscribers').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM daily_deliveries').pluck().get()).toBe(0);
  });
});

describe('발송 설정과 Resend', () => {
  it('키와 보내는 사람이 함께 있어야 켜진다', () => {
    expect(dailyConfigFrom({ RESEND_API_KEY: 'k' })).toBeNull();
    expect(dailyConfigFrom({ RESEND_API_KEY: 'k', DAILY_FROM: 'a@b.c' })).toMatchObject({ maxSubscribers: 90 });
  });

  it('Resend 일괄 API를 호출하고 상태 코드로 재시도 여부를 나눈다', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const resend = new ResendSender('key', async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status });
    });
    const mail = { from: 'a@b.c', to: 'd@e.f', subject: 's', html: 'h', text: 't' };
    expect(await resend.sendBatch([mail], 'k1')).toEqual(['m1']);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails/batch');
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('k1');
    status = 429;
    await expect(resend.sendBatch([mail], 'k2')).rejects.toMatchObject({ retryable: true });
    status = 422;
    await expect(resend.sendBatch([mail], 'k3')).rejects.toMatchObject({ retryable: false });
  });
});

describe('로그인 사용자의 구독·인박스', () => {
  const TEST_TOKEN = 't'.repeat(24);
  const MAIL_ON = { subscribed: true, mail: true, weekdays: [1, 2, 3, 4, 5] };
  const buildUser = (env: Record<string, string> = {}) => build({ TEST_AUTH_TOKEN: TEST_TOKEN, ...env });

  async function login(app: ReturnType<typeof build>, email: string) {
    const res = await app.request('/api/test/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-auth': TEST_TOKEN }, body: JSON.stringify({ email }) });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0]!;
  }
  const me = (cookie: string, method = 'GET', body?: unknown) => ({ method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const put = (app: ReturnType<typeof build>, cookie: string, body: unknown) => app.request('/api/me/daily/settings', me(cookie, 'PUT', body));
  const settings = async (app: ReturnType<typeof build>, cookie: string) => ((await (await app.request('/api/me/daily/settings', me(cookie))).json()) as { data: Record<string, unknown> }).data;
  const inbox = async (app: ReturnType<typeof build>, cookie: string) => ((await (await app.request('/api/me/daily/inbox', me(cookie))).json()) as { data: { items: { issueDate: string; read: boolean }[]; unread: number } }).data;
  const saveAt = (app: ReturnType<typeof build>, date: string, issue: object = ISSUE) => app.request(`/api/admin/daily/issues/${date}`, admin('PUT', issue));

  it('비회원은 인박스와 수신 설정을 쓸 수 없다', async () => {
    const app = buildUser();
    expect((await app.request('/api/me/daily/inbox')).status).toBe(401);
    expect((await app.request('/api/me/daily/settings')).status).toBe(401);
  });

  it('계정 이메일로 확인 메일 없이 바로 구독한다. 도메인은 제한하지 않는다', async () => {
    const app = buildUser();
    const cookie = await login(app, 'user@company.example');
    await adminLogin(app);
    await saveIssue(app);
    expect((await put(app, cookie, MAIL_ON)).status).toBe(200);
    expect(sender.sent).toHaveLength(0);
    expect(await settings(app, cookie)).toMatchObject({ email: 'user@company.example', subscribed: true, mail: true });
    expect(await tick()).toMatchObject({ sent: 1 });
    expect(sender.sent[0]!.to).toBe('user@company.example');
    expect(sender.sent[0]!.html).toContain(`${ORIGIN}/#/inbox`);
  });

  it('입력으로 받는 주소를 바꿀 수 없다', async () => {
    const app = buildUser();
    const cookie = await login(app, 'a@example.com');
    await put(app, cookie, { ...MAIL_ON, email: 'other@example.com' });
    expect(status('other@example.com')).toBeUndefined();
    expect(status('a@example.com')).toBe('active');
  });

  it('메일을 꺼도 인박스는 받고, 고른 요일에만 메일을 보낸다', async () => {
    const app = buildUser();
    const cookie = await login(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    await put(app, cookie, { ...MAIL_ON, weekdays: [1] }); // 2026-11-03은 화요일
    expect(await tick()).toMatchObject({ sent: 0 });
    expect(sender.sent).toHaveLength(0);
    await saveAt(app, '2026-11-02');
    expect(await tick('2026-11-02')).toMatchObject({ sent: 1 });

    await put(app, cookie, { ...MAIL_ON, mail: false });
    expect(status('a@example.com')).toBe('unsubscribed');
    expect((await inbox(app, cookie)).items.map((i) => i.issueDate)).toEqual([DATE]);
    expect(await settings(app, cookie)).toMatchObject({ subscribed: true, mail: false });
  });

  it('메일의 수신거부는 메일만 끄고 구독은 남긴다', async () => {
    const app = buildUser();
    const cookie = await login(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    await put(app, cookie, MAIL_ON);
    await tick();
    const url = /api\/public\/daily\/unsubscribe\?token=[^\s]+/.exec(sender.sent[0]!.text)![0];
    await app.request(`/${url}`, { method: 'POST' });
    expect(await settings(app, cookie)).toMatchObject({ subscribed: true, mail: false });
    expect((await inbox(app, cookie)).items).toHaveLength(1);
  });

  it('인박스에는 구독 시작일부터 열린 회차만 보이고 읽음을 기억한다', async () => {
    const app = buildUser();
    const cookie = await login(app, 'a@example.com');
    await adminLogin(app);
    await saveAt(app, '2026-11-02'); // 구독 전
    await saveAt(app, DATE);
    await saveAt(app, '2026-11-04'); // 아직 안 열림
    expect((await inbox(app, cookie)).items).toEqual([]);
    await put(app, cookie, MAIL_ON);
    const before = await inbox(app, cookie);
    expect(before.items.map((i) => i.issueDate)).toEqual([DATE]);
    expect(before.unread).toBe(1);

    const userId = db.prepare('SELECT id FROM users WHERE email = ?').pluck().get('a@example.com') as string;
    expect((await new DailyStore(sqliteSql(db)).inbox(userId, NOW - 1)).items).toEqual([]); // 07시 전

    await app.request(`/api/me/daily/inbox/${DATE}/read`, me(cookie, 'POST'));
    await app.request('/api/me/daily/inbox/2026-11-04/read', me(cookie, 'POST')); // 안 열린 회차는 남기지 않는다
    expect(db.prepare('SELECT COUNT(*) FROM daily_inbox_reads').pluck().get()).toBe(1);
    expect(await inbox(app, cookie)).toMatchObject({ unread: 0, items: [{ read: true }] });

    await saveAt(app, DATE, { ...ISSUE, status: 'draft' });
    expect((await inbox(app, cookie)).items).toEqual([]);
  });

  it('구독을 그만두면 메일도 끄고, 다시 구독할 수 있다', async () => {
    const app = buildUser();
    const cookie = await login(app, 'a@example.com');
    await put(app, cookie, MAIL_ON);
    await put(app, cookie, { ...MAIL_ON, subscribed: false, mail: true });
    expect(status('a@example.com')).toBe('unsubscribed');
    expect(await settings(app, cookie)).toMatchObject({ subscribed: false, mail: false });
    await put(app, cookie, MAIL_ON);
    expect(status('a@example.com')).toBe('active');
  });

  it('로그인 전에 같은 주소로 구독했다면 그 기록에 연결한다', async () => {
    const app = buildUser();
    await subscribe(app, 'a@example.com');
    const cookie = await login(app, 'a@example.com');
    expect(await settings(app, cookie)).toMatchObject({ subscribed: false, mail: true });
    await put(app, cookie, MAIL_ON);
    expect(db.prepare('SELECT COUNT(*) FROM daily_subscribers').pluck().get()).toBe(1);
    expect(db.prepare('SELECT user_id FROM daily_subscribers').pluck().get()).toBeTruthy();
  });

  it('메일 자리가 없거나 반송된 주소면 거절하지만 인박스는 켠다', async () => {
    const app = buildUser({ DAILY_MAX_SUBSCRIBERS: '1' });
    await subscribe(app, 'first@example.com');
    const cookie = await login(app, 'a@example.com');
    const full = await put(app, cookie, MAIL_ON);
    expect(full.status).toBe(409);
    expect(await settings(app, cookie)).toMatchObject({ subscribed: true, mail: false });

    db.prepare("UPDATE daily_subscribers SET status = 'bounced' WHERE email = 'first@example.com'").run();
    const bounced = await login(app, 'first@example.com');
    expect((await put(app, bounced, MAIL_ON)).status).toBe(409);
    expect(await settings(app, bounced)).toMatchObject({ subscribed: true, mail: false, mailBlocked: true });
  });

  it('탈퇴하면 구독·읽음 기록을 함께 지운다', async () => {
    const app = buildUser();
    const cookie = await login(app, 'a@example.com');
    await adminLogin(app);
    await saveIssue(app);
    await put(app, cookie, MAIL_ON);
    await app.request(`/api/me/daily/inbox/${DATE}/read`, me(cookie, 'POST'));
    const userId = db.prepare('SELECT id FROM users WHERE email = ?').pluck().get('a@example.com') as string;
    expect((await app.request(`/api/admin/users/${userId}`, admin('DELETE'))).status).toBe(200);
    for (const table of ['daily_subscribers', 'daily_members', 'daily_inbox_reads']) expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
  });
});
