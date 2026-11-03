import { beforeEach, describe, expect, it } from 'vitest';
import { DAILY_BANK_PATH, judgeHeaders, type DailyProblemInput, type JudgeJob, type JudgeStatus, type TestCase } from '@solveline/shared';
import { handle, workerCaller } from '@solveline/judge/bank-mcp';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { dailyConfigFrom, excerpt, kstDate, pickProblem, runDailyTick, verifyWebhook } from '../src/daily.ts';
import { openDb, type Db } from '../src/db-node.ts';
import { MailSendError, ResendSender, type MailSender, type OutgoingMail } from '../src/mail-sender.ts';
import { sqliteSql } from '../src/sql.ts';
import type { Judge } from '../src/judge.ts';

const ORIGIN = 'https://solveline.test';
const PASSWORD = 'p'.repeat(24);
const JUDGE_SECRET = 'j'.repeat(40);
// Svix 문서 형식의 시험 비밀(base64)
const WEBHOOK_SECRET = `whsec_${btoa('webhook-secret-for-test')}`;
const NOW = Date.UTC(2026, 10, 2, 22, 0, 0); // 2026-11-03(화) 07:00 KST
const DATE = '2026-11-03';
const DAY = 86_400_000;

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

/** 기준 풀이 채점 흉내: 코드에 WRONG이 있으면 hidden 케이스를 틀린다 */
class FakeJudge {
  jobs: JudgeJob[] = [];
  testsets: TestCase[][] = [];
  async submit(job: JudgeJob): Promise<JudgeStatus> {
    this.jobs.push(job);
    const cases = job.cases ?? [];
    const wrong = job.code.includes('WRONG');
    const results = cases.map((c) => ({ id: c.id, status: wrong && c.hidden ? ('fail' as const) : ('pass' as const), actual: wrong && c.hidden ? '0' : c.expected, stdout: '', stderr: '', timeMs: 1, memoryMb: 1 }));
    const passed = results.filter((r) => r.status === 'pass').length;
    return { id: job.id, status: 'done', ahead: null, caseIds: cases.map((c) => c.id), result: { compile: { ok: true, output: '' }, results }, score: Math.round((passed / cases.length) * 100), error: null, finishedAt: 'now' };
  }
  async status() {
    return null;
  }
  async putTestset(cases: TestCase[]) {
    this.testsets.push(cases);
    return { hash: 'a'.repeat(64), count: cases.length };
  }
}

const problemInput = (over: Partial<DailyProblemInput> = {}): DailyProblemInput => ({
  topic: '해시',
  level: 1,
  title: '두 수의 합',
  description: '정수 배열에서 합이 target인 두 수의 위치를 찾는다.\n\n제한\n- 길이 ≤ 1000',
  mode: 'function',
  params: ['numbers', 'target'],
  timeLimitMs: 2000,
  cases: [
    { id: 'e1', args: ['[1,2,3]', '5'], stdin: '', expected: '[1,2]', hidden: false },
    { id: 'h1', args: ['[1,1]', '2'], stdin: '', expected: '[0,1]', hidden: true },
    { id: 'h2', args: ['[3,4]', '7'], stdin: '', expected: '[0,1]', hidden: true },
    { id: 'h3', args: ['[5,0,5]', '10'], stdin: '', expected: '[0,2]', hidden: true },
  ],
  starterCode: { java: 'class Solution {}', python: 'def solution(numbers, target):\n    return []\n' },
  referenceSolution: { language: 'python', code: 'def solution(numbers, target):\n    return [0, 1]\n' },
  hint: '',
  status: 'ready',
  ...over,
});

let db: Db;
let sender: FakeSender;
let judge: FakeJudge;
let adminCookie = '';

function build(env: Record<string, string> = {}, mailSender: MailSender | null = sender, now = NOW) {
  const config = loadConfig({ WEB_ORIGIN: ORIGIN, SESSION_SECRET: 's'.repeat(40), ACCESS_PASSWORD: PASSWORD, JUDGE_SECRET, RESEND_API_KEY: 'key', DAILY_FROM: 'Solveline <daily@solveline.test>', RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET, ...env });
  return createApp({ config, db, judge: judge as unknown as Judge, mailSender, now: () => now }).app;
}
type App = ReturnType<typeof build>;

const post = (body: unknown, ip = '1.1.1.1') => ({ method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) });

async function adminLogin(app: App) {
  const res = await app.request('/api/admin/login', post({ password: PASSWORD }));
  expect(res.status).toBe(200);
  adminCookie = res.headers.get('set-cookie')!.split(';')[0]!;
}

const admin = (method: string, body?: unknown) => ({ method, headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const data = async <T = Record<string, unknown>>(res: Response) => ((await res.json()) as { data: T }).data;

/** 관리자로 문제를 만들고 id를 돌려준다 */
async function addProblem(app: App, over: Partial<DailyProblemInput> = {}) {
  if (!adminCookie) await adminLogin(app);
  const r = await data<{ saved: boolean; id: string }>(await app.request('/api/admin/daily/problems', admin('POST', problemInput(over))));
  expect(r.saved).toBe(true);
  return r.id;
}

/** 구독 신청 후 메일의 링크로 인증까지 마친다 */
async function subscribe(app: App, email: string, ip = '1.1.1.1') {
  const res = await app.request('/api/public/daily/subscribe', post({ email, consent: true }, ip));
  expect(res.status).toBe(200);
  const url = /api\/public\/daily\/confirm\?token=[^\s]+/.exec(sender.sent.at(-1)!.text)![0];
  return app.request(`/${url}`, { method: 'POST' });
}

const tick = (date = DATE, now = NOW) => runDailyTick({ sql: sqliteSql(db), sender, from: 'x@solveline.test', webOrigin: ORIGIN, now, date });
const status = (email: string) => db.prepare('SELECT status FROM daily_subscribers WHERE email = ?').pluck().get(email);
const problemIdIn = (mail: OutgoingMail) => /#\/p\/([\w-]+)/.exec(mail.text)![1]!;

beforeEach(() => {
  db = openDb(':memory:');
  sender = new FakeSender();
  judge = new FakeJudge();
  adminCookie = '';
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

  it('상한에 도달하면 새 구독을 받지 않고, 동시에 대기 중이어도 인증 시점에 상한을 지킨다', async () => {
    const app = build({ DAILY_MAX_SUBSCRIBERS: '1' });
    await app.request('/api/public/daily/subscribe', post({ email: 'a@example.com', consent: true }));
    const first = /api\/public\/daily\/confirm\?token=[^\s]+/.exec(sender.sent[0]!.text)![0];
    await app.request('/api/public/daily/subscribe', post({ email: 'b@example.com', consent: true }));
    const second = /api\/public\/daily\/confirm\?token=[^\s]+/.exec(sender.sent[1]!.text)![0];
    expect((await app.request(`/${first}`, { method: 'POST' })).status).toBe(200);
    expect((await app.request(`/${second}`, { method: 'POST' })).status).toBe(409);
    expect((await app.request('/api/public/daily/subscribe', post({ email: 'c@example.com', consent: true }, '2.2.2.2'))).status).toBe(409);
  });

  it('IP별 신청 횟수와 하루 인증 메일 수를 제한한다', async () => {
    const app = build();
    for (let i = 0; i < 5; i++) await app.request('/api/public/daily/subscribe', post({ email: `u${i}@example.com`, consent: true }));
    expect((await app.request('/api/public/daily/subscribe', post({ email: 'u9@example.com', consent: true }))).status).toBe(429);
    for (let i = 10; i < 15; i++) expect((await app.request('/api/public/daily/subscribe', post({ email: `u${i}@example.com`, consent: true }, `3.3.3.${i}`))).status).toBe(200);
    expect((await app.request('/api/public/daily/subscribe', post({ email: 'u20@example.com', consent: true }, '4.4.4.4'))).status).toBe(429);
    expect(sender.sent).toHaveLength(10);
  });
});

describe('문제 고르기', () => {
  const c = (id: string, topic: string, level: number) => ({ problem_id: id, topic, level });

  it('정답률이 낮은 유형을 고르고, 바로 전에 받은 유형은 피한다', () => {
    const cands = [c('hash', '해시', 2), c('dp', '동적 계획법', 2)];
    const stats = [
      { topic: '해시', level: 2, solved: 1 },
      { topic: '해시', level: 2, solved: 1 },
      { topic: '동적 계획법', level: 2, solved: 0 },
      { topic: '동적 계획법', level: 2, solved: 0 },
    ];
    expect(pickProblem(cands, stats, [], 'seed')).toBe('dp');
    expect(pickProblem(cands, stats, ['동적 계획법'], 'seed')).toBe('hash');
  });

  it('잘 맞히는 유형은 한 단계 위, 자주 틀리는 유형은 한 단계 아래를 고른다', () => {
    const hash = [c('h1', '해시', 1), c('h3', '해시', 3), c('h5', '해시', 5)];
    const good = [1, 2, 2].map((level) => ({ topic: '해시', level, solved: 1 }));
    expect(pickProblem(hash, good, [], 's')).toBe('h3');
    const bad = [{ topic: '해시', level: 4, solved: 1 }, ...[3, 3, 3].map((level) => ({ topic: '해시', level, solved: 0 }))];
    expect(pickProblem(hash, bad, [], 's')).toBe('h3');
    expect(pickProblem([], good, [], 's')).toBeNull();
  });

  it('설명의 앞부분만 평문으로 줄인다', () => {
    expect(excerpt('## 문제\n**굵게** `코드`\n```\nx\n```\n끝')).toBe('문제\n굵게 코드\n\n끝');
    expect(excerpt('가'.repeat(500)).length).toBeLessThanOrEqual(361);
  });
});

describe('문제은행', () => {
  it('기준 풀이가 틀리면 저장하지 않고 틀린 케이스를 돌려준다', async () => {
    const app = build();
    await adminLogin(app);
    const r = await data<{ saved: boolean; verify: { score: number; failures: { id: string; expected: string }[] } }>(
      await app.request('/api/admin/daily/problems', admin('POST', problemInput({ referenceSolution: { language: 'python', code: '# WRONG' } }))),
    );
    expect(r.saved).toBe(false);
    expect(r.verify.score).toBe(25);
    expect(r.verify.failures.map((f) => f.id)).toEqual(['h1', 'h2', 'h3']);
    expect(db.prepare('SELECT COUNT(*) FROM problems').pluck().get()).toBe(0);
  });

  it('예제·채점 케이스 수가 모자라면 형식 오류다', async () => {
    const app = build();
    await adminLogin(app);
    const res = await app.request('/api/admin/daily/problems', admin('POST', problemInput({ cases: problemInput().cases.map((x) => ({ ...x, hidden: false })) })));
    expect(res.status).toBe(400);
  });

  it('저장한 문제는 채점 케이스를 judge에 두고, 일반 목록·카탈로그에는 없지만 링크로 열린다', async () => {
    const app = build();
    const id = await addProblem(app);
    expect(judge.jobs[0]!.cases).toHaveLength(4);
    expect(judge.testsets[0]!.map((x) => x.id)).toEqual(['h1', 'h2', 'h3']);
    expect((await data<{ id: string }[]>(await app.request('/api/problems'))).map((p) => p.id)).not.toContain(id);
    expect((await data<{ problems: { id: string }[] }>(await app.request('/api/catalog/index'))).problems.map((p) => p.id)).not.toContain(id);
    const p = await data<{ cases: TestCase[]; hiddenTestset: { hash: string } }>(await app.request(`/api/public/daily/problems/${id}`));
    expect(p.cases.map((x) => x.id)).toEqual(['e1']);
    expect(p.hiddenTestset.hash).toBe('a'.repeat(64));
    expect((await app.request('/api/public/daily/problems/nope')).status).toBe(404);
  });

  it('받은 사람이 있는 문제는 지우지 못하고, 그만 보내면 더 고르지 않는다', async () => {
    const app = build();
    const id = await addProblem(app);
    await subscribe(app, 'a@example.com');
    await tick();
    expect((await app.request(`/api/admin/daily/problems/${id}`, admin('DELETE'))).status).toBe(409);
    expect((await app.request(`/api/admin/daily/problems/${id}/status`, admin('PUT', { status: 'retired' }))).status).toBe(200);
    expect((await tick('2026-11-04', NOW + DAY)).outcome).toBe('no_problems');
    const unused = await addProblem(app, { title: '다른 문제', status: 'draft' });
    expect((await app.request(`/api/admin/daily/problems/${unused}`, admin('DELETE'))).status).toBe(200);
  });
});

describe('일일 메일 발송', () => {
  it('문제가 없으면 보내지 않는다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    expect((await tick()).outcome).toBe('no_problems');
    await addProblem(app, { status: 'draft' });
    expect((await tick()).outcome).toBe('no_problems');
  });

  it('여러 번 실행해도 같은 날 한 번만 보내고, 다음 날에는 받은 적 없는 문제를 보낸다', async () => {
    const app = build();
    await addProblem(app, { title: '문제 A' });
    await addProblem(app, { title: '문제 B', topic: '그리디' });
    await subscribe(app, 'a@example.com');
    sender.sent = [];
    expect(await tick()).toMatchObject({ outcome: 'sent', sent: 1, remaining: 0 });
    expect((await tick()).outcome).toBe('finished');
    expect(sender.sent).toHaveLength(1);
    const mail = sender.sent[0]!;
    expect(mail.to).toBe('a@example.com');
    expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.html).toContain('1단계');
    await tick('2026-11-04', NOW + DAY);
    expect(sender.sent).toHaveLength(2);
    expect(problemIdIn(sender.sent[1]!)).not.toBe(problemIdIn(mail));
    expect((await tick('2026-11-05', NOW + 2 * DAY)).outcome).toBe('picked'); // 다 받았으면 건너뛴다
    expect(db.prepare("SELECT status FROM daily_deliveries WHERE pick_date = '2026-11-05'").pluck().get()).toBe('skipped');
  });

  it('힌트는 메일 본문에 넣지 않고 링크로 연다', async () => {
    const app = build();
    await addProblem(app, { hint: '해시맵으로 <O(n)>\n둘째 줄' });
    await subscribe(app, 'a@example.com');
    sender.sent = [];
    await tick();
    const mail = sender.sent[0]!;
    expect(mail.html).toContain('힌트 확인');
    expect(mail.html + mail.text).not.toContain('해시맵');
    const url = /api\/public\/daily\/hint\?token=[^\s]+/.exec(mail.text)![0];
    const page = await app.request(`/${url}`);
    expect(await page.text()).toContain('해시맵으로 &lt;O(n)&gt;<br>둘째 줄');
    expect((await app.request('/api/public/daily/hint?token=nope')).status).toBe(404);
  });

  it('메일 내용의 HTML을 이스케이프한다', async () => {
    const app = build();
    await addProblem(app, { title: '<script>x</script>' });
    await subscribe(app, 'a@example.com');
    sender.sent = [];
    await tick();
    expect(sender.sent[0]!.html).not.toContain('<script>');
  });

  it('여러 번에 나눠 고르고 보내며, 묶음마다 다른 key를 쓴다', async () => {
    const app = build({ DAILY_MAX_SUBSCRIBERS: '100' });
    await addProblem(app);
    const insert = db.prepare("INSERT INTO daily_subscribers (id, email, status, unsubscribe_token, created_at) VALUES (?, ?, 'active', ?, 'now')");
    for (let i = 0; i < 35; i++) insert.run(`id${String(i).padStart(2, '0')}`, `u${i}@example.com`, `t${i}`);
    for (let i = 0; i < 6 && (await tick()).outcome !== 'finished'; i++);
    expect(sender.sent).toHaveLength(35);
    expect(new Set(sender.sent.map((m) => m.to)).size).toBe(35);
    expect(new Set(sender.keys).size).toBe(sender.keys.length);
  });

  it('수신거부한 사람은 대기 중이어도 보내지 않는다', async () => {
    const app = build();
    const id = await addProblem(app);
    await subscribe(app, 'a@example.com');
    db.prepare("INSERT INTO daily_deliveries (pick_date, subscriber_id, problem_id, status) SELECT ?, id, ?, 'pending' FROM daily_subscribers").run(DATE, id);
    const token = db.prepare('SELECT unsubscribe_token FROM daily_subscribers').pluck().get() as string;
    await app.request(`/api/public/daily/unsubscribe?token=${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    sender.sent = [];
    expect((await tick()).outcome).toBe('finished');
    expect(sender.sent).toHaveLength(0);
    expect(db.prepare('SELECT status FROM daily_deliveries').pluck().get()).toBe('skipped');
  });

  it('일시적 실패는 3번까지 재시도하고, 영구 실패는 바로 멈추며, 지금 보내기가 실패 건을 다시 보낸다', async () => {
    const app = build();
    await addProblem(app);
    await subscribe(app, 'a@example.com');
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

    sender.error = null;
    expect(await data(await app.request('/api/admin/daily/send', admin('POST')))).toMatchObject({ sent: 1 });
    expect((await data<{ delivery: { sent: number } }>(await app.request('/api/admin/daily', admin('GET')))).delivery.sent).toBe(1);
  });

  it('멈춤 상태면 보내지 않는다', async () => {
    const app = build();
    await addProblem(app);
    await subscribe(app, 'a@example.com');
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
  const deliver = async (app: App, event: object, signature?: string) => {
    const body = JSON.stringify(event);
    const ts = String(Math.floor(NOW / 1000));
    return app.request('/api/public/daily/webhook/resend', { method: 'POST', headers: { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': signature ?? (await sign('msg_1', ts, body)) }, body });
  };

  it('서명이 틀리거나 오래되면 거절한다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    expect((await deliver(app, { type: 'email.complained', data: { to: ['a@example.com'] } }, 'v1,AAAA')).status).toBe(401);
    expect(status('a@example.com')).toBe('active');
    const old = String(NOW / 1000 - 1000);
    expect(await verifyWebhook(WEBHOOK_SECRET, { id: 'm', timestamp: old, signature: await sign('m', old, 'x') }, 'x', NOW)).toBe(false);
  });

  it('스팸 신고와 영구 반송은 구독을 멈추고, 일시적 반송은 유지한다', async () => {
    const app = build();
    await subscribe(app, 'a@example.com');
    await subscribe(app, 'b@example.com');
    await subscribe(app, 'c@example.com');
    await deliver(app, { type: 'email.complained', data: { to: ['a@example.com'] } });
    await deliver(app, { type: 'email.bounced', data: { to: ['b@example.com'], bounce: { type: 'Permanent' } } });
    await deliver(app, { type: 'email.bounced', data: { to: ['c@example.com'], bounce: { type: 'Temporary' } } });
    expect([status('a@example.com'), status('b@example.com'), status('c@example.com')]).toEqual(['complained', 'bounced', 'active']);
    const before = sender.sent.length;
    await app.request('/api/public/daily/subscribe', post({ email: 'a@example.com', consent: true }, '5.5.5.5'));
    expect(sender.sent).toHaveLength(before);
  });
});

describe('관리자 일일 메일', () => {
  it('관리자 모드가 아니면 열 수 없다', async () => {
    const app = build();
    expect((await app.request('/api/admin/daily')).status).toBe(401);
    expect((await app.request('/api/admin/daily/send', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/admin/daily/problems', post(problemInput()))).status).toBe(401);
  });

  it('시험 발송은 지정한 주소로만 보내고 발송 기록을 남기지 않는다', async () => {
    const app = build();
    const id = await addProblem(app, { status: 'draft' });
    const res = await app.request(`/api/admin/daily/problems/${id}/test`, admin('POST', { emails: ['t1@example.com', 't2@example.com'] }));
    expect(res.status).toBe(200);
    expect(sender.sent.map((m) => m.to)).toEqual(['t1@example.com', 't2@example.com']);
    expect(sender.sent[0]!.subject).toContain('[시험]');
    expect(sender.sent[0]!.headers).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) FROM daily_deliveries').pluck().get()).toBe(0);
  });

  it('고른 문제들의 상태를 한 번에 바꾸고, 받은 사람이 없는 문제만 한꺼번에 지운다', async () => {
    const app = build();
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await addProblem(app, { title: `문제 ${i}` }));
    await subscribe(app, 'a@example.com');
    await tick(); // 셋 중 하나를 받는다
    const picked = db.prepare('SELECT problem_id FROM daily_picks').pluck().get() as string;
    expect(await data(await app.request('/api/admin/daily/problems-bulk/status', admin('PUT', { ids: [...ids, 'nope'], status: 'draft' })))).toEqual({ changed: 3, skipped: 1 });
    expect(db.prepare("SELECT COUNT(*) FROM daily_bank WHERE status = 'draft'").pluck().get()).toBe(3);
    expect(await data(await app.request('/api/admin/daily/problems-bulk/delete', admin('POST', { ids })))).toEqual({ changed: 2, skipped: 1 });
    expect(db.prepare('SELECT problem_id FROM daily_bank').pluck().all()).toEqual([picked]);
    expect((await app.request('/api/admin/daily/problems-bulk/delete', admin('POST', { ids: [] }))).status).toBe(400);
    expect((await app.request('/api/admin/daily/problems-bulk/status', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, status: 'ready' }) })).status).toBe(401);
  });

  it('한 번에 100개가 넘는 문제도 나눠서 바꾼다', async () => {
    const app = build();
    await adminLogin(app);
    const insertP = db.prepare("INSERT INTO problems (id, title, folder_id, mode, language, body, created_at, updated_at) VALUES (?, 't', NULL, 'function', 'python', '{}', 'now', 'now')");
    const insertB = db.prepare("INSERT INTO daily_bank (problem_id, topic, level, hint, hint_token, status, source, created_at, updated_at) VALUES (?, '해시', 1, '', ?, 'ready', 'admin', 'now', 'now')");
    const ids = Array.from({ length: 120 }, (_, i) => `p${i}`);
    for (const id of ids) {
      insertP.run(id);
      insertB.run(id, `t-${id}`);
    }
    expect(await data(await app.request('/api/admin/daily/problems-bulk/status', admin('PUT', { ids, status: 'retired' })))).toEqual({ changed: 120, skipped: 0 });
    expect(await data(await app.request('/api/admin/daily/problems-bulk/delete', admin('POST', { ids })))).toEqual({ changed: 120, skipped: 0 });
  });

  it('현황에 유형·난이도별 문제 수와 문제 목록을 보여 주고, 구독자는 완전히 지운다', async () => {
    const app = build();
    await addProblem(app);
    await addProblem(app, { title: '작성 중', status: 'draft' });
    await subscribe(app, 'a@example.com');
    await tick();
    const ov = await data<{ bank: unknown[] }>(await app.request('/api/admin/daily', admin('GET')));
    expect(ov.bank).toEqual([{ topic: '해시', level: 1, ready: 1, draft: 1 }]);
    const list = await data<{ title: string; picks: number; source: string }[]>(await app.request('/api/admin/daily/problems', admin('GET')));
    expect(list.map((p) => [p.title, p.picks, p.source]).sort()).toEqual([['두 수의 합', 1, 'admin'], ['작성 중', 0, 'admin']]);
    const id = db.prepare('SELECT id FROM daily_subscribers').pluck().get() as string;
    expect((await app.request(`/api/admin/daily/subscribers/${id}`, admin('DELETE'))).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) FROM daily_deliveries').pluck().get()).toBe(0);
  });
});

describe('문제은행 에이전트(MCP)', () => {
  const call = async (app: App, tool: string, args: unknown, secret = JUDGE_SECRET) => {
    const body = JSON.stringify({ agent: 'codex', tool, args });
    return app.request(DAILY_BANK_PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...(await judgeHeaders(secret, 'POST', DAILY_BANK_PATH, body, NOW)) }, body });
  };

  it('judge 비밀로 서명하지 않은 호출은 거절한다', async () => {
    const app = build();
    expect((await app.request(DAILY_BANK_PATH, post({ agent: 'codex', tool: 'bank_overview', args: {} }))).status).toBe(401);
    expect((await call(app, 'bank_overview', {}, 'x'.repeat(40))).status).toBe(401);
  });

  it('지침·현황을 읽고 문제를 만들며, 만든 곳을 agent:<이름>으로 남긴다', async () => {
    const app = build();
    expect(await data(await call(app, 'bank_guide', {}))).toMatchObject({ guide: expect.stringContaining('학습 목표 개념'), workflow: expect.stringContaining('요청받은 수만큼') });
    const saved = await data<{ saved: boolean; id: string }>(await call(app, 'create_problem', problemInput({ topic: '그리디', level: 2 })));
    expect(saved.saved).toBe(true);
    const ov = await data<{ cells: { topic: string; level: number; ready: number }[]; emptiest: unknown[]; totalReady: number }>(await call(app, 'bank_overview', {}));
    expect(ov.cells).toHaveLength(14 * 5);
    expect(ov.cells.find((c) => c.topic === '그리디' && c.level === 2)).toMatchObject({ ready: 1, draft: 0 });
    expect(ov.totalReady).toBe(1);
    expect(ov.emptiest).not.toContainEqual({ topic: '그리디', level: 2 });
    expect(await data(await call(app, 'list_problems', { topic: '그리디' }))).toMatchObject([{ id: saved.id, source: 'agent:codex' }]);
    expect(await data(await call(app, 'get_problem', { id: saved.id }))).toMatchObject({ title: '두 수의 합', cases: [{ id: 'e1' }] });
    expect(await data(await call(app, 'set_status', { id: saved.id, status: 'draft' }))).toEqual({ updated: true });
    const updated = await data<{ saved: boolean }>(await call(app, 'update_problem', { id: saved.id, problem: problemInput({ title: '고친 제목', topic: '그리디', level: 2 }) }));
    expect(updated.saved).toBe(true);
    expect(db.prepare('SELECT title FROM problems WHERE id = ?').pluck().get(saved.id)).toBe('고친 제목');
  });

  it('입력이 틀리면 이유를 돌려준다', async () => {
    const app = build();
    const res = await call(app, 'create_problem', { topic: '없는 유형' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('topic');
  });

  it('MCP 서버는 공용 도구 목록을 내보내고 호출을 서명해 넘긴다', async () => {
    const app = build({}, sender, Date.now()); // MCP 서버는 현재 시각으로 서명한다
    const caller = workerCaller({ origin: ORIGIN, secret: JUDGE_SECRET, agent: 'claude', fetch: ((url: string, init: RequestInit) => app.request(new URL(url).pathname, init)) as typeof fetch });
    const init = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, caller)) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, caller)).toBeNull();
    const list = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, caller)) as { result: { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] } };
    const create = list.result.tools.find((t) => t.name === 'create_problem')!;
    expect(Object.keys(create.inputSchema.properties!)).toContain('referenceSolution');
    const res = (await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_problem', arguments: problemInput() } }, caller)) as { result: { isError: boolean; content: { text: string }[] } };
    expect(res.result.isError).toBe(false);
    expect(JSON.parse(res.result.content[0]!.text)).toMatchObject({ saved: true });
    expect(db.prepare('SELECT source FROM daily_bank').pluck().get()).toBe('agent:claude');
    const bad = (await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_problem', arguments: { id: 'nope' } } }, caller)) as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
  });
});

describe('발송 설정과 Resend', () => {
  it('키와 보내는 사람이 함께 있어야 켜진다', () => {
    expect(dailyConfigFrom({ RESEND_API_KEY: 'k' })).toBeNull();
    expect(dailyConfigFrom({ RESEND_API_KEY: 'k', DAILY_FROM: 'a@b.c' })).toMatchObject({ maxSubscribers: 90 });
  });

  it('Resend 일괄 API를 호출하고 상태 코드로 재시도 여부를 나눈다', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let code = 200;
    const resend = new ResendSender('key', async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: code });
    });
    const mail = { from: 'a@b.c', to: 'd@e.f', subject: 's', html: 'h', text: 't' };
    expect(await resend.sendBatch([mail], 'k1')).toEqual(['m1']);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails/batch');
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('k1');
    code = 429;
    await expect(resend.sendBatch([mail], 'k2')).rejects.toMatchObject({ retryable: true });
    code = 422;
    await expect(resend.sendBatch([mail], 'k3')).rejects.toMatchObject({ retryable: false });
  });
});

describe('로그인 사용자의 구독·인박스', () => {
  const TEST_TOKEN = 't'.repeat(24);
  const MAIL_ON = { subscribed: true, mail: true, weekdays: [1, 2, 3, 4, 5] };
  const buildUser = (env: Record<string, string> = {}, now = NOW) => build({ TEST_AUTH_TOKEN: TEST_TOKEN, ...env }, sender, now);

  async function login(app: App, email: string) {
    const res = await app.request('/api/test/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-auth': TEST_TOKEN }, body: JSON.stringify({ email }) });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie')!.split(';')[0]!;
  }
  const me = (cookie: string, method = 'GET', body?: unknown) => ({ method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const put = (app: App, cookie: string, body: unknown) => app.request('/api/me/daily/settings', me(cookie, 'PUT', body));
  const settings = async (app: App, cookie: string) => data(await app.request('/api/me/daily/settings', me(cookie)));
  type Inbox = { items: { date: string; problemId: string; read: boolean; progress: string; topic: string }[]; unread: number };
  const inbox = async (app: App, cookie: string) => data<Inbox>(await app.request('/api/me/daily/inbox', me(cookie)));
  const userId = (email: string) => db.prepare('SELECT id FROM users WHERE email = ?').pluck().get(email) as string;

  it('비회원은 인박스와 수신 설정을 쓸 수 없다', async () => {
    const app = buildUser();
    expect((await app.request('/api/me/daily/inbox')).status).toBe(401);
    expect((await app.request('/api/me/daily/settings')).status).toBe(401);
  });

  it('처음 구독하면 확인 메일 없이 그날 문제를 바로 보내고, 아침 발송과 겹쳐 두 번 보내지 않는다', async () => {
    const app = buildUser({}, NOW - 5 * 3_600_000); // 02:00 KST
    await addProblem(app);
    const cookie = await login(app, 'user@company.example');
    expect((await put(app, cookie, MAIL_ON)).status).toBe(200);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe('user@company.example');
    expect(sender.sent[0]!.html).toContain(`${ORIGIN}/#/inbox`);
    expect(await settings(app, cookie)).toMatchObject({ email: 'user@company.example', subscribed: true, mail: true });
    expect((await inbox(app, cookie)).items.map((i) => i.date)).toEqual([DATE]);
    expect((await tick()).outcome).toBe('finished');
    expect(sender.sent).toHaveLength(1);
  });

  it('다시 구독할 때는 바로 보내지 않는다', async () => {
    const app = buildUser();
    await addProblem(app);
    await addProblem(app, { title: '둘째' });
    const cookie = await login(app, 'a@example.com');
    await put(app, cookie, MAIL_ON);
    await put(app, cookie, { ...MAIL_ON, subscribed: false });
    await put(app, cookie, MAIL_ON);
    expect(sender.sent).toHaveLength(1);
    expect(status('a@example.com')).toBe('active');
  });

  it('메일을 꺼도 인박스는 받는다. 평일 07시가 지나면 그날 문제가 생기고 읽음과 풀이 결과를 보여 준다', async () => {
    const day1 = buildUser();
    await addProblem(day1);
    await addProblem(day1, { title: '둘째', topic: '그리디' });
    const cookie = await login(day1, 'a@example.com');
    await put(day1, cookie, { ...MAIL_ON, mail: false });
    expect(sender.sent).toHaveLength(0);
    const first = await inbox(day1, cookie);
    expect(first).toMatchObject({ unread: 1, items: [{ date: DATE, progress: 'none' }] });

    await day1.request(`/api/me/daily/inbox/${DATE}/read`, me(cookie, 'POST'));
    db.prepare("INSERT INTO submissions (id, problem_id, kind, language, mode, code, case_ids, priority, status, score, created_at, user_id) VALUES ('s1', ?, 'submit', 'python', 'function', '', '[]', 0, 'done', 100, 'now', ?)").run(first.items[0]!.problemId, userId('a@example.com'));
    const day2 = buildUser({}, NOW + DAY - 3_600_000); // 다음 날 06:00: 아직 안 열림
    expect((await inbox(day2, cookie)).items).toHaveLength(1);
    const day2open = buildUser({}, NOW + DAY);
    const after = await inbox(day2open, cookie);
    expect(after.items.map((i) => i.date)).toEqual(['2026-11-04', DATE]);
    expect(after.items[1]).toMatchObject({ read: true, progress: 'solved' });
    expect(after.items[0]!.problemId).not.toBe(after.items[1]!.problemId);
    expect(after.unread).toBe(1);
  });

  it('임시 계정은 인박스로만 구독하고 메일은 켤 수 없다', async () => {
    const app = buildUser();
    await addProblem(app);
    const res = await app.request('/api/auth/temporary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    expect(await settings(app, cookie)).toMatchObject({ temporary: true, mail: false });
    const mailOn = await put(app, cookie, MAIL_ON);
    expect(mailOn.status).toBe(403);
    expect(((await mailOn.json()) as { error: { code: string } }).error.code).toBe('daily_mail_temporary');
    expect(await settings(app, cookie)).toMatchObject({ subscribed: false });
    expect((await put(app, cookie, { ...MAIL_ON, mail: false })).status).toBe(200);
    expect(await settings(app, cookie)).toMatchObject({ subscribed: true, mail: false, temporary: true });
    expect((await inbox(app, cookie)).items.map((i) => i.date)).toEqual([DATE]);
    expect(sender.sent).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) FROM daily_subscribers').pluck().get()).toBe(0);
    expect(await settings(app, await login(app, 'a@example.com'))).toMatchObject({ temporary: false });
  });

  it('공개 구독 신청에 임시 계정 주소는 받지 않는다', async () => {
    const res = await build().request('/api/public/daily/subscribe', post({ email: 'x@temporary.invalid', consent: true }));
    expect(res.status).toBe(400);
    expect(sender.sent).toHaveLength(0);
  });

  it('고른 요일에만 메일을 보낸다', async () => {
    const app = buildUser();
    await addProblem(app);
    await addProblem(app, { title: '둘째' });
    const cookie = await login(app, 'a@example.com');
    await put(app, cookie, { ...MAIL_ON, weekdays: [1] }); // 화요일 첫날은 바로 보낸다
    expect(sender.sent).toHaveLength(1);
    expect(await tick('2026-11-10', NOW + 7 * DAY)).toMatchObject({ outcome: 'finished' }); // 다음 주 화요일은 보내지 않는다
    expect(await tick('2026-11-09', NOW + 6 * DAY)).toMatchObject({ sent: 1 }); // 월요일
  });

  it('메일의 수신거부는 메일만 끄고 구독은 남긴다', async () => {
    const app = buildUser();
    await addProblem(app);
    const cookie = await login(app, 'a@example.com');
    await put(app, cookie, MAIL_ON);
    const url = /api\/public\/daily\/unsubscribe\?token=[^\s]+/.exec(sender.sent[0]!.text)![0];
    await app.request(`/${url}`, { method: 'POST' });
    expect(await settings(app, cookie)).toMatchObject({ subscribed: true, mail: false });
    expect((await inbox(app, cookie)).items).toHaveLength(1);
  });

  it('입력으로 받는 주소를 바꿀 수 없고, 로그인 전에 같은 주소로 구독했다면 그 기록에 연결한다', async () => {
    const app = buildUser();
    await subscribe(app, 'a@example.com');
    const cookie = await login(app, 'a@example.com');
    expect(await settings(app, cookie)).toMatchObject({ subscribed: false, mail: true });
    await put(app, cookie, { ...MAIL_ON, email: 'other@example.com' });
    expect(status('other@example.com')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) FROM daily_subscribers').pluck().get()).toBe(1);
    expect(db.prepare('SELECT user_id FROM daily_subscribers').pluck().get()).toBeTruthy();
  });

  it('메일 자리가 없거나 반송된 주소면 거절하지만 인박스는 켠다', async () => {
    const app = buildUser({ DAILY_MAX_SUBSCRIBERS: '1' });
    await subscribe(app, 'first@example.com');
    const cookie = await login(app, 'a@example.com');
    expect((await put(app, cookie, MAIL_ON)).status).toBe(409);
    expect(await settings(app, cookie)).toMatchObject({ subscribed: true, mail: false });

    db.prepare("UPDATE daily_subscribers SET status = 'bounced' WHERE email = 'first@example.com'").run();
    const bounced = await login(app, 'first@example.com');
    expect((await put(app, bounced, MAIL_ON)).status).toBe(409);
    expect(await settings(app, bounced)).toMatchObject({ subscribed: true, mail: false, mailBlocked: true });
  });

  it('탈퇴하면 구독·받은 문제 기록을 함께 지운다', async () => {
    const app = buildUser();
    await addProblem(app);
    const cookie = await login(app, 'a@example.com');
    await put(app, cookie, MAIL_ON);
    expect((await app.request(`/api/admin/users/${userId('a@example.com')}`, admin('DELETE'))).status).toBe(200);
    for (const table of ['daily_subscribers', 'daily_members', 'daily_picks', 'daily_deliveries']) expect(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()).toBe(0);
  });
});
